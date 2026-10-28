// ZCode CLI 驱动：把一段拼好的提示词交给 zcode -p 跑一轮，拿回正文和 sessionId。
// 每个 QQ 聊天一个持久 CLI 会话（--resume），跨重启不断——会话表存 workspace/sessions.json。
//
// 一个聊天内的消息天然串行（hub 的 busy 机制），跨聊天最多同时跑 maxParallel 个进程。

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { dataDir, dataRoot, readJson, writeJson, ensureDir } from './core/store.js'

const CANDIDATE_CJS = [
  // Windows：ZCode Desktop 安装目录
  join(homedir(), 'AppData', 'Local', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
  'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs',
  // Linux（WSL）：桌面版资源拷贝 / 官方 install.sh 的 runtime 目录
  join(homedir(), 'zcode-runtime', 'zcode.cjs'),
  join(homedir(), '.zcode', 'runtime', 'zcode', 'bin', 'zcode.mjs'),
]

/** 自动探测桌面版自带的 zcode.cjs（Windows 优先，Linux 次之）。 */
export function detectCjs(explicit = '') {
  if (explicit && existsSync(explicit)) return explicit
  for (const p of CANDIDATE_CJS) if (existsSync(p)) return p
  return ''
}

export function createZcodeDriver({ getConfig, log }) {
  const tableFile = () => dataDir('sessions.json')
  const table = () => readJson(tableFile(), () => ({ chats: {} }))
  const saveTable = (t) => writeJson(tableFile(), t)

  let running = 0
  const waiters = []
  const slot = () => new Promise((resolve) => {
    if (running < getConfig().zcode.maxParallel) return resolve()
    waiters.push(resolve)
  })
  const releaseSlot = () => {
    const next = waiters.shift()
    if (next) next()
  }

  function argsFor(chatId, prompt, files) {
    const cfg = getConfig().zcode
    const args = [cjsPath(), '-p', String(prompt), '--json', '--cwd', workspaceDir(), '--surface', 'terminal', '--locale', 'zh-CN']
    const entry = table().chats[chatId]
    if (entry && entry.sessionId) args.push('--resume', entry.sessionId)
    for (const f of files || []) args.push('--attach', f)
    if (cfg.mode) args.push('--mode', cfg.mode)
    // 社交档（群聊/非主人私聊）自动收紧：在主人配置的基础上再挡掉改文件和终端，双保险
    const disallowed = new Set(cfg.disallowedTools)
    if (socialChat(chatId)) for (const t of ['Write', 'Edit', 'Bash']) disallowed.add(t)
    if (disallowed.size) args.push('--disallowed-tools', [...disallowed].join(','))
    return args
  }

  /** 群聊或非主人的私聊：社交档。chatId 形如 group:123 / private:456；system: / 空 = 后台任务，也按社交档。 */
  function socialChat(chatId) {
    const [kind, id] = String(chatId || '').split(':')
    if (kind === 'group') return true
    if (kind === 'private') return String(id) !== String(getConfig().ownerQQ)
    return true // system:、tmp/ask 等后台会话不给写权限（里面只跑小任务）
  }

  // ---------- GUI 侧栏集成 ----------
  // CLI 会话写进共享库 cli/db/db.sqlite（GUI 冷种子按 directory + task_type 过滤）。
  // 这里把群聊/私聊的会话标题改成干净的短标题（上游 titleFor 同款），侧栏里就是清爽条目。
  const titleCache = new Map() // chatId → 上次写过的标题（没变就不写）
  function guiTitleFor(chatId) {
    const cfg = getConfig()
    const [kind, id] = String(chatId || '').split(':')
    if (kind === 'group') return `QQ 群 · ${id}`
    if (kind === 'private') return id === String(cfg.ownerQQ) ? `QQ · ${cfg.ownerName || '主人'}私聊` : `QQ 私聊 · ${id}`
    return null // system:/后台任务不进侧栏
  }
  function updateSessionTitle(chatId, sessionId) {
    const title = guiTitleFor(chatId)
    if (!title || !sessionId || titleCache.get(chatId) === title) return
    try {
      const dbPath = process.env.ZCODE_SESSION_DB || join(process.env.USERPROFILE || homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
      const db = new DatabaseSync(dbPath)
      db.prepare('update session set title = ?, title_source = ? where id = ?').run(title, 'custom', sessionId)
      db.close()
      titleCache.set(chatId, title)
      log.debug(`${chatId}：GUI 侧栏标题已设为「${title}」`)
    } catch (error) {
      log.debug('GUI 标题写入失败（不影响聊天）：', error.message)
    }
  }

  const cjsPath = () => {
    const p = detectCjs(getConfig().zcode.cjsPath)
    if (!p) throw new Error('找不到 zcode.cjs（没装 ZCode Desktop？在配置 zcode.cjsPath 里手动指定）')
    return p
  }
  const workspaceDir = () => getConfig().zcode.workspaceDir || dataRoot()

  function runOnce(args, { timeoutMs }) {
    return new Promise((resolve, reject) => {
      const node = getConfig().zcode.nodePath || process.execPath
      const child = spawn(node, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const out = []
      const err = []
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { child.kill() } catch (error) {}
        reject(new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没回`))
      }, timeoutMs)
      const done = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }
      child.stdout.on('data', (b) => out.push(b))
      child.stderr.on('data', (b) => err.push(b))
      child.on('error', (e) => done(reject, e))
      child.on('close', (code) => {
        const text = Buffer.concat(out).toString('utf8').trim()
        if (code !== 0) {
          const tail = Buffer.concat(err).toString('utf8').trim().slice(-500) || text.slice(-500)
          return done(reject, new Error(`zcode 退出码 ${code}：${tail || '没有输出'}`))
        }
        // stdout 应该就是一个 JSON 对象；前后偶有诊断行，取最后一个能解析的 {...} 块
        let parsed = null
        try { parsed = JSON.parse(text) } catch (error) {
          const start = text.lastIndexOf('{\n  "sessionId"')
          if (start >= 0) { try { parsed = JSON.parse(text.slice(start)) } catch (error2) {} }
        }
        if (!parsed || typeof parsed.response !== 'string') {
          return done(reject, new Error(`zcode 输出解析不了：${text.slice(0, 300) || Buffer.concat(err).toString('utf8').slice(0, 300)}`))
        }
        done(resolve, parsed)
      })
    })
  }

  /**
   * 跑一轮。files 是要附上的本地图片/文件路径（--attach）。
   * @returns {{ text: string, sessionId: string, usage: object, turns: number }}
   */
  async function turn(chatId, prompt, { files = [], timeoutMs } = {}) {
    const cfg = getConfig().zcode
    await slot()
    running++
    try {
      const args = argsFor(chatId, prompt, files)
      const t0 = Date.now()
      const r = await runOnce(args, { timeoutMs: timeoutMs || cfg.timeoutMs })
      const t = table()
      const prev = t.chats[chatId] || {}
      const turns = (prev.turns || 0) + 1
      t.chats[chatId] = { ...(prev || {}), sessionId: r.sessionId, turns, updatedAt: Date.now() }
      // 上下文轮数保护：超过 maxContextTurns 就忘掉 sessionId，下一条消息开新会话（会话本体还在 CLI 里，可手动 --resume 找回）
      if (cfg.maxContextTurns > 0 && turns >= cfg.maxContextTurns) {
        t.chats[chatId].rolled = true
        delete t.chats[chatId].sessionId
        log.info(`${chatId}：聊了 ${turns} 轮，下一条消息换新会话`)
      }
      saveTable(t)
      updateSessionTitle(chatId, r.sessionId) // GUI 侧栏标题（task-index 冷种子用）
      log.debug(`${chatId}：一轮 ${((Date.now() - t0) / 1000).toFixed(1)}s，${r.usage?.totalTokens ?? '?'} tokens`)
      return { text: r.response, sessionId: r.sessionId, usage: r.usage, turns }
    } finally {
      running--
      releaseSlot()
    }
  }

  /** 后台小任务：在指定目录跑一轮独立会话（不复用聊天会话表，也不写 sessions.json）。B 站/空间这类「她自己在后台想」的动作用。 */
  async function runOnceIn(dir, prompt, { timeoutMs = 180000 } = {}) {
    await slot()
    running++
    try {
      const cfg = getConfig().zcode
      const args = [cjsPath(), '-p', String(prompt), '--json', '--cwd', dir, '--surface', 'terminal', '--locale', 'zh-CN']
      if (cfg.mode) args.push('--mode', cfg.mode)
      // 后台任务不需要动文件：比照社交档收紧
      const disallowed = new Set(cfg.disallowedTools)
      for (const t of ['Write', 'Edit', 'Bash']) disallowed.add(t)
      if (disallowed.size) args.push('--disallowed-tools', [...disallowed].join(','))
      const r = await runOnce(args, { timeoutMs })
      return { text: r.response, sessionId: r.sessionId, usage: r.usage }
    } finally {
      running--
      releaseSlot()
    }
  }

  /** 忘掉某个聊天的会话（/reset 用）：下一条消息开新会话。 */
  function forget(chatId) {
    const t = table()
    const had = Boolean(t.chats[chatId])
    delete t.chats[chatId]
    saveTable(t)
    return had
  }

  function forgetAll() {
    const t = table()
    const n = Object.keys(t.chats).length
    saveTable({ chats: {} })
    return n
  }

  /** 健康检查：CLI 在不在、登录态可不可用（跑一个极短回合）。 */
  async function ping() {
    const args = [cjsPath(), '--version']
    return new Promise((resolve) => {
      const child = spawn(getConfig().zcode.nodePath || process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      const out = []
      child.stdout.on('data', (b) => out.push(b))
      child.on('error', () => resolve({ ok: false, message: '起不来 node 进程' }))
      child.on('close', (code) => resolve({ ok: code === 0, version: Buffer.concat(out).toString('utf8').trim(), cjs: cjsPath() }))
    })
  }

  /** 把 base64 图片落成临时文件给 --attach（CLI 只收路径）。返回临时文件路径；用完由调用方删。 */
  function stageAttachment(name, dataBase64) {
    const dir = ensureDir(dataDir('tmp'))
    const file = join(dir, `att-${Date.now()}-${String(name || 'img').replace(/[^\w.-]/g, '_')}`)
    writeFileSync(file, Buffer.from(dataBase64, 'base64'))
    return file
  }

  return {
    turn,
    runOnceIn,
    forget,
    forgetAll,
    ping,
    stageAttachment,
    sessions: () => table().chats,
    cjsPath,
    workspaceDir,
    get running() { return running },
  }
}
