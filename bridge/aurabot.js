#!/usr/bin/env node
// aurabot.js —— 桥进程自带 CLI（上游 Web 面板的替代）：
//   start        常驻跑起来（QQ 收发 + zcode 会话）
//   status       总览：连接 / 队列 / 会话 / 开关
//   on / off     总开关（关着一句都不发）
//   dry on/off   试运行开关（开着只记日志不真发）
//   setup        交互式首次向导（机器人号 / 主人号 / SnowLuma 目录）
//   sim "文本"   模拟主人私聊一条消息：全链路跑一遍（会真调 ZCode，但不往 QQ 发）
//   speakup      主动搭话：fire 现在就叫她来找你；不带参数看状态
//   sessions     每个 QQ 聊天的 CLI 会话表
//   reset [聊天]  忘掉会话，下一条消息开新会话
//   persona      人格列表 / 切换（aurabot persona <id>）
//   log [n]      最近 n 条日志（默认 30）

import { createInterface } from 'node:readline'
import { createApp } from './src/app.js'
import { listPersonas } from './src/persona/personas.js'
import { detectCjs } from './src/zcode.js'

const [cmd, ...rest] = process.argv.slice(2)

const ok = (msg) => { console.log(msg); process.exit(0) }
const fail = (msg) => { console.error(msg); process.exit(1) }

// readline 的坑：管道输入下，没有 question 挂着时到达的行会被丢弃。自己维护行缓冲。
function makeAsker(input = process.stdin, output = process.stdout) {
  const rl = createInterface({ input, output, terminal: false })
  const lines = []
  const waiters = []
  let ended = false
  rl.on('line', (l) => { const w = waiters.shift(); if (w) w(l); else lines.push(l) })
  rl.on('close', () => { ended = true; for (const w of waiters.splice(0)) w('') })
  return {
    async ask(question) {
      if (lines.length) { output.write(question); return lines.shift() }
      if (ended) { output.write(question); return '' }
      output.write(question)
      return new Promise((r) => waiters.push(r))
    },
    close() { try { rl.close() } catch (error) {} },
  }
}

async function ask(rl, question, { def = '', check } = {}) {
  for (;;) {
    let a = await rl.ask(question)
    a = String(a ?? '').trim()
    if (!a && def) a = def
    if (!check) return a
    const bad = check(a)
    if (!bad) return a
    console.log('  ' + bad)
  }
}

