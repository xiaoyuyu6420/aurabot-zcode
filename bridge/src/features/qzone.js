// QQ 空间：发说说 + 空间日记（每天 N 次，时间窗里随机，结合当天聊天）。

import { dataDir, readJson, writeJson } from '../core/store.js'
import { fetchImage } from '../core/net.js'

const RIGHT = { all: 1, friends: 4, self: 64 }

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + m
}
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 给某一天排日记时间：窗口内随机 n 个时刻，两两间隔 ≥ gap 分钟。纯函数（rand 可注入）。 */
export function planDiaryTimes({ timesPerDay, windowStart, windowEnd, minGapMinutes }, rand = Math.random) {
  const a = toMin(windowStart)
  const b = toMin(windowEnd)
  const n = Math.max(0, Math.round(timesPerDay))
  if (n === 0 || b <= a) return []
  const span = b - a
  const gap = Math.min(minGapMinutes, Math.floor(span / Math.max(n, 1)))
  for (let attempt = 0; attempt < 200; attempt++) {
    const pts = Array.from({ length: n }, () => a + Math.floor(rand() * span)).sort((x, y) => x - y)
    if (pts.every((p, i) => i === 0 || p - pts[i - 1] >= gap)) return pts
  }
  // 实在排不开就均分
  return Array.from({ length: n }, (_, i) => a + Math.floor((span / n) * (i + 0.5)))
}

export function createQzone({ getConfig, onebot, hub, log, onDiary }) {
  const file = () => dataDir('diary.json')
  const state = () => readJson(file(), () => ({ plan: { day: '', times: [], done: [] }, history: [] }))
  const save = (s) => writeJson(file(), s)
  let busy = false

  async function post(content, { images = [], visibility } = {}) {
    const cfg = getConfig()
    const text = String(content || '').trim()
    if (!text) return { ok: false, message: '说说是空的' }
    const right = RIGHT[visibility || cfg.diary.visibility] || 1
    if (!cfg.enabled) return { ok: false, message: '总开关关着' }
    if (cfg.dryRun) {
      log.info(`试运行：本来要发说说（${visibility || cfg.diary.visibility}）：${text.slice(0, 60)}`)
      return { ok: true, tid: '', dryRun: true }
    }
    const imgs = []
    for (const src of images) {
      try {
        imgs.push('base64://' + (await fetchImage(src, { maxBytes: 8 * 1024 * 1024 })).toString('base64'))
      } catch (error) {
        log.warn('说说配图读不到，跳过：', error.message)
      }
    }
    try {
      const r = await onebot.call('send_qzone_msg', { content: text, ugc_right: right, ...(imgs.length ? { images: imgs } : {}) }, { timeoutMs: 60000 })
      const tid = String(r?.tid ?? r?.id ?? r ?? '')
      log.info(`发了一条说说（tid ${tid || '?'}）`)
      return { ok: true, tid }
    } catch (error) {
      log.warn('发说说失败：', error.message)
      return { ok: false, message: error.message }
    }
  }

  async function remove(tid) {
    return onebot.call('delete_qzone_msg', { tid: String(tid) })
  }

  function todayExcerpt(maxLines = 60) {
    const lines = hub.chatLogOf(dayKey())
      .filter((l) => !String(l.chatId).startsWith('system:'))
      .slice(-maxLines)
      .map((l) => `${new Date(l.t).toTimeString().slice(0, 5)} ${l.who === 'bot' ? '我' : l.who}：${l.text}`)
    return lines.join('\n')
  }

  /** 写一篇并发出去。 */
  async function writeDiary({ visibility } = {}) {
    if (busy) return { ok: false, message: '上一篇还在写' }
    busy = true
    try {
      const cfg = getConfig().diary
      const now = new Date()
      const excerpt = todayExcerpt()
      const prompt = [
        `【写空间日记】现在是 ${now.getMonth() + 1} 月 ${now.getDate()} 日 ${now.toTimeString().slice(0, 5)}。`,
        excerpt ? `今天你在 QQ 上的聊天片段（「我」是你自己）：\n${excerpt}` : '今天还没怎么聊天。',
        `请用你自己的口吻写一条 QQ 空间说说，第一人称，${cfg.minChars}~${cfg.maxChars} 个字，像真人随手发的动态：可以写今天发生的小事、心情、想吃的白米饭。`,
        '不要分条、不要 |||、不要 <voice>/<sticker> 标记、不要 Markdown、不要加引号，只输出说说正文本身。',
      ].join('\n\n')
      let text = await hub.runSystemTurn('diary', '空间日记', prompt)
      text = String(text || '').replace(/\|\|\|/g, ' ').replace(/<[^>]+>/g, '').replace(/^["「“]|["」”]$/g, '').trim()
      if (text.length > cfg.maxChars + 20) text = text.slice(0, cfg.maxChars + 20)
      if (!text || text === '[沉默]') return { ok: false, message: '她这次没写出来' }
      const r = await post(text, { visibility })
      const s = state()
      s.history.unshift({ at: Date.now(), text, ok: r.ok, tid: r.tid || '', dryRun: Boolean(r.dryRun), visibility: visibility || cfg.visibility, error: r.ok ? '' : r.message })
      s.history = s.history.slice(0, 100)
      save(s)
      if (r.ok && !r.dryRun) {
        try { onDiary?.(text) } catch (error) {}
      }
      return { ...r, text }
    } catch (error) {
      log.warn('写日记失败：', error.message)
      return { ok: false, message: error.message }
    } finally {
      busy = false
    }
  }

  /** 每分钟调一次。 */
  async function tick() {
    const cfg = getConfig()
    if (!cfg.enabled || !cfg.diary.enabled) return
    const s = state()
    const today = dayKey()
    if (s.plan.day !== today) {
      s.plan = { day: today, times: planDiaryTimes(cfg.diary), done: [] }
      save(s)
      log.info(`今天的日记时间：${s.plan.times.map((m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`).join('、') || '（不写）'}`)
    }
    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const due = s.plan.times.find((m) => m <= nowMin && !s.plan.done.includes(m))
    if (due === undefined) return
    s.plan.done.push(due)
    save(s)
    log.info('到点了，写一篇空间日记')
    await writeDiary()
  }

  function nextTime() {
    const s = state()
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
    const m = s.plan.day === dayKey() ? s.plan.times.find((x) => !s.plan.done.includes(x) && x >= nowMin) : undefined
    return m === undefined ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  }

  return { post, remove, writeDiary, tick, history: () => state().history, nextTime }
}
