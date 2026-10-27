// 桥进程自带的 Web 面板（DSH 面板的复刻）：HTTP + JSON API + 单页 UI。
// 端口 51073 也被单例锁占用——面板与锁共用监听：锁升级为真正的 HTTP server。
// 零依赖，node:http。所有路由只读内存/配置文件，写操作走 setConfig（热加载生效）。

import { createServer } from 'node:http'
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redact } from './core/redact.js'
import { dataRoot } from './core/store.js'
import { edgeInstalled, installEdge, textToSpeech } from './voice/tts.js'
import { runOpenAction, checkToken, openToken } from './open.js'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'aurabot')
const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM_ROOT = join(BRIDGE_ROOT, '..', 'dsh-aurabot-qq')
const VERSION = '0.1.0'
import { stickerPath as stickerFeaturePath } from './features/stickers.js'

function readJsonSafe(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (error) { return fallback }
}

function listPersonas(workspaceDir) {
  const dir = join(workspaceDir, 'personas')
  const out = []
  try {
    for (const n of readdirSync(dir)) {
      if (!n.endsWith('.md')) continue
      const raw = readFileSync(join(dir, n), 'utf8')
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      out.push({ id: n.slice(0, -3), name: (m ? m[1].match(/^name:\s*(.+)$/m)?.[1] : '') || n, chars: raw.length })
    }
  } catch (error) {}
  return out
}

function readSessions(workspaceDir) {
  return readJsonSafe(join(workspaceDir, 'sessions.json'), { chats: {} }).chats || {}
}

function tailLogs(workspaceDir, lines = 60) {
  const dir = join(workspaceDir, 'logs')
  const out = []
  try {
    const files = readdirSync(dir).filter((f) => /^aurabot-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().slice(-2)
    for (const f of files) out.push(...readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
  } catch (error) {}
  return out.slice(-Math.max(1, Math.min(400, lines)))
}

function gatewayStateFromLog(workspaceDir) {
  const lines = tailLogs(workspaceDir, 120).filter((l) => l.includes('网关'))
  const last = lines[lines.length - 1] || ''
  if (last.includes('connected')) return 'connected'
  if (last.includes('connecting')) return 'connecting'
  if (last.includes('disconnected')) return 'disconnected'
  if (last.includes('stopped')) return 'stopped'
  return 'unknown'
}

const SECRET_PATHS = [['snowluma', 'webuiPassword'], ['snowluma', 'httpToken'], ['snowluma', 'wsToken']]
function stripSecrets(cfg) {
  const c = structuredClone(cfg)
  for (const [g, k] of SECRET_PATHS) if (c?.[g]) c[g][k] = c[g][k] ? '(已设置)' : ''
  return c
}

// 面板可写的字段白名单（与 ZCode 插件同款）
const WRITABLE = {
  plain: ['enabled', 'dryRun', 'botQQ', 'ownerQQ', 'ownerName', 'ownerLevel'],
  nested: {
    persona: ['current'],
    allow: ['private', 'groups'],
    merge: ['enabled', 'waitSec', 'maxSec', 'groupWaitSec', 'groupMaxSec'],
    zcode: ['cjsPath', 'nodePath', 'workspaceDir', 'timeoutMs', 'maxParallel', 'mode', 'disallowedTools', 'maxContextTurns'],
    group: ['wakeWords', 'interjectChance', 'cooldownSec', 'maxPerHour', 'quietHours', 'minRelevance', 'interests', 'burstMax', 'burstWindowSec'],
    snowluma: ['dir', 'autoStart', 'webuiPort', 'httpUrl', 'wsUrl'],
  },
}

function pickWritable(patch) {
  const out = {}
  const touched = []
  for (const k of WRITABLE.plain) if (patch[k] !== undefined) { out[k] = patch[k]; touched.push(k) }
  for (const [group, keys] of Object.entries(WRITABLE.nested)) {
    if (patch[group] && typeof patch[group] === 'object') {
      const sub = {}
      for (const k of keys) if (patch[group][k] !== undefined) sub[k] = patch[group][k]
      if (Object.keys(sub).length) { out[group] = sub; touched.push(`${group}.${Object.keys(sub).join(',')}`) }
    }
  }
  return { out, touched }
}

// ---------- DSH 原版面板的 API 兼容层 ----------

const SECRET_PATHS_DSH = [['snowluma', 'webuiPassword'], ['snowluma', 'httpToken'], ['snowluma', 'wsToken']]

function publicConfigDSH(cfg) {
  const c = structuredClone(cfg)
  const cleanDeep = (o) => { for (const k of Object.keys(o)) { if (k.endsWith('Set') || k.endsWith('Hint')) delete o[k]; else if (o[k] && typeof o[k] === 'object') cleanDeep(o[k]) } }
  cleanDeep(c)
  for (const [g, k] of SECRET_PATHS_DSH) if (c?.[g]) { c[g][`${k}Set`] = Boolean(c[g][k]); c[g][k] = '' }
  return c
}

function mergeDraft(current, draft) {
  const deep = (base, over) => {
    for (const [k, v] of Object.entries(over || {})) {
      if (k.endsWith('Set') || k.endsWith('Hint')) continue
      if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) deep(base[k], v)
      else if (Array.isArray(v) || typeof v !== 'object' || v === null) {
        // 密钥字段：空串 = 没改，保留旧值
        const isSecret = SECRET_PATHS_DSH.some(([g, sk]) => k === sk)
        if (isSecret && (v === '' || v === '(已设置)')) continue
        base[k] = v
      }
    }
    return base
  }
  const next = structuredClone(current)
  deep(next, draft)
  return next
}

function readBodyJson(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 5e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch (error) { resolve({}) } })
  })
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