async function main() {
  const daemon = (cmd || 'start') === 'start'
  const app = await createApp({ echo: daemon, watch: daemon })
  const cfg = () => app.getConfig()

  switch (cmd || 'start') {
    case 'start': {
      if (!cfg().setupDone) fail('还没跑过向导：先 node aurabot.js setup')
      app.startWatchdog()
      console.log(`aurabot-bridge 已启动（总开关 ${cfg().enabled ? '开' : '关'}，试运行 ${cfg().dryRun ? '开' : '关'}）—— Ctrl+C 退出`)
      const bye = () => { app.stop(); process.exit(0) }
      process.on('SIGINT', bye)
      process.on('SIGHUP', bye)
      break
    }
    case 'setup': {
      const rl = makeAsker()
      console.log('Aurabot × ZCode 首次向导\n（直接回车用 [方括号] 里的默认值）\n')
      const botQQ = await ask(rl, '机器人 QQ 号：', { check: (v) => (/^\d{5,12}$/.test(v) ? '' : '要 5-12 位数字') })
      const ownerQQ = await ask(rl, '主人（你）的 QQ 号：', { check: (v) => (/^\d{5,12}$/.test(v) ? '' : '要 5-12 位数字') })
      const snowlumaDir = await ask(rl, 'SnowLuma 目录 [C:\\Aurabot\\snowluma]：', { def: 'C:\\Aurabot\\snowluma' })
      const cjs = detectCjs(cfg().zcode.cjsPath)
      console.log(`\nzcode CLI：${cjs || '没找到（装了 ZCode Desktop 吗？装了就在配置 zcode.cjsPath 手动指定）'}`)
      app.setConfig({ ...cfg(), botQQ, ownerQQ, snowluma: { ...cfg().snowluma, dir: snowlumaDir }, setupDone: true })
      rl.close()
      ok(`\n配置好了。接下来：
  1. node aurabot.js status   看连接状态
  2. node aurabot.js on       打开总开关（默认还是试运行，不会真发）
  3. node aurabot.js dry off   确认没问题后，关试运行
  4. node aurabot.js start    常驻跑起来`)
      break
    }
    case 'status': {
      const s = await app.status()
      console.log(JSON.stringify(s, null, 2))
      break
    }
    case 'on': app.setConfig({ ...cfg(), enabled: true }); ok('总开关：开（试运行 ' + (cfg().dryRun ? '仍开着，不会真发' : '已关，会真发') + '）'); break
    case 'off': app.setConfig({ ...cfg(), enabled: false }); ok('总开关：关'); break
    case 'dry': {
      const v = rest[0] === 'off' ? false : true
      app.setConfig({ ...cfg(), dryRun: v })
      ok(`试运行：${v ? '开（只记日志不真发）' : '关（会真发到 QQ！）'}`)
      break
    }
    case 'sim': {
      const text = rest.filter((x) => !x.startsWith('-')).join(' ').trim()
      if (!text) fail('用法：node aurabot.js sim "要对她说的消息" [--group 群号]')
      if (!cfg().ownerQQ) fail('先跑 setup 填主人号')
      const gi = rest.indexOf('--group')
      const group = gi >= 0 ? rest[gi + 1] : ''
      const ev = group
        ? { post_type: 'message', message_type: 'group', self_id: Number(cfg().botQQ) || 0, user_id: Number(cfg().ownerQQ), group_id: Number(group), message_id: Date.now(), sender: { user_id: Number(cfg().ownerQQ), nickname: '主人', card: '主人' }, message: [{ type: 'text', data: { text } }] }
        : { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: Number(cfg().botQQ) || 0, user_id: Number(cfg().ownerQQ), message_id: Date.now(), sender: { user_id: Number(cfg().ownerQQ), nickname: '主人' }, message: [{ type: 'text', data: { text } }] }
      console.log(`模拟${group ? '群' : '私聊'}消息：「${text}」（会真调 ZCode 生成回复，但不发到 QQ）`)
      // sim 临时放开总开关（只改内存，不动真实配置）；发送侧本来就被 capture 截住
      app.patchConfigLive((c) => ({ ...c, enabled: true }))
      const { sent } = await app.hub.capture(() => app.hub.onMessage(ev))
      await app.hub.idle()
      console.log('\n— 会发到 QQ 的内容 —')
      for (const s of sent || []) console.log(`[${s.chatId}] ${s.note}`)
      if (!sent?.length) console.log('（没有产出（被策略拦下或她选择沉默）——看日志：node aurabot.js log）')
      break
    }
    case 'sessions': {
      const t = app.zcode.sessions()
      const rows = Object.entries(t)
      if (!rows.length) ok('（还没有会话）')
      console.log('聊天            轮数   最后活跃            sessionId')
      for (const [chatId, e] of rows) console.log(`${chatId.padEnd(16)}${String(e.turns ?? '?').padEnd(6)} ${new Date(e.updatedAt).toLocaleString()}   ${e.sessionId || '（下一条开新会话）'}`)
      break
    }
    case 'speakup': {
      // 手动叫她来私聊找主人（真调 ZCode 生成，capture 住不发 QQ——要真发就开总开关等定时）
      if (rest[0] === 'fire') {
        if (!cfg().ownerQQ) fail('先跑 setup 填主人号')
        app.patchConfigLive((c) => ({ ...c, enabled: true }))
        console.log('让她现在来找你（会真调 ZCode，不发 QQ）…')
        const { sent } = await app.hub.capture(() => app.speakupModule.fire('手动'))
        await app.hub.idle()
        console.log('\n— 会发到 QQ 的内容 —')
        for (const s of sent || []) console.log(`[${s.chatId}] ${s.note}`)
        if (!sent?.length) console.log('（她选择沉默或没产出——看日志：node aurabot.js log）')
        break
      }
      const s = app.speakupModule.state()
      console.log(`今天已主动找过你 ${s.count} 次；下次评估在日程内自动进行（醒来时段 ${cfg().speakUp.awakeFrom}:00–${cfg().speakUp.awakeTo}:00，空闲 ${cfg().speakUp.idleMinutes} 分钟以上）`)
      break
    }
    case 'reset': {
      const chatId = rest[0]
      if (chatId) { app.hub.resetChat(chatId); ok(`已忘掉 ${chatId} 的会话`) }
      const n = app.hub.resetSessions()
      ok(`已忘掉 ${n} 个聊天的会话`)
      break
    }
    case 'persona': {
      const list = listPersonas()
      if (!rest[0]) {
        console.log(`当前：${cfg().persona.current}`)
        for (const p of list) console.log(`  ${p.id.padEnd(16)}${p.name}（${p.chars} 字）`)
        break
      }
      if (!list.some((p) => p.id === rest[0])) fail(`没有「${rest[0]}」这张人格卡`)
      app.setConfig({ ...cfg(), persona: { current: rest[0] } })
      ok(`人格切到 ${rest[0]}（工作区 AGENTS.md 已更新）`)
      break
    }
    case 'log': {
      const n = Number(rest[0]) || 30
      // 读日志文件而不是内存环（那是单进程的）：内存环里的最近几条贴在后面
      const { readdirSync, readFileSync } = await import('node:fs')
      const { dataDir } = await import('./src/core/store.js')
      let lines = []
      try {
        const files = readdirSync(dataDir('logs')).filter((f) => /^aurabot-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
        for (const f of files.slice(-2)) lines.push(...readFileSync(dataDir('logs', f), 'utf8').split('\n').filter(Boolean))
      } catch (error) {}
      lines.push(...app.logger.recent(n).map((e) => `${e.time} [${e.level}] [${e.area}] ${e.text}`))
      for (const l of lines.slice(-n)) console.log(l)
      break
    }
    case 'help':
    case '--help':
    case '-h':
    default:
      ok(`aurabot.js —— 用法：
  node aurabot.js start            常驻跑（Ctrl+C 退出）
  node aurabot.js status           总览
  node aurabot.js setup            首次向导
  node aurabot.js on | off         总开关
  node aurabot.js dry on | off     试运行开关
  node aurabot.js sim "文本" [--group 群号]   模拟一条消息（真调 ZCode，不发 QQ）
  node aurabot.js speakup fire               现在就叫她主动来找你（不发 QQ）
  node aurabot.js sessions         会话表
  node aurabot.js reset [聊天ID]   忘掉会话
  node aurabot.js persona [id]     人格列表 / 切换
  node aurabot.js log [n]          最近日志`)
  }
}

main().catch((error) => fail(error.stack || String(error)))
