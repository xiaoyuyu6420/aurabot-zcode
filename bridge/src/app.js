// 装配：配置 → 日志 → 工作区 → SnowLuma → OneBot → hub → zcode 驱动 → 看门狗。
// 上游 host.js 的「核心半边」：面板/模块内核/联动都不搬（M2+ 按里程碑补）。
//
// ⚠ 安全默认：总开关关、试运行开。不手动打开，一句都不会真的发到 QQ。

import { writeFileSync } from 'node:fs'
import { watchFile } from 'node:fs'
import { join } from 'node:path'
import { loadConfig, saveConfig, CONFIG_FILE } from './core/config.js'
import { createLogger } from './core/logger.js'
import { dataRoot, ensureDir } from './core/store.js'
import { registerSecret } from './core/redact.js'
import { createOneBotClient } from './onebot/client.js'
import { createSnowLumaManager } from './snowluma/manager.js'
import { createHub } from './chat/hub.js'
import { createZcodeDriver, detectCjs } from './zcode.js'
import { seedPersonas, currentPersonaText, rulesText } from './persona/personas.js'
import { createDshBridge } from './core/llm.js'
import { textToSpeech } from './voice/tts.js'

/** 会话工作区的 AGENTS.md = 人格 + 规则。人格换了 / 规则变了就重写，zcode CLI 每回合都会读到。 */
export function buildWorkspace(cfg) {
  const dir = ensureDir(cfg.zcode.workspaceDir || dataRoot())
  const persona = currentPersonaText(cfg.persona.current)
  // 私聊（主人）与社交（群/陌生人）规则各写一段；CLI 会话按聊天来源区分（M2 起 agent 定义会接手细分）
  const body = `${persona}

---

${rulesText('private', cfg)}

---

（群聊或和其他人私聊时，改用下面这段边界）

${rulesText('social', cfg)}

<!-- aurabot:workspace 由桥进程生成，改人格请编辑 workspace/personas/ 里的卡片或用 aurabot.js persona -->
`
  writeFileSync(join(dir, 'AGENTS.md'), body, 'utf8')
  return dir
}

/** 后台写作会话适配器：qzone-social 的 write() 走上游 hub.runSystemTurn 契约；桥内用 zcode CLI 临时会话。 */
function biliThinkAdapter(zcode) {
  return async (name, title, prompt, { timeoutMs = 120000 } = {}) => {
    const r = await zcode.runOnceIn(dataRoot(), prompt, { timeoutMs })
    return r.text
  }
}

