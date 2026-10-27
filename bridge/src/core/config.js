// 桥进程配置：默认值 + 归一化 + 读写。配置文件 workspace/config.json
// 上游 config.js 的裁剪版：砍掉了 M1 用不到的模块段（diary/bili/qzone/song/imageGen/local/bridge/模块内核），
// 新增 zcode 段（CLI 驱动）。被砍掉的段在对应里程碑搬模块时再加回来（M4 已补 voice/speakUp）。

import { dataRoot, readJson, writeJson } from './store.js'
import { join } from 'node:path'
import { DEFAULT_GROUP_POLICY } from '../chat/group-policy.js'
import { LEVELS } from '../chat/access.js'

export const DEFAULTS = {
  enabled: false, // 总开关：关着一句都不发
  dryRun: true, // 试运行：只记日志不真发
  setupDone: false, // 首次使用向导走完了没有
  botQQ: '', // 机器人 QQ 号（向导里填）
  ownerQQ: '', // 主人 QQ 号（向导里填）
  ownerName: '主人',
  ownerLevel: 'full', // full | social | chat
  allow: { private: [], groups: [] }, // 主人永远能私聊，不用写进白名单
  snowluma: {
    dir: 'C:\\Aurabot\\snowluma', // 主人自己下载解压到这里（EULA 不允许自动部署）
    autoStart: true, // 随桥进程启动它（只启动主人已安装并同意过协议的副本）
    webuiPort: 5099,
    webuiPassword: '', // 桥进程自动生成并保存；用来调 /api/processes 只给机器人号注入
    passwordAuto: false,
    autoAttach: true, // 自动给机器人号所在的 QQ 进程注入（绝不碰别的号）
    httpUrl: '', // 留空 = 从 SnowLuma 配置里自动读
    wsUrl: '',
    httpToken: '',
    wsToken: '',
  },
  // ZCode CLI 驱动：每条合并后的消息拉一个 zcode -p 进程，--resume 续会话
  zcode: {
    cjsPath: '', // zcode.cjs 路径；留空 = 自动探测（ZCode Desktop 安装目录）
    nodePath: '', // node 可执行文件；留空 = process.execPath
    workspaceDir: '', // 会话工作区（AGENTS.md 人格在这里）；留空 = dataRoot()
    timeoutMs: 300_000, // 一轮回复最多等多久
    maxParallel: 2, // 同时跑几个 zcode 进程（跨聊天并行，单个聊天内串行）
    mode: '', // --mode（build/edit/plan/yolo/guarded）；留空 = CLI 默认
    disallowedTools: [], // --disallowed-tools；社交档的安全边界（M2 按聊天档位自动收紧）
    maxContextTurns: 0, // >0 时超过这么多轮自动换新会话（上下文膨胀保护），0 = 不限
  },
  merge: { enabled: true, waitSec: 2.5, maxSec: 8, groupWaitSec: 5, groupMaxSec: 15 }, // 连发合并：对方停顿 waitSec 秒再一起回，最多等 maxSec 秒；群里等得久一点，把一段话攒齐
  // M3 模块
  mood: { enabled: true, halfLifeHours: 3, judge: false }, // judge：每轮聊完用模型判一次心情（更准，多一次小任务）；关着用关键词
  memory: { enabled: true, recallCount: 6, dailyConsolidate: true, consolidateTimes: ['04:00', '16:00'] }, // 每天这几个时间把流水整理进长期记忆
  stickers2: { enabled: true, autoChance: 0.35, collect: true, maxPerHour: 20, maxLibrary: 300 },
  // M4 模块
  voice: {
    enabled: true,
    // auto = 先 edge-tts，不行用 Windows 语音；edge / windows / cosyvoice / gptsovits / http = 指定引擎（失败都会退回 Windows 语音）
    engine: 'auto',
    cosyvoice: { url: 'http://127.0.0.1:50000', mode: 'sft', spkId: '中文女', instruct: '', sampleRate: 22050 },
    gptsovits: { url: 'http://127.0.0.1:9880', refAudio: '', promptText: '', promptLang: 'zh', textLang: 'zh' },
    http: { urlTemplate: '' }, // 通用：GET 这个地址（{text} 会替换成要念的话），返回音频
    voice: 'zh-CN-XiaoyiNeural',
    rate: '+0%',
    pitch: '+0Hz',
    autoChance: 0.15, // 短回复自动变语音的概率
    autoMaxChars: 80,
  },
  speakUp: {
    enabled: true, // 只在和主人的私聊里主动找你，群里不会
    idleMinutes: 40,
    minIntervalMinutes: 60,
    maxIntervalMinutes: 180,
    maxPerDay: 4,
    nudge: true, // 她问了你一句、你一直没回时，偶尔轻轻追一句
    awakeFrom: 8,
    awakeTo: 23,
  },
  persona: { current: 'dafeiyu' },
  group: { ...DEFAULT_GROUP_POLICY, overrides: {} },
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function deepMerge(base, over) {
  if (!isObj(over)) return structuredClone(base)
  const out = structuredClone(base)
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

const num = (v, d, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d
}
const bool = (v, d) => (typeof v === 'boolean' ? v : d)
const qq = (v) => String(v ?? '').replace(/\D/g, '')
const qqList = (v) => [...new Set((Array.isArray(v) ? v : String(v || '').split(/[\s,，;；]+/)).map(qq).filter(Boolean))]

export function normalize(raw) {
  const c = deepMerge(DEFAULTS, raw)
  c.enabled = bool(c.enabled, false)
  c.dryRun = bool(c.dryRun, true)
  c.botQQ = qq(c.botQQ)
  c.ownerQQ = qq(c.ownerQQ)
  c.setupDone = bool(c.setupDone, false)
  c.ownerLevel = LEVELS.includes(c.ownerLevel) ? c.ownerLevel : 'full'
  c.allow = { private: qqList(c.allow.private), groups: qqList(c.allow.groups) }
  const g = c.group
  g.wakeWords = (Array.isArray(g.wakeWords) ? g.wakeWords : String(g.wakeWords || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean)
  g.interjectChance = num(g.interjectChance, 0.15, 0, 1)
  g.cooldownSec = num(g.cooldownSec, 90, 0, 86400)
  g.maxPerHour = num(g.maxPerHour, 6, 0, 120)
  g.minRecentMessages = num(g.minRecentMessages, 3, 0, 100)
  g.activeWindowSec = num(g.activeWindowSec, 300, 30, 86400)
  if (!Array.isArray(g.quietHours) || g.quietHours.length !== 2) g.quietHours = DEFAULT_GROUP_POLICY.quietHours
  g.quietHours = g.quietHours.map((h) => num(h, 0, 0, 23))
  if (!isObj(g.overrides)) g.overrides = {}
  g.interests = (Array.isArray(g.interests) ? g.interests : String(g.interests || '').split(/[\s,，]+/)).map((s) => String(s).trim()).filter(Boolean)
  g.minRelevance = num(g.minRelevance, 0.25, 0, 1)
  g.burstMax = num(g.burstMax, 8, 1, 50)
  g.burstWindowSec = num(g.burstWindowSec, 120, 10, 3600)
  c.merge.enabled = bool(c.merge.enabled, true)
  c.merge.waitSec = num(c.merge.waitSec, 2.5, 0, 30)
  c.merge.maxSec = Math.max(c.merge.waitSec, num(c.merge.maxSec, 8, 0, 60))
  c.merge.groupWaitSec = num(c.merge.groupWaitSec, 5, 0, 60)
  c.merge.groupMaxSec = Math.max(c.merge.groupWaitSec, num(c.merge.groupMaxSec, 15, 0, 120))
  // M3 模块段钳制
  c.mood.enabled = bool(c.mood.enabled, true)
  c.mood.halfLifeHours = num(c.mood.halfLifeHours, 3, 0.25, 72)
  c.mood.judge = bool(c.mood.judge, false)
  c.memory.enabled = bool(c.memory.enabled, true)
  c.memory.recallCount = num(c.memory.recallCount, 6, 0, 20)
  c.memory.dailyConsolidate = bool(c.memory.dailyConsolidate, true)
  c.memory.consolidateTimes = [...new Set((Array.isArray(c.memory.consolidateTimes) ? c.memory.consolidateTimes : String(c.memory.consolidateTimes || '').split(/[\s,，]+/)).map((t) => (/^\d{1,2}:\d{2}$/.test(String(t).trim()) ? String(t).trim() : '')).filter(Boolean).map((t) => t.padStart(5, '0')))].sort().slice(0, 4)
  if (!c.memory.consolidateTimes.length) c.memory.consolidateTimes = ['04:00', '16:00']
  const s2 = c.stickers2
  s2.enabled = bool(s2.enabled, true)
  s2.autoChance = num(s2.autoChance, 0.35, 0, 1)
  s2.collect = bool(s2.collect, true)
  s2.maxPerHour = num(s2.maxPerHour, 20, 0, 200)
  s2.maxLibrary = num(s2.maxLibrary, 300, 20, 2000)
  // M4 模块段钳制
  const v = c.voice
  v.enabled = bool(v.enabled, true)
  v.autoChance = num(v.autoChance, 0.15, 0, 1)
  v.autoMaxChars = num(v.autoMaxChars, 80, 1, 500)
  v.voice = String(v.voice || 'zh-CN-XiaoyiNeural').trim()
  v.rate = /^\+\d+%$|^-\d+%$/.test(String(v.rate)) ? v.rate : '+0%'
  v.pitch = /^\+\d+Hz$|^-\d+Hz$/.test(String(v.pitch)) ? v.pitch : '+0Hz'
  if (!['auto', 'edge', 'windows', 'cosyvoice', 'gptsovits', 'http'].includes(v.engine)) v.engine = 'auto'
  if (!isObj(v.cosyvoice)) v.cosyvoice = structuredClone(DEFAULTS.voice.cosyvoice)
  if (!isObj(v.gptsovits)) v.gptsovits = structuredClone(DEFAULTS.voice.gptsovits)
  if (!isObj(v.http)) v.http = { urlTemplate: '' }
  v.cosyvoice.sampleRate = num(v.cosyvoice.sampleRate, 22050, 8000, 48000)
  if (!['sft', 'instruct'].includes(v.cosyvoice.mode)) v.cosyvoice.mode = 'sft'
  const sp = c.speakUp
  sp.enabled = bool(sp.enabled, true)
  sp.idleMinutes = num(sp.idleMinutes, 40, 5, 1440)
  sp.nudge = bool(sp.nudge, true)
  sp.minIntervalMinutes = num(sp.minIntervalMinutes, 60, 5, 1440)
  sp.maxIntervalMinutes = Math.max(sp.minIntervalMinutes, num(sp.maxIntervalMinutes, 180, 5, 2880))
  sp.maxPerDay = num(sp.maxPerDay, 4, 0, 20)
  sp.awakeFrom = num(sp.awakeFrom, 8, 0, 23)
  sp.awakeTo = num(sp.awakeTo, 23, 1, 24)
  const z = c.zcode
  z.cjsPath = String(z.cjsPath || '').trim()
  z.nodePath = String(z.nodePath || '').trim()
  z.workspaceDir = String(z.workspaceDir || '').trim()
  z.timeoutMs = num(z.timeoutMs, 300_000, 30_000, 1_800_000)
  z.maxParallel = num(z.maxParallel, 2, 1, 8)
  z.mode = ['build', 'edit', 'plan', 'yolo', 'guarded', ''].includes(z.mode) ? z.mode : ''
  z.disallowedTools = (Array.isArray(z.disallowedTools) ? z.disallowedTools : String(z.disallowedTools || '').split(/[,\s]+/)).map((s) => String(s).trim()).filter(Boolean)
  z.maxContextTurns = num(z.maxContextTurns, 0, 0, 1000)
  c.snowluma.webuiPort = num(c.snowluma.webuiPort, 5099, 1, 65535)
  return c
}

// 密钥类字段：status / 日志里不出现原文（脱敏另有一层，这里是配置层面的清单）
export const SECRET_FIELDS = [
  ['snowluma', 'webuiPassword'],
  ['snowluma', 'httpToken'],
  ['snowluma', 'wsToken'],
]

const FILE = () => CONFIG_FILE()
export const CONFIG_FILE = () => join(dataRoot(), 'config.json')

export function loadConfig() {
  const raw = readJson(FILE(), {})
  // 老配置（向导上线前就填好了两个号）直接算向导已完成
  if (raw && raw.setupDone === undefined && raw.botQQ && raw.ownerQQ) raw.setupDone = true
  return normalize(raw)
}

export function saveConfig(cfg) {
  const c = normalize(cfg)
  writeJson(FILE(), c)
  return c
}
