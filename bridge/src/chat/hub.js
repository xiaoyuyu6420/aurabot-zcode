// 消息中枢：QQ 会话 ⇄ zcode CLI 会话。
//   收：OneBot 事件 → 白名单 / 群聊策略 → 拼好文案（带发言人、群上下文、图片）→ 防抖合并 → 交给 zcode -p
//   发：CLI 一轮跑完 → 取 response → 拆条 / 语音 / 表情 → 发回原来的 QQ 会话
// 每个 QQ 聊天一个持久 CLI 会话（zcode.js 的会话表），跨重启不断。
//
// 会话驱动段是对照上游 hub.js 重写的；防抖 / 群聊策略 / 拆条 / 戳一戳 / 流水与上游同构。

import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { dataDir, writeJson } from '../core/store.js'
import { parseMessageEvent } from './inbound.js'
import { parseReply, bubbleDelay, wantsVoice } from './reply.js'
import { decideGroupReply, policyFor, topicRelevance } from './group-policy.js'
import { checkAllowed, isOwner } from './access.js'
import { fetchImage, segmentBytes } from '../core/net.js'
import { redact } from '../core/redact.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 可选件（M3 起逐个补）：stickers / tts / onCommand / isMuted / moodEffects / memoryScore / hooks
 * 没传就当没有，对应行为自动退回纯文本。
 */
