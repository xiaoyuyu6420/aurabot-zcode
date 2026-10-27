#!/usr/bin/env node
// 备份到私人仓库：把「源码 + 运行时状态 + 部署产物」同步到独立目录，然后 git 提交推送。
//
// 用法：
//   node tools/backup.js                 # 同步到 %USERPROFILE%\Desktop\aurabot-zcode-backup 并推送
//   node tools/backup.js --no-push       # 只同步 + 本地提交，不推送
//   AURABOT_BACKUP_DIR=D:\backup node tools/backup.js
//
// 备份仓与发布仓（origin，公开）物理隔离：备份仓有自己的 .git，
// 这里只操作备份目录，绝不碰发布仓的 remote。
//
// 备份什么：
//   源码     bridge/ plugin/ tools/ spec.md README.md PROGRESS.md
//   上游镜像 dsh-aurabot-qq/（去掉 .git，代码本身只有 2MB 左右）
//   运行时   workspace/ 里「丢了就恢复不了」的部分：config.json（含凭据，私人仓）、
//            人格卡、长期记忆、会话表、聊天流水、表情库、心情/搭话/开放 token 状态
//   部署     Task Scheduler 任务 XML（本机导出）、部署说明
// 不备份（可重建/太大）：
//   workspace/pyenv（edge-tts 的 Python 环境）、voice-cache（临时语音）、
//   tmp、queue（运行中快照）、logs（每天滚动，体积只会涨）、
//   zcode-src（175MB 上游源码参照，随时可重新 clone）、node_modules

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = resolve(process.env.AURABOT_BACKUP_DIR || join(homedir(), 'Desktop', 'aurabot-zcode-backup'))
const NO_PUSH = process.argv.includes('--no-push')

const SKIP_DIRS = new Set(['.git', 'node_modules', 'zcode-src', 'pyenv', 'voice-cache', 'tmp', 'queue', 'logs', 'dist', '.v2c', '.video_agent'])

// workspace 里值得备份的文件/目录（白名单：宁缺毋滥，避免把临时快照带进去）
const WORKSPACE_KEEP = [
  'AGENTS.md', 'config.json', 'memories.json', 'sessions.json', 'mood.json', 'speakup.json',
  'bili.json', 'qzone-social.json', 'open-token.json', 'personas', 'chatlog', 'stickers', 'skills',
]

function copyFilter(src) {
  const base = relative(ROOT, src)
  if (!base) return true
  const parts = base.split(/[\\/]/)
  if (parts[0] === 'workspace') {
    if (parts.length === 1) return true
    return WORKSPACE_KEEP.includes(parts[1])
  }
  if (SKIP_DIRS.has(parts[parts.length - 1])) return false
  return true
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push({ path: p, size: st.size })
  }
  return out
}

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

const BACKUP_MD = `# Aurabot × ZCode 备份仓

> 私人备份（不是发布仓）。发布仓：https://github.com/xiaoyuyu6420/aurabot-zcode

由 \`tools/backup.js\` 从开发机同步而来，包含：

- **源码**：bridge/（桥进程 + CLI 驱动）、plugin/（ZCode 插件）、spec.md / PROGRESS.md / README
- **上游镜像**：dsh-aurabot-qq/（去掉 .git，方便离线查看）
- **运行时状态**（workspace/）：配置（含凭据）、人格卡、长期记忆、CLI 会话表、聊天流水、表情库、
  心情/主动搭话/开放接口 token 状态
- **部署产物**（deploy/）：Windows 计划任务 XML

不包含：Python 虚拟环境、语音缓存、临时队列、日志、zcode-src 源码参照（都可重建）。

## 恢复步骤（换机）

1. \`git clone <本仓库>\` 到任意目录（路径随意，桥的配置里会记录绝对路径，注意改）
2. 安装 ZCode Desktop（Aurabot 实例）并登录；确认 \`resources/glm/provider/zcode-builtin.json\` 在
3. 装 SnowLuma 到 \`C:\\Aurabot\\snowluma\`（删掉自带 node.exe，用系统 node ≥24）
4. 登录 QQ 机器人号
5. \`cd bridge && node aurabot.js status\` 检查；路径变了就改 \`workspace/config.json\` 的
   \`zcode.cjsPath\` / \`snowluma.dir\`；\`node aurabot.js start\` 起常驻（或导入 deploy/aurabot-bridge.xml）
6. 面板 http://127.0.0.1:51073 ；语音组件需要重装（面板「安装 edge-tts」）
`

// 1) 清空备份目录（保留 .git / BACKUP.md；BACKUP_MD 常量在上方，首次写入用）
mkdirSync(TARGET, { recursive: true })
for (const n of readdirSync(TARGET)) {
  if (n === '.git' || n === 'BACKUP.md') continue
  rmSync(join(TARGET, n), { recursive: true, force: true })
}

// 2) 同步源码 + 白名单运行时数据
cpSync(ROOT, TARGET, { recursive: true, filter: copyFilter })

// 3) 部署产物：Task Scheduler 任务 XML（换机恢复用）
mkdirSync(join(TARGET, 'deploy'), { recursive: true })
try {
  const r = spawnSync('schtasks', ['/query', '/tn', 'aurabot-bridge', '/xml'], { encoding: 'utf8', windowsHide: true })
  if (r.status === 0 && r.stdout?.includes('<Task')) writeFileSync(join(TARGET, 'deploy', 'aurabot-bridge.xml'), r.stdout, 'utf8')
} catch (error) {}

// 4) 说明文档 + 快照元数据
if (!existsSync(join(TARGET, 'BACKUP.md'))) writeFileSync(join(TARGET, 'BACKUP.md'), BACKUP_MD, 'utf8')
const files = walk(TARGET).filter((f) => relative(TARGET, f.path) !== 'snapshot.json')
writeFileSync(join(TARGET, 'snapshot.json'), JSON.stringify({
  at: Date.now(),
  time: new Date().toLocaleString('zh-CN'),
  from: ROOT,
  files: files.length,
  bytes: files.reduce((s, f) => s + f.size, 0),
}, null, 2) + '\n', 'utf8')

// 5) 初始化/提交/推送（只在备份目录里操作）
if (!existsSync(join(TARGET, '.git'))) {
  sh('git', ['init', '-b', 'main'], TARGET)
  console.log('备份仓初始化完成。')
}
sh('git', ['add', '-A'], TARGET)
const st = sh('git', ['status', '--porcelain'], TARGET)
if (st.out) {
  sh('git', ['-c', 'user.name=aurabot-backup', '-c', 'user.email=backup@local', 'commit', '-m', `backup: ${new Date().toLocaleString('zh-CN')} (${files.length} files)`], TARGET)
  console.log(`已提交：${files.length} 个文件，${(files.reduce((s, f) => s + f.size, 0) / 1024).toFixed(0)} KB`)
} else {
  console.log('没有变化，不提交')
}
const remote = sh('git', ['remote', 'get-url', 'origin'], TARGET)
if (remote.code !== 0) {
  console.log(`备份目录：${TARGET}\n还没设置 origin。建好私人仓库后：git -C "${TARGET}" remote add origin <私有仓地址> && git -C "${TARGET}" push -u origin main`)
  process.exit(0)
}
if (!NO_PUSH) {
  const p = sh('git', ['push', 'origin', 'main'], TARGET)
  console.log(p.code === 0 ? '已推送到私人备份仓' : '推送失败：' + (p.err || p.out))
  if (p.code !== 0) process.exit(1)
}
