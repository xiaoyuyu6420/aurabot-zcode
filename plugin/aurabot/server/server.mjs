// aurabot 插件的 MCP 服务（stdio、零依赖）。
// 直接复用桥进程的 config.js 读写配置（原子写 + normalize 钳制），桥 daemon 2 秒内热加载。
// 面板资源 ui://aurabot/panel.html 从插件自己的 ui/ 目录提供。

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// 桥仓库位置：清单 env 优先，否则常见位置探测
function resolveBridgeDir() {
  const candidates = [
    process.env.AURABOT_BRIDGE_DIR,
    join(homedir(), 'Desktop', 'aurabot-zcode'),
    join(homedir(), 'aurabot-zcode'),
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(join(c, 'bridge', 'src', 'core', 'config.js'))) return c
  return ''
}
const BRIDGE_DIR = resolveBridgeDir()

const lazy = { config: null }
async function bridgeConfig() {
  if (!BRIDGE_DIR) throw new Error('找不到 aurabot 桥仓库（bridge/src/core/config.js）')
  if (!lazy.config) {
    lazy.config = await import(pathToFileURL(join(BRIDGE_DIR, 'bridge', 'src', 'core', 'config.js')).href)
  }
  return lazy.config
}
const workspaceDir = () => join(BRIDGE_DIR, 'workspace')

// 密钥类字段不进模型/面板
const SECRET_PATHS = [['snowluma', 'webuiPassword'], ['snowluma', 'httpToken'], ['snowluma', 'wsToken']]
function stripSecrets(cfg) {
  const c = structuredClone(cfg)
  for (const [g, k] of SECRET_PATHS) if (c?.[g]) c[g][k] = c[g][k] ? '(已设置)' : ''
  return c
}

function listPersonas() {
  const dir = join(workspaceDir(), 'personas')
  const out = []
  try {
    for (const n of readdirSync(dir)) {
      if (!n.endsWith('.md')) continue
      const raw = readFileSync(join(dir, n), 'utf8')
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      const name = m ? (m[1].match(/^name:\s*(.+)$/m)?.[1] || '').trim() : n
      out.push({ id: n.slice(0, -3), name: name || n, chars: raw.length })
    }
  } catch (error) {}
  return out
}

function readSessions() {
  try {
    return JSON.parse(readFileSync(join(workspaceDir(), 'sessions.json'), 'utf8')).chats || {}
  } catch (error) {
    return {}
  }
}