export async function createApp({ echo = false, watch = false } = {}) {
  const logger = createLogger({ echo })
  const log = logger.child('core')
  let cfg = loadConfig()
  const getConfig = () => cfg
  const setConfig = (next) => {
    cfg = saveConfig(next)
    secrets()
    buildWorkspace(cfg) // 人格/主人号变了，AGENTS.md 跟着变
    return cfg
  }
  const secrets = () => { for (const k of ['webuiPassword', 'httpToken', 'wsToken']) registerSecret(cfg.snowluma[k]) }
  secrets()
  seedPersonas()
  buildWorkspace(cfg)

  // 常驻模式：别的进程（aurabot on/off/dry/persona）改了配置文件就热加载，不用重启服务
  let exports_app = null // 面板等组件延迟拿到最终 app 对象
  if (watch) {
    // 单例锁兼 Web 面板：同一端口（51073），第二个 daemon 起不来（防双开导致双重回复）
    const { startWebPanel } = await import('./webpanel.js')
    await new Promise((resolve, reject) => {
      const panel = startWebPanel({ port: 51073, getApp: () => exports_app })
      panel.once('error', (e) => reject(Object.assign(new Error('aurabot-bridge 已经在运行（面板端口被占用）'), { cause: e })))
      panel.once('listening', () => {
        log.info('Web 面板：http://127.0.0.1:51073')
        resolve()
      })
    })
    watchFile(CONFIG_FILE(), { interval: 2000 }, (cur, prev) => {
      if (cur.mtimeMs === prev.mtimeMs) return
      try {
        const before = JSON.stringify(cfg)
        cfg = loadConfig()
        secrets()
        buildWorkspace(cfg)
        if (JSON.stringify(cfg) !== before) log.info(`配置已热加载（总开关 ${cfg.enabled ? '开' : '关'}，试运行 ${cfg.dryRun ? '开' : '关'}）`)
      } catch (error) {
        log.warn('热加载配置失败：', error.message)
        return
      }
      watchdogNow() // 开关切了立刻连/断，不等下一个看门狗 tick
    })
  }

  // ---------- zcode 驱动 ----------
  const zcode = createZcodeDriver({ getConfig, log: logger.child('zcode'), groupNames: () => hub?.groupNames })

  // ---------- QQ 网关 ----------
  const snowluma = createSnowLumaManager({
    getConfig,
    log: logger.child('snowluma'),
    savePassword: (pw, auto = true) => setConfig({ ...cfg, snowluma: { ...cfg.snowluma, webuiPassword: pw, passwordAuto: auto } }),
  })
  const endpoint = () => {
    const s = cfg.snowluma
    const auto = s.httpUrl && s.wsUrl ? null : snowluma.endpoint()
    return {
      httpUrl: s.httpUrl || auto?.httpUrl || '',
      wsUrl: s.wsUrl || auto?.wsUrl || '',
      httpToken: s.httpToken || auto?.httpToken || '',
      wsToken: s.wsToken || auto?.wsToken || '',
    }
  }
  let onebotState = 'stopped'
  // 连上后先核对登录的是不是机器人号，核对通过前不处理任何消息；不是就断开，不再自动重连
  let loginOk = false
  let wrongAccount = ''
  let hub = null
  async function checkLogin() {
    let uin = ''
    try {
      const info = await onebot.call('get_login_info', {}, { timeoutMs: 10000 })
      uin = String(info?.user_id ?? '')
    } catch (error) {
      logger.child('onebot').warn('核对登录的 QQ 号失败：', error.message)
    }
    if (onebotState !== 'connected') return
    if (!uin) {
      // 核对不了就别用，断开后由看门狗重试
      onebot.stop()
      return
    }
    if (await snowluma.confirmLogin(uin)) {
      loginOk = true
      wrongAccount = ''
    } else {
      wrongAccount = uin
      onebot.stop()
    }
  }
  const onebot = createOneBotClient({
    endpoint,
    log: logger.child('onebot'),
    onState: (s, d) => {
      onebotState = s
      if (s !== 'connected') loginOk = false
      else checkLogin().catch((error) => log.warn('核对登录号出错：', error.message))
      logger.child('onebot').info(`QQ 网关：${s}${d ? '（' + d + '）' : ''}`)
    },
    onEvent: (ev) => {
      // 还没核对是机器人号：什么都不处理
      if (!loginOk) return
      if (ev.post_type === 'message' || ev.post_type === 'message_sent') {
        if (ev.post_type === 'message') hub.onMessage(ev).catch((error) => log.error('处理消息出错：', error.message))
      } else if (ev.post_type === 'notice' && ev.notice_type === 'notify' && ev.sub_type === 'poke') {
        hub.onPoke(ev).catch((error) => log.error('处理戳一戳出错：', error.message))
      }
    },
  })

  hub = createHub({
    zcode,
    getConfig,
    log: logger.child('chat'),
    onebot,
    // M4 模块：语音条（关着时自动退回发文字）
    tts: {
      speak: (text) => {
        const v = cfg.voice || {}
        if (v.enabled === false) throw new Error('语音关着')
        return textToSpeech(text, v, logger.child('voice'))
      },
    },
    // M3 模块：表情 / 心情 / 记忆（关着时行为自动退回纯文本）
    stickers: {
      match: (q) => app.stickersModule?.match?.(q) ?? null,
      segmentFor: (it) => app.stickersModule?.segmentFor?.(it) ?? null,
      markUsed: (md5) => app.stickersModule?.markUsed?.(md5),
      pickForReply: (t) => app.stickersModule?.pickForReply?.(t) ?? null,
      collect: async (s, chatId) => (app.stickersModule?.collect ? stickersModule.collect(s, chatId) : { ok: false, reason: '表情包模块关着' }),
      library: () => app.stickersModule?.library?.() ?? { items: [] },
    },
    moodEffects: () => app.moodModule?.effects?.() ?? null,
    onActivity: (a) => {
      // 心情观察 / 模型判心情（上游同款接线）
      try {
        if (a.kind === 'in' && a.text) app.moodModule?.observe?.(a.text, a.nickname, { direct: a.direct, owner: a.owner })
        const c = cfg
        if (a.kind === 'out' && a.reply && !String(a.chatId).startsWith('system:')) {
          const who = String(a.chatId).startsWith('group:') ? '群里的人' : String(a.chatId) === `private:${c.ownerQQ}` ? c.ownerName || '主人' : '对方'
          app.moodModule?.judge?.({ userText: a.userText, reply: a.reply, who }).catch(() => {})
        }
      } catch (error) {}
    },
    memoryScore: (text) => { try { return app.memoryModule?.topicScore?.(text) ?? 0 } catch (error) { return 0 } },
    // M3：每轮注入心情 + 记忆（CLI 驱动下用提示词前缀，等价于上游的 systemPrompt.context）
    contextInject: async ({ chatId, text }) => {
      const parts = []
      try {
        const moodLine = app.moodModule?.contextLine?.()
        if (moodLine) parts.push(moodLine)
      } catch (error) {}
      try {
        if (app.memoryModule?.contextFor) {
          const kind = chatId.startsWith('group:') ? 'group' : 'private'
          const userId = kind === 'group' ? '' : chatId.slice(8)
          const groupId = kind === 'group' ? chatId.slice(6) : ''
          const ctx = app.memoryModule.contextFor(
            { kind, chatId, userId, groupId },
            chatId,
            // 桥内扩展：把本轮消息文本直接给 contextFor（上游从 hub.lastTextOf 拿）
            { lastText: text, speakers: [] },
          )
          if (ctx) parts.push(ctx)
        }
      } catch (error) {}
      return parts.join('\n')
    },
  })

  // ---------- M3/M4/M5 模块实例 ----------
  const dshBridge = createDshBridge()
  let stickersModuleRef = null
  let moodModuleRef = null
  let memoryModuleRef = null
  let speakupModuleRef = null
  let biliModuleRef = null
  let qzoneSocialModuleRef = null
  let diaryModuleRef = null
  let groupAdminRef = null
  let imageGenRef = null
  {
    const slog = logger.child('stickers')
    const { createStickerStore } = await import('./features/stickers.js')
    stickersModuleRef = createStickerStore({ dsh: dshBridge, getConfig, onebot, log: slog })
    log.info('表情包模块已加载')
  }
  {
    const { createMood } = await import('./features/companion.js')
    moodModuleRef = createMood({ getConfig, dsh: dshBridge })
    log.info('心情模块已加载')
  }
  {
    const { createMemoryStore } = await import('./features/memory.js')
    memoryModuleRef = createMemoryStore({
      dsh: dshBridge, getConfig,
      hub: {
        // 上游 memory 依赖 hub 的这些能力：桥内全部代理到现有实现
        chatLogOf: (day) => hub.chatLogOf ? hub.chatLogOf(day) : [],
        chatLogDays: () => hub.chatLogDays ? hub.chatLogDays() : [],
        deleteChatLog: (day) => hub.deleteChatLog ? hub.deleteChatLog(day) : false,
        recentMedia: (chatId, userId) => hub.recentMedia(chatId, userId),
        turnHasOwner: (chatId) => hub.turnHasOwner(chatId),
        speakersOf: () => [],
        lastTextOf: () => '',
        prevTextOf: () => '',
        sessions: () => hub.sessions(),
      },
      log: logger.child('memory'),
    })
    log.info('记忆模块已加载')
  }
  {
    // M4：主动搭话（主人一阵子没理她时，在私聊里主动找主人说几句）
    const { createSpeakUp } = await import('./features/companion.js')
    speakupModuleRef = createSpeakUp({ getConfig, hub, log: logger.child('speakup'), isMuted: () => false })
    log.info('主动搭话模块已加载')
  }
  {
    // M5：B 站（看视频 / 定时刷 / 评论 / 分享）。后台思考走 zcode CLI 临时会话。
    const { createBiliModule } = await import('./bili/index.js')
    biliModuleRef = createBiliModule({ getConfig, hub, memory: memoryModuleRef, log: logger.child('bili'), zcode })
    log.info('B 站模块已加载')
  }
  {
    // M5：QQ 空间互动（回评论 / 逛好友动态）。后台评论走 zcode CLI 临时会话。
    const { createQzoneSocial } = await import('./features/qzone-social.js')
    qzoneSocialModuleRef = createQzoneSocial({ getConfig, onebot, hub: { ...hub, runSystemTurn: biliThinkAdapter(zcode) }, log: logger.child('qzone'), memory: memoryModuleRef })
    log.info('空间互动模块已加载')
  }
  {
    // M6 收尾：群管（禁言/踢人/头衔/公告，主人开口才做）+ 生图
    const { createGroupAdmin } = await import('./features/group-admin.js')
    groupAdminRef = createGroupAdmin({ getConfig, onebot, hub, log: logger.child('group-admin') })
    const { createImageGen } = await import('./features/imagegen.js')
    imageGenRef = createImageGen({ getConfig, log: logger.child('imagegen') })
    log.info('群管与生图模块已加载')
  }
  {
    // M6 收尾：空间日记（每天自动写说说；qzone.js 原样搬入，runSystemTurn 走 zcode 临时会话）
    const { createQzone } = await import('./features/qzone.js')
    diaryModuleRef = createQzone({
      getConfig, onebot, hub: { ...hub, runSystemTurn: biliThinkAdapter(zcode) }, log: logger.child('diary'),
      onDiary: (text) => { try { app.memoryModule?.add?.({ text: `我在 QQ 空间写过：${text}`, importance: 0.55, tags: ['空间日记'], source: 'diary' }) } catch (error) {} },
    })
    log.info('空间日记模块已加载')
  }

  // ---------- 启动 / 看门狗 ----------
  let watchdogTimer = null
  async function watchdog() {
    if (!cfg.enabled) {
      if (onebot.state !== 'stopped') onebot.stop()
      return
    }
    const inst = snowluma.detect()
    if (inst.installed && cfg.snowluma.autoStart && !(await snowluma.running())) {
      const r = await snowluma.start()
      log.info('SnowLuma：', r.message)
    }
    // 上次连上的不是机器人号：等主人手动处理或改设置再连
    if (wrongAccount) return
    if (onebot.state === 'stopped') onebot.start()
    if (cfg.snowluma.autoAttach && cfg.snowluma.webuiPassword && onebotState !== 'connected' && (await snowluma.running())) {
      const last = snowluma.lastAttach
      if (Date.now() - last.at > 60_000) {
        const r = await snowluma.attachBot()
        log.info('接入机器人号：', r.message)
      }
    }
    // M3：记忆的定时整理（每天 consolidateTimes 把流水提炼进长期记忆）
    if (app.memoryModule?.tick) {
      try {
        const r = await app.memoryModule.tick()
        if (r && r.ok && r.message) log.info('记忆整理：', r.message)
      } catch (error) {
        log.debug('记忆整理失败：', error.message)
      }
    }
    // M4：主动搭话的定时评估（每次看门狗醒时评一次，内部自己判断到没到点）
    if (app.speakupModule?.tick) {
      try { await app.speakupModule.tick() } catch (error) {
        log.debug('主动搭话评估失败：', error.message)
      }
    }
    // M5：B 站 + 空间互动的定时评估（内部按 intervalHours / intervalMin 自己限频）
    if (app.biliModule?.tick) {
      try { await app.biliModule.tick() } catch (error) {
        log.debug('刷 B 站出错：', error.message)
      }
    }
    if (app.qzoneSocialModule?.tick) {
      try { await app.qzoneSocialModule.tick() } catch (error) {
        log.debug('逛空间出错：', error.message)
      }
    }
    // M6 收尾：空间日记的定时写作（内部按 planDiaryTimes 自己排时）
    if (app.diaryModule?.tick) {
      try { await app.diaryModule.tick() } catch (error) {
        log.debug('空间日记出错：', error.message)
      }
    }
  }
  const safe = (fn, label) => () => { Promise.resolve().then(fn).catch((error) => log.warn(`${label}出错：`, error.message)) }
  const watchdogNow = safe(watchdog, '看门狗')

  async function status() {
    const inst = snowluma.detect()
    const running = inst.installed ? await snowluma.running() : false
    const ping = await zcode.ping().catch(() => ({ ok: false }))
    return {
      version: '0.1.0',
      enabled: cfg.enabled,
      dryRun: cfg.dryRun,
      setupDone: cfg.setupDone,
      botQQ: cfg.botQQ || '（没填）',
      ownerQQ: cfg.ownerQQ || '（没填）',
      onebot: onebotState,
      loginOk,
      wrongAccount,
      snowluma: { installed: inst.installed, reason: inst.reason || '', version: inst.version || '', running },
      zcode: { cjs: ping.cjs || detectCjs(cfg.zcode.cjsPath) || '（没找到）', ok: ping.ok, version: ping.version || '' },
      workspace: zcode.workspaceDir(),
      sessions: Object.keys(zcode.sessions()).length,
      cliRunning: zcode.running,
      stats: hub.stats(),
      lastChatAt: hub.lastChatAt,
    }
  }

  const app = {
    logger, log, getConfig, setConfig,
    // M3/M4/M5/M6 模块实例（面板与 webpanel 用）
    stickersModule: null, moodModule: null, memoryModule: null, speakupModule: null, biliModule: null, qzoneSocialModule: null, diaryModule: null, groupAdmin: null, imageGen: null,
    /** 只改内存里的配置（不落盘）：sim 这类本地测试用它临时放行，不碰真实的总开关。 */
    patchConfigLive(patch) {
      cfg = { ...cfg, ...patch(cfg) }
    },
    onebot, snowluma, hub, zcode,
    /** 登录号核对状态（面板用）。loginOk 是闭包变量，用 getter 暴露。 */
    get loginOk() { return loginOk },
    get onebotState() { return onebotState },
    /** 面板「重连/接入」前清掉连错号标记（上游同款语义）。 */
    wrongAccountReset() { wrongAccount = '' },
    status,
    buildWorkspace,
    startWatchdog() {
      if (watchdogTimer) return
      // interval 必须是 ref 的：常驻模式下就是它（以及 OneBot WS 连接）撑住事件循环
      watchdogTimer = setInterval(safe(watchdog, '看门狗'), 30_000)
      setTimeout(safe(watchdog, '看门狗'), 1000)
    },
    stop() {
      if (watchdogTimer) clearInterval(watchdogTimer)
      watchdogTimer = null
      hub.stop()
      onebot.stop()
      snowluma.dispose()
    },
  }
  app.stickersModule = stickersModuleRef
  app.moodModule = moodModuleRef
  app.memoryModule = memoryModuleRef
  app.speakupModule = speakupModuleRef
  app.biliModule = biliModuleRef
  app.qzoneSocialModule = qzoneSocialModuleRef
  app.diaryModule = diaryModuleRef
  app.groupAdmin = groupAdminRef
  app.imageGen = imageGenRef
  exports_app = app
  return app
}