// 模拟测试：这里面发出去的消息只记下来，不真发
const captureStore = new AsyncLocalStorage()
export function createHub({ zcode, getConfig, log, onebot, stickers, tts, onCommand, isMuted, moodEffects, memoryScore, onActivity, hooks }) {
  const mood = () => (typeof moodEffects === 'function' ? moodEffects() : null) || { sticker: 1, voice: 1, delay: 1, chatty: 1 }
  const groupBuf = new Map() // groupId → [{t, uid, nick, text, at, mid}]
  const groupInterjects = new Map() // groupId → [t]  她主动开口（插话、接话）的时间
  const groupSaid = new Map() // groupId → [t]  她每次在群里说话的时间（刹车用）
  const groupFedAt = new Map() // groupId → 上次把群消息交给她的时间
  const groupRefs = new Map() // groupId → { 编号: QQ 消息 ID }  上一段提示词里的编号，引用回复用
  const groupEngaged = new Map() // groupId → 加入话题到什么时候（毫秒）
  const ENGAGE_MS = 3 * 60_000
  const groupNames = new Map()
  const sentIds = new Set()
  let lastOwnerMsgAt = 0 // 最近一次主人说话的时间（模块鉴权用：5 分钟内算「这一轮有主人」）
  const recentMediaMap = new Map() // chatId → [{ seg, userId, at, sticker }] 最近发来的图片表情（主人让存表情时用）
  const stats = { received: 0, sent: 0, voice: 0, stickers: 0, errors: 0, day: new Date().toDateString() }
  let selfId = ''
  let lastChatAt = 0

  function bump(k) {
    const d = new Date().toDateString()
    if (stats.day !== d) Object.assign(stats, { received: 0, sent: 0, voice: 0, stickers: 0, errors: 0, day: d })
    stats[k]++
  }

  // ---------- 聊天流水（给记忆、主动搭话、status 用） ----------
  function logChat(chatId, who, text, uid = '') {
    try {
      const d = new Date()
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const dir = dataDir('chatlog')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, `${day}.jsonl`), JSON.stringify({ t: Date.now(), chatId, who, ...(uid ? { uid: String(uid) } : {}), text: redact(String(text).slice(0, 500)) }) + '\n', 'utf8')
    } catch (error) {}
  }

  /** 有聊天流水的日期（升序）——记忆整理、主动搭话用。 */
  function chatLogDays() {
    try {
      return readdirSync(dataDir('chatlog')).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).map((n) => n.slice(0, 10)).sort()
    } catch (error) {
      return []
    }
  }

  function deleteChatLog(day) {
    try { unlinkSync(join(dataDir('chatlog'), `${day}.jsonl`)) } catch (error) {}
  }

  function chatLogOf(day) {
    try {
      const f = join(dataDir('chatlog'), `${day}.jsonl`)
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch (error) {
      return []
    }
  }

  // ---------- 发到 QQ ----------
  function targetOf(chatId) {
    const [kind, id] = String(chatId).split(':')
    return kind === 'group' ? { kind: 'group', id } : kind === 'private' ? { kind: 'private', id } : null
  }

  async function sendSegments(chatId, message, note, { force = false } = {}) {
    const cfg = getConfig()
    const tgt = targetOf(chatId)
    if (!tgt) return null
    if (hooks?.send) {
      try {
        const next = await hooks.send(message, { chatId, note, force })
        if (next === null) { log.info(`扩展模块拦下了 → ${chatId}：${note}`); return null }
        if (Array.isArray(next)) message = next
      } catch (error) {
        log.warn('扩展模块改写发送内容出错：', error.message)
      }
    }
    const cap = captureStore.getStore()
    if (cap) {
      cap.push({ chatId, note, message })
      return { message_id: 'sim-' + cap.length }
    }
    if (force) {}
    else if (!cfg.enabled) {
      log.info(`总开关关着，没发 → ${chatId}：${note}`)
      return null
    }
    else if (cfg.dryRun) {
      log.info(`试运行（没真发）→ ${chatId}：${note}`)
      return null
    }
    const action = tgt.kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = tgt.kind === 'group' ? { group_id: Number(tgt.id), message } : { user_id: Number(tgt.id), message }
    try {
      const r = await onebot.call(action, params)
      if (r && r.message_id !== undefined) {
        sentIds.add(String(r.message_id))
        if (sentIds.size > 500) sentIds.delete(sentIds.values().next().value)
      }
      bump('sent')
      return r
    } catch (error) {
      bump('errors')
      log.warn(`发到 ${chatId} 失败：`, error.message)
      return null
    }
  }

  const quote = (replyId) => (replyId ? [{ type: 'reply', data: { id: String(replyId) } }] : [])

  async function sendText(chatId, text, replyId) {
    return sendSegments(chatId, [...quote(replyId), { type: 'text', data: { text } }], (replyId ? '[引用] ' : '') + text.slice(0, 60))
  }

  async function sendVoice(chatId, text) {
    if (!tts?.speak) return sendText(chatId, text)
    try {
      const { file, engine } = await tts.speak(text)
      const b64 = readFileSync(file).toString('base64')
      const r = await sendSegments(chatId, [{ type: 'record', data: { file: 'base64://' + b64 } }], `[语音·${engine}] ${text.slice(0, 40)}`)
      if (r || getConfig().dryRun || !getConfig().enabled) bump('voice')
      if (!r && getConfig().enabled && !getConfig().dryRun) throw new Error('网关没接受语音')
      return true
    } catch (error) {
      log.warn('语音没发出去，改发文字：', error.message)
      await sendText(chatId, text)
      return false
    }
  }

  /** 戳回去：私聊戳对方，群里戳最近戳她的人（没人戳过就戳这一段最后说话的人）。 */
  async function pokeBack(chatId) {
    const cfg = getConfig()
    const group = chatId.startsWith('group:') ? chatId.slice(6) : ''
    const target = group ? lastPoker.get(chatId) || lastSpeaker.get(chatId) : chatId.slice(8)
    if (!target) return
    if (!cfg.enabled || cfg.dryRun) return log.info(`试运行（没真戳）→ ${chatId}：戳了戳 ${target}`)
    try {
      await onebot.call('send_poke', { user_id: Number(target), ...(group ? { group_id: Number(group) } : {}) }, { timeoutMs: 10000 })
      log.info(`${chatId}：她戳了戳 ${target}`)
    } catch (error) {
      log.debug('戳一戳失败：', error.message)
    }
  }

  async function sendSticker(chatId, query, replyId) {
    if (!stickers?.match) return false
    const item = query && typeof query === 'object' ? query : stickers.match(query)
    if (!item) {
      log.debug(`没找到「${query}」这张表情，跳过`)
      return false
    }
    const seg = stickers.segmentFor(item)
    if (!seg) return false
    await sendSegments(chatId, [...quote(replyId), seg], `[表情] ${item.name || item.md5.slice(0, 8)}`)
    stickers.markUsed?.(item.md5)
    bump('stickers')
    return true
  }

  async function sendImage(chatId, src) {
    try {
      const buf = await fetchImage(src, { maxBytes: 10 * 1024 * 1024 })
      return sendSegments(chatId, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], `[图片] ${src.slice(-40)}`)
    } catch (error) {
      log.warn('图片发不出去：', error.message)
      return null
    }
  }

  /** 一轮回复落地：拆条、语音、表情。 */
  async function deliver(chatId, text, opts = {}) {
    const cfg = getConfig()
    if (hooks?.reply) {
      try {
        const next = await hooks.reply(text, { chatId, userText: opts.userText || '' })
        if (next === null) return log.info(`${chatId}：扩展模块拦下了这次回复`)
        if (typeof next === 'string') text = next
      } catch (error) {
        log.warn('扩展模块改写回复出错：', error.message)
      }
    }
    const r = parseReply(text)
    if (r.silent) {
      log.info(`${chatId}：她选择不说话`)
      if (chatId.startsWith('group:')) groupEngaged.delete(chatId.slice(6))
      return
    }
    let items = r.items
    // 对方明确要语音、她却只打了字：整段改成语音发（语音模块 M3 接入）
    if (opts.wantVoice && tts?.speak && !items.some((i) => i.kind === 'voice')) {
      const spoken = items.filter((i) => i.kind === 'text').map((i) => i.value).join('，')
      if (spoken && spoken.length <= 300) items = [{ kind: 'voice', value: spoken }, ...items.filter((i) => i.kind !== 'text')]
    }
    const inGroup = chatId.startsWith('group:')
    // 群里别刷屏：一段最多 3 条
    if (inGroup && items.length > 3) items = items.slice(0, 3)
    // 按概率补一张表情（群里已有两条以上就不补了；autoChance × 心情系数）
    {
      const texts = items.filter((i) => i.kind === 'text')
      const cfg = getConfig()
      const chance = (cfg.stickers2?.autoChance ?? 0.35) * mood().sticker
      if (stickers?.pickForReply && !items.some((i) => i.kind === 'sticker') && !(inGroup && items.length >= 2) && Math.random() < chance) {
        const pick = stickers.pickForReply(texts.map((t) => t.value).join(' '))
        if (pick) items.push({ kind: 'sticker', value: pick })
      }
    }
    if (hooks?.items) {
      try {
        const next = await hooks.items(items, { chatId, text, userText: opts.userText || '' })
        if (next === null) return log.info(`${chatId}：扩展模块拦下了这次回复`)
        if (Array.isArray(next)) items = next
      } catch (error) {
        log.warn('扩展模块改写回复出错：', error.message)
      }
    }
    // 引用回复：她写的编号换成那条群消息的 QQ 消息 ID（语音条不能带引用，就不引用了）
    const refs = inGroup ? groupRefs.get(chatId.slice(6)) || {} : {}
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      const replyId = it.replyTo ? refs[it.replyTo] : undefined
      if (it.replyTo && !replyId) log.debug(`${chatId}：引用的编号 ${it.replyTo} 对不上，正常发`)
      if (it.kind === 'text') await sendText(chatId, it.value, replyId)
      else if (it.kind === 'voice') await sendVoice(chatId, it.value)
      else if (it.kind === 'sticker') await sendSticker(chatId, it.value, replyId)
      else if (it.kind === 'poke') { if (!opts.simulate) await pokeBack(chatId) }
      else if (it.kind === 'image') await sendImage(chatId, it.value)
      if (i < items.length - 1 && !opts.simulate) await sleep(bubbleDelay(items[i + 1].kind === 'text' ? items[i + 1].value : '') * mood().delay)
    }
    if (opts.simulate) return items
    if (inGroup) {
      const gid = chatId.slice(6)
      const said = (groupSaid.get(gid) || []).filter((t) => Date.now() - t < 3600_000)
      said.push(Date.now())
      groupSaid.set(gid, said)
      groupEngaged.set(gid, Date.now() + ENGAGE_MS)
    }
    logChat(chatId, 'bot', items.map((i) => (i.kind === 'text' || i.kind === 'voice' ? i.value : `[${i.kind}]`)).join(' '))
    lastChatAt = Date.now()
    onActivity?.({ kind: 'out', chatId, reply: text, userText: opts.userText || '' })
  }

  // ---------- 收 QQ ----------
  async function groupName(gid) {
    if (groupNames.has(gid)) return groupNames.get(gid)
    try {
      const info = await onebot.call('get_group_info', { group_id: Number(gid) })
      if (info?.group_name) groupNames.set(gid, info.group_name)
    } catch (error) {}
    return groupNames.get(gid) || gid
  }

  async function repliedToBot(replyId) {
    if (!replyId) return false
    if (sentIds.has(replyId)) return true
    try {
      const m = await onebot.call('get_msg', { message_id: Number(replyId) || replyId }, { timeoutMs: 5000 })
      return String(m?.sender?.user_id ?? m?.user_id ?? '') === String(selfId || getConfig().botQQ)
    } catch (error) {
      return false
    }
  }

  async function imagesOf(msg) {
    const out = []
    for (const seg of [...(msg.stickers || []), ...(msg.images || [])].slice(0, 4)) {
      try {
        const buf = await segmentBytes(seg, onebot, { maxBytes: 8 * 1024 * 1024 })
        out.push(buf.toString('base64'))
      } catch (error) {
        log.debug('图片下载失败：', error.message)
      }
    }
    return out
  }

  async function onMessage(event) {
    selfId = String(event.self_id || selfId || getConfig().botQQ)
    const cfg = getConfig()
    const msg = parseMessageEvent(event, selfId)
    if (msg.userId === selfId) return
    bump('received')
    const now = Date.now()

    // 群里的每条消息都记进缓冲（给上下文和「群里在不在聊」用）
    if (msg.kind === 'group') {
      const buf = groupBuf.get(msg.groupId) || []
      buf.push({ t: now, uid: msg.userId, nick: msg.nickname, text: msg.text, at: msg.mentioned, mid: msg.messageId })
      while (buf.length > 40) buf.shift()
      groupBuf.set(msg.groupId, buf)
    }

    const allowed = checkAllowed(cfg, msg)
    // 最近发来的图片/表情记几张（「存一下这个表情」时用）
    if (msg.stickers.length || msg.images.length) {
      const list = (recentMediaMap.get(msg.chatId) || []).filter((x) => now - x.at < 30 * 60_000)
      for (const seg of [...msg.stickers, ...msg.images]) list.push({ seg, userId: msg.userId, at: now, sticker: msg.stickers.includes(seg) })
      recentMediaMap.set(msg.chatId, list.slice(-6))
    }
    // 偷表情：只从白名单里的会话偷（表情包模块 M3 接入）
    if (allowed.allowed && msg.stickers.length && stickers?.collect) {
      for (const s of msg.stickers) stickers.collect(s, msg.chatId).then((r) => { if (!r.ok) log.debug('没收这张表情：', r.reason) }).catch(() => {})
    }
    if (!allowed.allowed) {
      log.debug(`忽略 ${msg.chatId}（${allowed.reason}）`)
      return
    }
    // 主人命令（/silent /active …）：总开关关着也处理，回复直接发
    if (onCommand && isOwner(cfg, msg.userId) && /^\s*[/／]/.test(msg.text)) {
      try {
        const reply = await onCommand(msg)
        if (reply) {
          log.info(`主人命令 ${msg.text.trim().slice(0, 30)} → ${reply.split('\n')[0]}`)
          await sendSegments(msg.chatId, [{ type: 'text', data: { text: reply } }], reply.slice(0, 60), { force: true })
          return
        }
      } catch (error) {
        log.warn('执行命令出错：', error.message)
        await sendSegments(msg.chatId, [{ type: 'text', data: { text: '命令没执行成功：' + error.message } }], '命令出错', { force: true })
        return
      }
    }
    if (!getConfig().enabled) {
      log.info(`总开关关着，收到 ${msg.chatId} 的消息但不处理：${msg.text.slice(0, 30)}`)
      return
    }

    if (isMuted?.(msg.chatId)) {
      log.debug(`${msg.chatId}：主人让她闭嘴中，不回`)
      logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
      return
    }

    // 扩展模块可以先接管这条消息
    if (hooks?.message) {
      try {
        if (await hooks.message({ ...msg, raw: event })) {
          logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
          return
        }
      } catch (error) {
        log.warn('扩展模块处理消息出错：', error.message)
      }
    }

    let mode = 'must'
    if (msg.kind === 'group') {
      const pol0 = policyFor(cfg.group, cfg.group.overrides, msg.groupId)
      const pol = { ...pol0, interjectChance: Math.min(1, pol0.interjectChance * mood().chatty) }
      const recentTexts = (groupBuf.get(msg.groupId) || []).filter((x) => now - x.t < pol.activeWindowSec * 1000).slice(-6).map((x) => x.text)
      let memScore = 0
      try { memScore = typeof memoryScore === 'function' ? memoryScore(recentTexts.join(' ')) : 0 } catch (error) {}
      const decision = decideGroupReply({
        policy: pol,
        relevance: topicRelevance(recentTexts, pol.interests, memScore),
        engagedUntil: groupEngaged.get(msg.groupId) || 0,
        mentioned: msg.mentioned,
        repliedToBot: await repliedToBot(msg.replyId),
        fromOwner: isOwner(cfg, msg.userId),
        text: msg.text,
        now,
        hour: new Date().getHours(),
        recentTimes: (groupBuf.get(msg.groupId) || []).map((x) => x.t),
        interjectTimes: groupInterjects.get(msg.groupId) || [],
        botReplyTimes: groupSaid.get(msg.groupId) || [],
      })
      if (hooks?.groupDecide) {
        try {
          const next = await hooks.groupDecide(decision, { msg, policy: pol, recentTexts, memScore })
          if (next && typeof next === 'object') Object.assign(decision, next)
        } catch (error) {
          log.warn('扩展模块改群聊决定出错：', error.message)
        }
      }
      if (!decision.reply) {
        log.debug(`群 ${msg.groupId}：不回（${decision.reason}）`)
        logChat(msg.chatId, msg.nickname, msg.text, msg.userId)
        if (pending.has(msg.chatId)) await addGroupImages(msg)
        return
      }
      mode = decision.mode
      log.info(`群 ${msg.groupId}：${decision.reason} → 交给她`)
    }

    // 拼文案
    let text = msg.text
    if (msg.forwards?.length) {
      text = await expandForwards(msg, text)
      if (msg.kind === 'group') {
        const last = (groupBuf.get(msg.groupId) || []).findLast?.((x) => x.uid === msg.userId)
        if (last) last.text = text
      }
    }
    if (msg.records.length) text = (text ? text + ' ' : '') + '[发来一条语音，没听清]'
    const content = msg.kind === 'group' ? [] : [{ type: 'text', text: `【私聊】${msg.nickname}(${msg.userId})：` + (text || '（没有文字）') }]
    const imgs = await imagesOf(msg)
    for (const data of imgs) content.push({ type: 'image', data })
    logChat(msg.chatId, msg.nickname, text, msg.userId)
    lastChatAt = now
    if (isOwner(cfg, msg.userId)) lastOwnerMsgAt = now
    onActivity?.({ kind: 'in', chatId: msg.chatId, userId: msg.userId, nickname: msg.nickname, text, direct: msg.kind === 'private' || msg.mentioned || mode === 'must', owner: isOwner(cfg, msg.userId) })

    enqueue({ chatId: msg.chatId, kind: msg.kind, userId: msg.userId, groupId: msg.groupId, nickname: msg.nickname }, content, msg.userId, wantsVoice(msg.text), mode)
  }

  /** 把消息里的「[合并转发]」换成里面的聊天记录（最多 40 条，嵌套的转发不再展开）。 */
  async function expandForwards(msg, text) {
    let out = text
    for (const id of msg.forwards.slice(0, 2)) {
      let lines = []
      try {
        const r = await onebot.call('get_forward_msg', { id }, { timeoutMs: 15000 })
        for (const node of (r?.messages || []).slice(0, 40)) {
          const who = node.sender?.card || node.sender?.nickname || String(node.sender?.user_id ?? node.user_id ?? '某人')
          const m = parseMessageEvent({ message_type: 'private', user_id: node.sender?.user_id ?? node.user_id, message: node.message ?? node.content ?? [] }, selfId)
          lines.push(`  ${who}：${(m.text || '（图片/表情）').slice(0, 120)}`)
        }
      } catch (error) {
        log.debug('拉合并转发失败：', error.message)
      }
      const body = lines.length ? `[合并转发的聊天记录（${lines.length} 条）]\n${lines.join('\n').slice(0, 2000)}\n[转发结束]` : '[合并转发（内容没拉到）]'
      out = out.replace('[合并转发]', body)
    }
    return out
  }

  // ---------- 戳一戳 ----------
  const lastPoker = new Map() // chatId → 最近戳她的人（她戳回去用）
  const lastSpeaker = new Map() // chatId → 群里最近一段最后说话的人
  const pokeAt = new Map() // chatId → 上次处理戳一戳的时间
  /** 有人戳了她：当成一条对她说的话交给她（群里也一定回），同一个聊天 20 秒内只算一次。 */
  async function onPoke(ev) {
    const self = String(ev.self_id || selfId || getConfig().botQQ)
    if (String(ev.target_id) !== self) return
    if (hooks?.poke) {
      try { if (await hooks.poke(ev)) return } catch (error) {}
    }
    const group = ev.group_id ? String(ev.group_id) : ''
    const poker = String(group ? ev.user_id : ev.sender_id ?? ev.user_id)
    if (!poker || poker === self) return
    const chatId = group ? `group:${group}` : `private:${poker}`
    lastPoker.set(chatId, poker)
    if (Date.now() - (pokeAt.get(chatId) || 0) < 20_000) return
    pokeAt.set(chatId, Date.now())
    let nickname = poker
    try {
      const info = group ? await onebot.call('get_group_member_info', { group_id: Number(group), user_id: Number(poker) }, { timeoutMs: 5000 }) : await onebot.call('get_stranger_info', { user_id: Number(poker) }, { timeoutMs: 5000 })
      nickname = info?.card || info?.nickname || poker
    } catch (error) {}
    log.info(`${chatId}：${nickname} 戳了戳她`)
    await onMessage({
      post_type: 'message', message_type: group ? 'group' : 'private', sub_type: group ? 'normal' : 'friend',
      self_id: Number(self), user_id: Number(poker), ...(group ? { group_id: Number(group) } : {}), message_id: 0,
      sender: { user_id: Number(poker), nickname, card: nickname },
      message: [{ type: 'at', data: { qq: self } }, { type: 'text', data: { text: ` [戳了戳你${ev.action ? '：' + ev.action + (ev.suffix || '') : ''}]` } }],
    })
  }

  /** 没触发回复的群消息带的图：如果正有一段在等她回，把图也带上（最多 4 张）。 */
  async function addGroupImages(msg) {
    const p = pending.get(msg.chatId)
    if (!p || p.images.length >= 4) return
    try {
      const imgs = await imagesOf(msg)
      for (const data of imgs) if (p.images.length < 4) p.images.push(data)
    } catch (error) {}
  }

  /** 群聊这一段的提示词：之前的几句当背景，上次交给她之后群里新说的话全部列出来。 */
  async function groupPrompt(chat, mode) {
    const name = await groupName(chat.groupId)
    const buf = groupBuf.get(chat.groupId) || []
    const since = groupFedAt.get(chat.groupId) || 0
    const fresh = buf.filter((x) => x.t > since).slice(-20)
    const older = buf.filter((x) => x.t <= since).slice(-8)
    groupFedAt.set(chat.groupId, Date.now())
    const line = (x) => `${x.nick}(${x.uid})${x.at ? '@了你' : ''}：${x.text || '（图片/表情）'}`
    // 新消息带编号，她想专门回某一条时可以引用；编号 → QQ 消息 ID 记下来，发的时候换成引用
    const refs = {}
    const numbered = fresh.map((x, i) => {
      if (x.mid) refs[i + 1] = x.mid
      return `[${i + 1}] ${line(x)}`
    })
    groupRefs.set(chat.groupId, refs)
    const speakers = [...new Set(fresh.map((x) => String(x.uid)).filter(Boolean))]
    const hint = mode === 'interject' ? '（没人叫你。只有你对这个话题真有话说、能自然接上时才插一句：接着话题说，别突然开新话题；接不上就只回 [沉默]）'
      : mode === 'engaged' ? '（你刚才在参与这个话题。想接着聊就接着说，话题和你没关系了或没什么可说的就只回 [沉默]）'
      : '（有人在叫你，看完这一段再回）'
    const text = (older.length ? `【群聊 ${name}】之前在聊：\n${older.map(line).join('\n')}\n\n` : '') +
      `【群聊 ${name}】刚才新说的（${fresh.length} 条）${hint}\n${numbered.join('\n')}\n\n` +
      '把这一段当成整体来回：一般说一两句就好，回给最需要回的那个人或者整个话题，不要一条一条地挨个回。\n' +
      '大多数时候直接说就行。只有想专门接其中某一条、而直接说别人会看不出你在回谁时，才在那句话开头写 <reply:编号>，会以「引用回复」发出；一次最多引用一条。'
    return { text, speakers }
  }

  // ---------- 连发合并：人常常一口气发好几句，等对方说完再一起交给她，别一句一回 ----------
  // 群聊再加一层：她正在回上一段时，新消息先攒着，等她说完再一起交给她
  const pending = new Map() // chatId → { chat, texts, images, senders, wantVoice, timer, firstAt, mode, count }
  const busy = new Map() // chatId → 这一轮开始的时间（她正在想 / 正在发）
  const BUSY_MAX_MS = 6 * 60_000 // 卡住保护：超过这么久就当她已经回完了
  const RANK = { engaged: 1, interject: 2, must: 3 }
  const isBusy = (chatId) => busy.has(chatId) && Date.now() - busy.get(chatId) < BUSY_MAX_MS

  function enqueue(chat, content, senderId, wantVoice, mode = 'must') {
    const m = getConfig().merge
    const p = pending.get(chat.chatId) || { chat, texts: [], images: [], senders: new Set(), wantVoice: false, timer: null, firstAt: Date.now(), mode, count: 0 }
    p.chat = chat
    p.count++
    if ((RANK[mode] || 3) > (RANK[p.mode] || 3)) p.mode = mode
    for (const c of content) {
      if (c.type === 'text') p.texts.push(c.text)
      else if (c.type === 'image' && p.images.length < 4) p.images.push(c.data)
    }
    if (senderId) p.senders.add(String(senderId))
    p.wantVoice = p.wantVoice || wantVoice
    pending.set(chat.chatId, p)
    clearTimeout(p.timer)
    if (!m.enabled) return flush(chat.chatId)
    // 群里大家一来一回说得慢，多等一会儿把一段话攒齐
    const group = chat.kind === 'group'
    const wait = (group ? m.groupWaitSec : m.waitSec) * 1000
    const max = (group ? m.groupMaxSec : m.maxSec) * 1000
    const left = Math.max(0, max - (Date.now() - p.firstAt))
    p.timer = setTimeout(() => flush(chat.chatId), Math.min(wait, left))
  }

  async function flush(chatId) {
    const p = pending.get(chatId)
    if (!p) return
    clearTimeout(p.timer)
    // 她还在回上一段：先攒着，回完了再交（release 会叫 flush）
    if (isBusy(chatId)) {
      p.waiting = true
      return
    }
    pending.delete(chatId)
    if (p.count > 1) log.info(`${chatId}：合并了 ${p.count} 条消息一起交给她`)
    let text
    let files = []
    if (p.chat.kind === 'group') {
      const gid = p.chat.groupId
      if (p.mode === 'interject') {
        const arr = (groupInterjects.get(gid) || []).filter((t) => Date.now() - t < 3600_000)
        arr.push(Date.now())
        groupInterjects.set(gid, arr)
      }
      const gp = await groupPrompt(p.chat, p.mode)
      if (gp.speakers.length) lastSpeaker.set(chatId, [...p.senders].pop() || gp.speakers.at(-1))
      text = gp.text
    } else {
      text = p.texts.join('\n')
    }
    for (const data of p.images) {
      try { files.push(zcode.stageAttachment(`qq-${Date.now()}`, data)) } catch (error) { log.debug('图片落盘失败：', error.message) }
    }
    // 队列快照（观察 / 排错用；消费在本进程内）
    writeQueueSnapshot(chatId, { chat: p.chat, mode: p.mode, count: p.count, text: redact(text).slice(0, 2000), images: files.length, at: Date.now() })
    busy.set(chatId, Date.now())
    try {
      await pushTurn(chatId, text, files, { wantVoice: p.wantVoice, userText: p.texts.join('\n').slice(-600) })
    } catch (error) {
      bump('errors')
      log.error(`转进 ZCode 失败（${chatId}）：`, error.message)
      await sendText(chatId, '（这会儿没回上，等下再找我）').catch(() => {})
    } finally {
      for (const f of files) { try { rmSync(f, { force: true }) } catch (error) {} }
      release(chatId)
    }
  }

  /** 队列快照：queue/<chatId>.json，写完这一轮覆盖下一轮。（Windows 文件名不能带冒号） */
  function writeQueueSnapshot(chatId, snap) {
    try { writeJson(dataDir('queue', `${String(chatId).replace(/[^\w.-]/g, '_')}.json`), snap) } catch (error) {}
  }

  /** 她这一轮说完了（或者没说）：放开，把这期间攒下的消息交给她。 */
  function release(chatId) {
    busy.delete(chatId)
    const p = pending.get(chatId)
    if (p && p.waiting) {
      p.waiting = false
      flush(chatId).catch(() => {})
    }
  }

  /** 交给 zcode CLI：跑一轮，回复按 QQ 的格式拆条发出去。 */
  async function pushTurn(chatId, text, files, opts = {}) {
    // M3：心情 + 记忆的按轮注入（CLI 驱动下用「提示词前缀」代替上游的 systemPrompt.context）
    if (hooks?.contextInject) {
      try {
        const ctx = await hooks.contextInject({ chatId, text })
        if (ctx) text = ctx + '\n' + text
      } catch (error) {
        log.debug('上下文注入失败：', error.message)
      }
    }
    if (hooks?.prompt) {
      try {
        const next = await hooks.prompt(text, { chatId, files, ...opts })
        if (next === null) {
          log.info(`${chatId}：扩展模块决定这次不交给她`)
          return
        }
        if (typeof next === 'string') text = next
      } catch (error) {
        log.warn('扩展模块改提示词出错：', error.message)
      }
    }
    startTyping(chatId)
    const r = await zcode.turn(chatId, text, { files })
    stopTyping(chatId)
    const cap = captureStore.getStore()
    await deliver(chatId, r.text, { wantVoice: opts.wantVoice, userText: opts.userText || '', simulate: Boolean(cap) })
  }

  // 私聊里等她回复时，在 QQ 上显示「对方正在输入…」
  const typing = new Map() // chatId → timer
  function startTyping(chatId) {
    const cfg = getConfig()
    if (!chatId.startsWith('private:') || !cfg.enabled || cfg.dryRun || typing.has(chatId)) return
    const uid = chatId.slice(8)
    const ping = () => onebot.call('set_input_status', { user_id: Number(uid), event_type: 1 }, { timeoutMs: 5000 }).catch(() => {})
    ping()
    const started = Date.now()
    const t = setInterval(() => {
      if (Date.now() - started > 8 * 60_000) return stopTyping(chatId)
      ping()
    }, 15_000)
    t.unref?.()
    typing.set(chatId, t)
  }
  function stopTyping(chatId) {
    const t = typing.get(chatId)
    if (t) clearInterval(t)
    typing.delete(chatId)
  }

  /** 只让一个聊天重新开始：忘掉它的 CLI 会话，下一条消息开新会话。 */
  function resetChat(chatId) {
    return zcode.forget(chatId)
  }

  /** 重新开始：所有聊天的 CLI 会话都忘掉（会话本体还在 CLI 的存储里，不删数据）。 */
  function resetSessions() {
    return zcode.forgetAll()
  }

  /** 模拟测试：fn 里发出去的消息都记下来不真发，返回 { result, sent }。 */
  async function capture(fn) {
    const sent = []
    const result = await captureStore.run(sent, fn)
    return { result, sent }
  }

  /** 等流水线排空（防抖队列 + 正在跑的回合都结束）。sim 用它等到回复真的生成完。 */
  function idle() {
    return new Promise((resolve) => {
      const t = setInterval(() => {
        if (pending.size === 0 && busy.size === 0 && zcode.running === 0) {
          clearInterval(t)
          resolve()
        }
      }, 200)
    })
  }

  return {
    capture,
    idle,
    onMessage,
    onPoke,
    deliver,
    sendText,
    sendVoice,
    sendSticker,
    sendImage,
    sendSegments,
    resetChat,
    resetSessions,
    logChat,
    sessions: () => zcode.sessions(),
    groupName,
    stats: () => ({ ...stats }),
    /** 收尾：清掉防抖和 typing 的计时器，让进程能干净退出。 */
    stop() {
      for (const [, p] of pending) { clearTimeout(p.timer); p.waiting = false }
      for (const [k] of typing) stopTyping(k)
    },
    get lastChatAt() { return lastChatAt },
    /** 这一「轮」里主人说过话吗——CLI 驱动下用时间窗口近似（5 分钟内主人发过消息）。 */
    turnHasOwner(chatId, windowMs = 5 * 60_000) { return Date.now() - lastOwnerMsgAt < windowMs },
    recentMedia: (chatId, userId) => (recentMediaMap.get(String(chatId)) || []).filter((x) => !userId || x.userId === String(userId)),
    chatLogOf, chatLogDays, deleteChatLog,
    get selfId() { return selfId },
    groupNames,
  }
}