function tailLogs(lines = 40) {
  const dir = join(workspaceDir(), 'logs')
  const out = []
  try {
    const files = readdirSync(dir).filter((f) => /^aurabot-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort().slice(-2)
    for (const f of files) out.push(...readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
  } catch (error) {}
  return out.slice(-Math.max(1, Math.min(400, lines)))
}

function gatewayStateFromLog() {
  const lines = tailLogs(120).filter((l) => l.includes('网关'))
  const last = lines[lines.length - 1] || ''
  if (last.includes('connected')) return 'connected'
  if (last.includes('connecting')) return 'connecting'
  if (last.includes('stopped')) return 'stopped'
  if (last.includes('disconnected')) return 'disconnected'
  return 'unknown'
}

// ---------------- 工具实现 ----------------

async function overview() {
  const m = await bridgeConfig()
  const cfg = m.loadConfig()
  return {
    bridgeDir: BRIDGE_DIR,
    config: stripSecrets(cfg),
    personas: listPersonas(),
    sessions: readSessions(),
    gateway: gatewayStateFromLog(),
  }
}

// 允许面板/模型改哪些键（防注入：只收这些，其余忽略）
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

function pick(patch) {
  const out = {}
  let touched = []
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

async function setConfig(patch) {
  const m = await bridgeConfig()
  const current = m.loadConfig()
  const { out, touched } = pick(patch || {})
  if (!Object.keys(out).length) throw new Error('没有可修改的字段（键不在白名单里）')
  const next = structuredClone(current)
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'object' && !Array.isArray(v) && next[k] && typeof next[k] === 'object') Object.assign(next[k], v)
    else next[k] = v
  }
  const saved = m.saveConfig(next) // normalize 钳制 + 原子写；桥 daemon ≤2s 热加载
  return { saved: stripSecrets(saved), changed: touched }
}

async function resetSessions(chatId) {
  const file = join(workspaceDir(), 'sessions.json')
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (chatId) {
    const had = Boolean(data.chats[chatId])
    delete data.chats[chatId]
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    return { reset: chatId, existed: had }
  }
  const n = Object.keys(data.chats).length
  writeFileSync(file, JSON.stringify({ chats: {} }, null, 2), 'utf8')
  return { resetAll: true, count: n }
}

// ---------------- MCP 协议 ----------------

const TOOLS = [
  {
    name: 'aurabot_overview',
    description: '读取大肥鱼机器人总览：配置（脱敏）、人格列表、各聊天会话表、网关状态。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'aurabot_config_set',
    description: '修改机器人配置（白名单字段：开关/人格/白名单/合并参数/群聊策略/zcode 驱动）。改完桥进程 2 秒内热加载，无需重启。 secrets 字段不可通过此工具修改。',
    inputSchema: {
      type: 'object',
      properties: {
        patch: {
          type: 'object',
          description: '要合并进去的配置片段，例如 {"enabled":true} 或 {"merge":{"waitSec":3},"group":{"interjectChance":0.2}}',
        },
      },
      required: ['patch'],
    },
  },
  {
    name: 'aurabot_log',
    description: '读取桥进程最近日志（含 QQ 网关状态变化）。',
    inputSchema: { type: 'object', properties: { lines: { type: 'number', description: '条数，默认 40，最大 400' } } },
  },
  {
    name: 'aurabot_reset',
    description: '忘掉机器人的 CLI 会话：指定 chatId（如 private:672178818）重置单个聊天；不指定则全部重置（下一条消息开新会话，聊天记录不删）。',
    inputSchema: { type: 'object', properties: { chatId: { type: 'string' } } },
  },
]

const PANEL_URI = 'ui://aurabot/panel.html'

function panelHtml() {
  return readFileSync(join(PLUGIN_ROOT, 'ui', 'panel.html'), 'utf8')
}

async function callTool(name, args) {
  const a = args || {}
  switch (name) {
    case 'aurabot_overview':
      return { content: [{ type: 'text', text: JSON.stringify(await overview()) }], structuredContent: await overview() }
    case 'aurabot_config_set': {
      const r = await setConfig(a.patch)
      return { content: [{ type: 'text', text: '已保存：' + r.changed.join(', ') + '（桥进程约 2 秒内热加载）' }], structuredContent: r }
    }
    case 'aurabot_log':
      return { content: [{ type: 'text', text: tailLogs(Number(a.lines) || 40).join('\n') }] }
    case 'aurabot_reset': {
      const r = await resetSessions(a.chatId)
      return { content: [{ type: 'text', text: JSON.stringify(r) }], structuredContent: r }
    }
    default:
      throw new Error(`未知工具：${name}`)
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  let msg
  try { msg = JSON.parse(text) } catch (error) { return }
  if (!msg || msg.jsonrpc !== '2.0') return
  const { id, method, params } = msg
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: 'aurabot', version: '0.1.0' },
      },
    })
  }
  if (method && method.startsWith('notifications/')) return
  if (id === undefined || id === null) return
  try {
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    if (method === 'tools/call') {
      Promise.resolve(callTool(params?.name, params?.arguments))
        .then((result) => send({ jsonrpc: '2.0', id, result }))
        .catch((error) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '错误：' + error.message }], isError: true } }))
      return
    }
    if (method === 'resources/list') {
      return send({ jsonrpc: '2.0', id, result: { resources: [{ uri: PANEL_URI, name: '大肥鱼控制台', mimeType: 'text/html;profile=mcp-app' }] } })
    }
    if (method === 'resources/read') {
      const uri = String(params?.uri || '')
      if (uri !== PANEL_URI) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: '未知资源：' + uri } })
      return send({ jsonrpc: '2.0', id, result: { contents: [{ uri: PANEL_URI, mimeType: 'text/html;profile=mcp-app', text: panelHtml() }] } })
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: '未知方法：' + method } })
  } catch (error) {
    return send({ jsonrpc: '2.0', id, error: { code: -32603, message: error.message } })
  }
})

// 保持进程存活
setInterval(() => {}, 1 << 30)