function makeDshApi(getApp) {
  const appRef = () => getApp() || {}
  const cfg = () => appRef().getConfig()
  const ws = () => cfg().zcode.workspaceDir || dataRoot()
  const voiceEdgeInstalled = () => { try { return edgeInstalled() } catch (error) { return false } }

  async function overview() {
    const c = cfg()
    const inst = appRef().snowluma.detect()
    const running = inst.installed ? await appRef().snowluma.running() : false
    let login = null
    if (appRef().onebotState === 'connected') {
      try {
        const info = await appRef().onebot.call('get_login_info', {}, { timeoutMs: 5000 })
        login = { uin: String(info?.user_id ?? ''), nickname: info?.nickname || '' }
      } catch (error) {}
    }
    return {
      ok: true,
      version: VERSION,
      apiVersion: 1,
      config: publicConfigDSH(c),
      onebot: {
        state: appRef().onebotState,
        login,
        endpoint: { httpUrl: c.snowluma.httpUrl, wsUrl: c.snowluma.wsUrl },
        problem: appRef().onebotState === 'connected' && appRef().loginOk ? '' : (c.enabled ? (appRef().onebotState !== 'connected' ? '正在连接 SnowLuma 的 OneBot 网关…' : '登录号核对中…') : '总开关关着（右上角），打开后才会连'),
      },
      snowluma: {
        ...inst, running,
        consented: !(await appRef().snowluma.agreements().catch(() => ({ consentRequired: true }))).consentRequired,
        owns: appRef().snowluma.ownsProcess,
        lastAttach: appRef().snowluma.lastAttach,
        downloadPage: 'https://github.com/SnowLuma/SnowLuma/releases/latest',
        webui: `http://127.0.0.1:${c.snowluma.webuiPort}/`,
      },
      stats: appRef().hub.stats(),
      mood: appRef().moodModule?.state?.() ?? { value: 0, label: '心情模块没加载', reason: '', history: [] },
      stickers: { count: (appRef().stickersModule?.library?.().items || []).length },
      diary: { next: 0, last: null },
      qzoneSocial: null,
      speakUp: appRef().speakupModule?.state?.() ?? { count: 0 },
      memory: { lastConsolidate: appRef().memoryModule?.lastConsolidate?.() ?? 0 },
      avatar: (() => { try { return { custom: true, at: statSync(join(UPSTREAM_ROOT, 'assets', 'dafeiyu.jpg')).mtimeMs } } catch (error) { return { custom: false, at: 0 } } })(),
      voice: { edgeInstalled: voiceEdgeInstalled() },
      song: null,
      sessions: appRef().hub.sessions(),
      workspaceDir: ws(),
      personas: listPersonas(ws()),
      modules: [],
      bridge: { dshTools: false, http: false, hasToken: false, tools: [], toolsService: false },
    }
  }

  return async function dshApi(req, res, sub, send, json) {
    const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams)
    const body = ['POST', 'PUT'].includes(req.method) ? await readBodyJson(req) : {}

    // 状态与设置
    if (sub === '/state') return json(200, await overview())
    if (sub === '/save') {
      const before = cfg()
      const incoming = structuredClone(body || {})
      const newPw = typeof incoming?.snowluma?.webuiPassword === 'string' ? incoming.snowluma.webuiPassword : ''
      if (incoming?.snowluma) delete incoming.snowluma.webuiPassword
      appRef().setConfig(mergeDraft(before, incoming))
      let pw = null
      if (newPw && newPw !== before.snowluma.webuiPassword) pw = await appRef().snowluma.setPassword(newPw)
      const changedConn = ['httpUrl', 'wsUrl', 'httpToken', 'wsToken', 'dir'].some((k) => before.snowluma[k] !== cfg().snowluma[k])
      if (changedConn || before.botQQ !== cfg().botQQ) appRef().wrongAccountReset()
      if (changedConn && appRef().onebot.state !== 'stopped') appRef().onebot.restart()
      const ov = await overview()
      if (pw && !pw.ok) return json(200, { ...ov, ok: false, message: '其他设置保存了，但控制台密码没改：' + pw.message })
      return json(200, { ...ov, message: '保存好了' + (pw ? '，' + pw.message : '') })
    }
    if (sub === '/setup/done') {
      if (!cfg().botQQ || !cfg().ownerQQ) return json(200, { ok: false, message: '先填好机器人 QQ 和你的 QQ' })
      appRef().setConfig({ ...cfg(), setupDone: true })
      return json(200, { ...(await overview()), message: '设置完成，大肥鱼可以上线啦' })
    }
    if (sub === '/logs') {
      return json(200, { ok: true, entries: appRef().logger.recent(Number(q.limit) || 300, { level: q.level || '', area: q.area || '' }) })
    }

    // SnowLuma
    if (sub === '/snowluma/start') return json(200, await appRef().snowluma.start())
    if (sub === '/snowluma/stop') return json(200, appRef().snowluma.stop())
    if (sub === '/snowluma/attach') { appRef().wrongAccountReset(); const r = await appRef().snowluma.attachBot(); return json(200, r) }
    if (sub === '/snowluma/processes') {
      try { return json(200, { ok: true, list: await appRef().snowluma.processes() }) } catch (error) { return json(200, { ok: false, message: error.message, list: [] }) }
    }
    if (sub === '/snowluma/login-check') return json(200, { ...(await appRef().snowluma.canLogin()), passwordAuto: cfg().snowluma.passwordAuto, running: await appRef().snowluma.running() })
    if (sub === '/snowluma/agreements') {
      try { return json(200, { ok: true, ...(await appRef().snowluma.agreements()) }) } catch (error) { return json(200, { ok: false, message: error.message }) }
    }
    if (sub === '/snowluma/consent') return json(200, appRef().snowluma.consent(body.version))
    if (sub === '/snowluma/reset-password') return json(200, await appRef().snowluma.resetPassword())
    if (sub === '/snowluma/password') return json(200, { ok: true, password: appRef().snowluma.password(), auto: cfg().snowluma.passwordAuto })
    if (sub === '/snowluma/set-password') return json(200, await appRef().snowluma.setPassword(String(body.password || '')))

    // OneBot / 发送测试
    if (sub === '/onebot/reconnect') {
      if (!cfg().enabled) return json(200, { ok: false, message: '总开关关着（右上角），打开后才会连' })
      appRef().wrongAccountReset()
      appRef().onebot.restart()
      for (let i = 0; i < 16 && !(appRef().onebotState === 'connected' && appRef().loginOk); i++) await sleepMs(500)
      if (appRef().onebotState === 'connected' && appRef().loginOk) return json(200, { ok: true, message: '连上了' })
      return json(200, { ok: false, message: '没连上：等下看日志（connectionProblem 简化版）' })
    }
    if (sub === '/onebot/test') {
      try {
        const info = await appRef().onebot.call('get_login_info', {}, { timeoutMs: 8000 })
        const uin = String(info?.user_id ?? '')
        return json(200, { ok: uin === cfg().botQQ, message: uin === cfg().botQQ ? `连上了：${info.nickname}（${uin}）` : `连上的是 ${uin}，不是机器人号 ${cfg().botQQ}！`, info })
      } catch (error) { return json(200, { ok: false, message: error.message }) }
    }
    if (sub === '/test-send') {
      if (!cfg().enabled) return json(200, { ok: false, message: '先打开总开关' })
      if (cfg().dryRun) return json(200, { ok: false, message: '现在是试运行，先关掉试运行再测' })
      const r = await appRef().hub.sendText(`private:${cfg().ownerQQ}`, '【Aurabot 自测】大肥鱼到此一游～')
      return json(200, r ? { ok: true, message: '发给主人了，去 QQ 看看' } : { ok: false, message: '没发出去（看日志）' })
    }
    if (sub === '/sessions/reset') {
      const n = appRef().hub.resetSessions()
      return json(200, { ok: true, message: n ? `重置了 ${n} 个会话，下一条消息起她会重新开始` : '本来就没有会话' })
    }

    // 人格
    if (sub === '/personas') return json(200, { ok: true, list: listPersonas(ws()), current: cfg().persona.current })
    if (sub === '/persona/get') {
      const { readPersona } = await import('./persona/personas.js')
      const p = readPersona(q.id)
      return json(200, p ? { ok: true, persona: p } : { ok: false, message: '没有这个人格' })
    }
    if (sub === '/persona/save') {
      const { savePersona } = await import('./persona/personas.js')
      const p = savePersona(body.id, body)
      return json(200, { ok: true, persona: p, message: '人格已保存，下一轮起生效' })
    }
    if (sub === '/persona/delete') {
      const { deletePersona } = await import('./persona/personas.js')
      if (body.id === cfg().persona.current) return json(200, { ok: false, message: '正在用的人格不能删' })
      deletePersona(body.id)
      return json(200, { ok: true, list: listPersonas(ws()) })
    }
    if (sub === '/persona/use') {
      appRef().setConfig({ ...cfg(), persona: { current: body.id } })
      return json(200, { ...(await overview()), message: '人格换好了，下一轮起生效' })
    }

    // 未移植模块：给面板能吃的空壳
    if (sub === '/commands') return json(200, { ok: true, list: [
      { cmd: '/silent', desc: '让她闭嘴（对当前会话）' }, { cmd: '/active', desc: '让她恢复说话' }, { cmd: '/reset', desc: '重新开始这个会话' },
    ] })
    if (sub === '/models') return json(200, { ok: true, list: [] })
    if (sub === '/model/ping') return json(200, { ok: true, message: '模型由 ZCode CLI 管理，无需测试' })
    if (sub === '/changelog') return json(200, { ok: true, version: VERSION, notes: '适配版以本仓库为准；上游更新请看 dsh-aurabot-qq 的 Releases。' })
    if (sub === '/update/check') return json(200, { ok: true, update: false, message: '适配版以本仓库为准' })
    if (sub === '/groups/roles') return json(200, { ok: true, roles: {} })
    if (sub === '/insights') {
      const mem = appRef().memoryModule
      const items = mem?.insights ? mem.insights().map((x) => ({ ...x, text: redact(x.text) })) : []
      return json(200, { ok: true, items, styles: mem?.styles?.() || {} })
    }
    if (sub === '/diary/history') return json(200, { ok: true, items: [], next: 0 })
    if (sub === '/local/status') return json(200, { ok: true, dir: join(ws(), 'local'), list: [] })
    if (sub === '/modules') return json(200, { ok: true, dir: join(ws(), 'modules'), safeMode: false, apiVersion: 1, list: [], prompt: '' })
    if (sub === '/stickers') {
      const items = (appRef().stickersModule?.library?.().items || []).slice().reverse()
      return json(200, { ok: true, items })
    }
    if (sub === '/sticker/image') {
      const it = (appRef().stickersModule?.library?.().items || []).find((i) => i.md5 === q.md5)
      const stickerPath = stickerFeaturePath
      if (!it || !stickerPath || !existsSync(stickerPath(it))) return send(404, '')
      const buf = readFileSync(stickerPath(it))
      return send(200, buf, it.file.endsWith('.png') ? 'image/png' : it.file.endsWith('.gif') ? 'image/gif' : it.file.endsWith('.webp') ? 'image/webp' : 'image/jpeg')
    }
    if (sub === '/sticker/rename') {
      const st = appRef().stickersModule
      return json(200, st?.rename ? st.rename(body.md5, body.name, Array.isArray(body.tags) ? body.tags : undefined) : { ok: false, message: '表情模块没加载' })
    }
    if (sub === '/sticker/delete') {
      const st = appRef().stickersModule
      return json(200, st?.remove ? st.remove(body.md5, { fromQQ: body.fromQQ !== false }) : { ok: false, message: '表情模块没加载' })
    }
    if (sub === '/sticker/import-qq') {
      const st = appRef().stickersModule
      return json(200, st?.importFromQQ ? st.importFromQQ() : { ok: false, message: '表情模块没加载' })
    }
    if (sub === '/sticker/upload') {
      const st = appRef().stickersModule
      if (!st?.addFromBuffer) return json(200, { ok: false, message: '表情模块没加载' })
      const buf = Buffer.from(String(body.data || '').replace(/^data:[^,]+,/, ''), 'base64')
      if (!buf.length || buf.length > 5 * 1024 * 1024) return json(200, { ok: false, message: '图片太大或是空的' })
      return json(200, st.addFromBuffer(buf, { name: body.name || '', tags: body.tags || [], from: 'panel' }))
    }
    if (sub === '/memories') {
      const mem = appRef().memoryModule
      const list = mem?.search ? mem.search(String(q.q || '')) : []
      return json(200, { ok: true, items: list.map((x) => ({ ...x.it, text: redact(x.it.text) })), total: list.length })
    }
    if (sub === '/memory/recalls') return json(200, { ok: true, items: [] })
    if (sub === '/profiles') return json(200, { ok: true, list: [] })
    if (sub === '/bili/state' || sub === '/bili/account') return json(200, { ok: true, enabled: false })
    if (sub === '/qzone/social/state') return json(200, { ok: true, enabled: false })
    if (sub === '/song/status' || sub === '/song/account') return json(200, { ok: true, enabled: false })
    if (sub === '/song/drives') return json(200, { ok: true, drives: [] })
    // M4：语音（试听 / 装 edge-tts）与主动搭话（手动叫她来找你）
    if (sub === '/voice/test') {
      try {
        const { file, engine } = await textToSpeech(String(body.text || '你好呀，我是大肥鱼'), cfg().voice || {}, appRef().log)
        const buf = readFileSync(file)
        return json(200, { ok: true, engine, mime: file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg', data: buf.toString('base64') })
      } catch (error) {
        return json(200, { ok: false, message: '语音没合成出来：' + error.message })
      }
    }
    if (sub === '/voice/install') {
      const r = await installEdge(appRef().log)
      return json(200, { ...r, edgeInstalled: edgeInstalled() })
    }
    if (sub === '/speakup/fire') {
      const st = appRef().speakupModule
      if (!cfg().enabled) return json(200, { ok: false, message: '先打开总开关' })
      if (!st) return json(200, { ok: false, message: '主动搭话模块没加载' })
      await st.fire('手动')
      return json(200, { ok: true, message: '叫她去找你了' })
    }
    if (sub === '/voice/asr-status') return json(200, { ok: true, phase: 'off' })
    if (sub === '/ext/') return json(200, { ok: true, html: '' })
    // 其余写接口（song/*、memory/*、modules/*、style/save、qzone/*、bili/*、open/*、bridge/*）：统一提示未移植
    return json(200, { ok: false, message: '这个功能还没移植到 ZCode 适配版（里程碑 M5 会逐个搬过来）' })
  }
}

function dshHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>大肥鱼 · Aurabot 面板</title>
<style>
  html,body{margin:0;height:100%;background:#fff}
  #root{height:100%}
  /* DSH 主题变量的最小替身（面板 var() 都有兜底，这里只给字体） */
  :root{--dsh-font-family-ui:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
</style>
<script src="/vendor/react.production.min.js"><\/script>
<script src="/vendor/react-dom.production.min.js"><\/script>
</head>
<body>
<div id="root"></div>
<script>
window.__ModuleLoader__ = {
  load(def) {
    const require = (name) => {
      if (name === 'react') return window.React
      throw new Error('unknown require: ' + name)
    }
    window.__AURABOT_MODULE__ = def.factory(require)
  },
}
<\/script>
<script src="/dsh/client.js"><\/script>
<script>
(function () {
  const mod = window.__AURABOT_MODULE__
  if (!mod || !mod.AurabotPage) {
    document.getElementById('root').textContent = '面板加载失败（client.js 没找到？）'
    return
  }
  // apply(ctx)：DSH 里注入侧栏；这里没有 slots，直接整页渲染 AurabotPage
  try { mod.apply && mod.apply({ get: () => undefined }) } catch (e) {}
  const root = ReactDOM.createRoot(document.getElementById('root'))
  root.render(React.createElement(mod.AurabotPage))
})()
<\/script>
</body>
</html>`
}

export function startWebPanel({ getApp, port = 51073 }) {
  const dshApi = makeDshApi(() => getApp() || {})
  const server = createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => {
      res.statusCode = code
      res.setHeader('content-type', type)
      res.setHeader('cache-control', 'no-store')
      res.end(body)
    }
    const json = (code, obj) => send(code, JSON.stringify(obj))
    const path = (req.url || '/').split('?')[0]
    const app = getApp ? getApp() : null
    if (!app) return json(503, { error: 'app 还没就绪' })
    const cfg = () => app.getConfig()
    const ws = () => cfg().zcode.workspaceDir || dataRoot()

    async function overviewData() {
      return {
        bridgeDir: join(dirname(fileURLToPath(import.meta.url)), '..'),
        config: stripSecrets(cfg()),
        personas: listPersonas(ws()),
        sessions: readSessions(ws()),
        gateway: gatewayStateFromLog(ws()),
        onebotLive: app.onebotState,
        loginOk: app.loginOk,
        snowlumaRunning: Boolean(app.snowluma.ownsProcess) || null,
      }
    }

    try {
      if (req.method === 'GET' && path === '/panel') {
        // 同一份 UI：ZCode 插件场景用 window.zcode，Web 场景用本地 /api。面板自己探测后端。
        return send(200, readFileSync(join(PLUGIN_ROOT, 'ui', 'panel.html'), 'utf8'), 'text/html; charset=utf-8')
      }
      // Web 后端兼容层：把插件 API 形状映射到本地数据（面板 JS 里 apiCall 统一分发）
      if (req.method === 'POST' && path === '/api/tool/aurabot_overview') {
        const data = await overviewData()
        return json(200, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data })
      }
      if (req.method === 'GET' && path === '/api/tool/aurabot_log') {
        return send(200, redact(tailLogs(ws(), 80)).join('\n'), 'text/plain; charset=utf-8')
      }
      if (req.method === 'GET' && path === '/api/overview') {
        return json(200, await overviewData())
      }
      if (req.method === 'POST' && path === '/api/config') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy() })
        req.on('end', () => {
          try {
            const patch = JSON.parse(body || '{}')
            const current = cfg()
            const { out, touched } = pickWritable(patch)
            if (!Object.keys(out).length) return json(400, { error: '没有可修改的字段' })
            const next = structuredClone(current)
            for (const [k, v] of Object.entries(out)) {
              if (typeof v === 'object' && !Array.isArray(v) && next[k] && typeof next[k] === 'object') Object.assign(next[k], v)
              else next[k] = v
            }
            app.setConfig(next)
            json(200, { ok: true, changed: touched })
          } catch (error) {
            json(400, { error: error.message })
          }
        })
        return
      }
      if (req.method === 'POST' && path === '/api/reset') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy() })
        req.on('end', () => {
          const { chatId } = JSON.parse(body || '{}')
          const file = join(ws(), 'sessions.json')
          const data = readJsonSafe(file, { chats: {} })
          if (chatId) {
            const existed = Boolean(data.chats?.[chatId])
            delete data.chats?.[chatId]
            import('node:fs').then(({ writeFileSync, mkdirSync }) => {
              mkdirSync(dirname(file), { recursive: true })
              writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
              json(200, { ok: true, reset: chatId, existed })
            })
            return
          }
          const n = Object.keys(data.chats || {}).length
          import('node:fs').then(({ writeFileSync }) => {
            writeFileSync(file, JSON.stringify({ chats: {} }, null, 2), 'utf8')
            json(200, { ok: true, resetAll: true, count: n })
          })
        })
        return
      }
      if (req.method === 'GET' && path === '/api/log') {
        return send(200, redact(tailLogs(ws(), 80).join('\n')), 'text/plain; charset=utf-8')
      }
      // ================= M5 开放 HTTP 接口 =================
      if (req.method === 'GET' && path === '/api/open-token') {
        // 只在本机回环上发放 token
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) return json(403, { error: 'token 只对本机进程发放' })
        return json(200, { token: openToken() })
      }
      if (req.method === 'POST' && path === '/api/open') {
        let body = ''
        req.on('data', (c) => { body += c; if (body.length > 1e5) req.destroy() })
        req.on('end', () => {
          try {
            const { action, params, token } = JSON.parse(body || '{}')
            if (!checkToken(token)) return json(401, { ok: false, message: 'token 不对（GET /api/open-token 本机可取）' })
            runOpenAction({ hub: app.hub, onebot: app.onebot, getConfig: cfg, zcode: app.zcode, app }, String(action || ''), params || {})
              .then((r) => json(200, r))
              .catch((error) => json(200, { ok: false, message: error.message }))
          } catch (error) {
            json(400, { ok: false, message: '请求体不是 JSON：' + error.message })
          }
        })
        return
      }

      // ================= DSH 原版面板兼容层（/aurabot/api/*）=================
      if (path.startsWith('/aurabot/api/') || path === '/aurabot/api') {
        return dshApi(req, res, path.slice('/aurabot/api'.length) || '/', send, json)
      }
      // 原版面板入口（现在也是默认首页）
      if (req.method === 'GET' && (path === '/' || path === '/dsh')) {
        return send(200, dshHtml(), 'text/html; charset=utf-8')
      }
      if (req.method === 'GET' && path === '/dsh/client.js') {
        return send(200, readFileSync(join(UPSTREAM_ROOT, 'client', 'client.js'), 'utf8'), 'text/javascript; charset=utf-8')
      }
      if (req.method === 'GET' && path.startsWith('/vendor/')) {
        const f = join(BRIDGE_ROOT, 'webui', 'vendor', path.slice('/vendor/'.length).replace(/[\\/]/g, '__'))
        if (!existsSync(f)) return json(404, { error: 'not found' })
        return send(200, readFileSync(f), path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream')
      }
      if (req.method === 'GET' && path === '/aurabot/api/avatar') {
        const p = join(UPSTREAM_ROOT, 'assets', 'dafeiyu.jpg')
        if (existsSync(p)) return send(200, readFileSync(p), 'image/jpeg')
        return send(200, '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><text x="50%" y="54%" font-size="64" text-anchor="middle" dominant-baseline="middle">🐟</text></svg>', 'image/svg+xml')
      }

      json(404, { error: 'not found' })
    } catch (error) {
      json(500, { error: redact(error.message) })
    }
  })
  server.listen(port, '127.0.0.1')
  return server
}
