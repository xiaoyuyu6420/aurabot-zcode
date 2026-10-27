// 开放 HTTP 接口的动作层（M5）：白名单动作 → 桥内能力。
// webpanel 的 POST /api/open 收到 {action, params, token} 后转到这里。
// 鉴权：面板口只监听 127.0.0.1（本机进程互访够用）；另发一个一次性生成的 token，
// 外部调用方（脚本、其他机器上的程序走 SSH 隧道）要带上它，token 在 workspace/open-token.json。

import { randomBytes } from 'node:crypto'
import { dataRoot, readJson, writeJson, ensureDir } from './core/store.js'
import { join } from 'node:path'
import { parseMessageEvent } from './chat/inbound.js'

/** token 懒生成：第一次取时写入文件，之后固定。 */
export function openToken() {
  const file = join(ensureDir(dataRoot()), 'open-token.json')
  const cur = readJson(file, () => null)
  if (cur?.token) return cur.token
  const token = randomBytes(24).toString('base64url')
  writeJson(file, { token, at: Date.now() })
  return token
}

export function checkToken(t) {
  const expect = openToken()
  return String(t || '') === expect
}

/**
 * @param {{hub, onebot, getConfig, zcode, app}} ctx 桥运行时
 * @returns {Promise<{ok:boolean, message?:string, ...}>}
 */
export async function runOpenAction(ctx, action, params = {}) {
  const { hub, onebot, getConfig } = ctx
  const cfg = getConfig()
  switch (action) {
    // —— 翻聊天记录（qq_chat_history 的后端；机器人号自己发的行标成「你」） ——
    case 'chat_history': {
      const [kind, id] = String(params.chatId || '').split(':')
      if (!['private', 'group'].includes(kind) || !/^\d{5,12}$/.test(String(id || ''))) return { ok: false, message: 'chatId 要形如 private:QQ号 或 group:群号' }
      const n = Math.max(1, Math.min(50, Number(params.count) || 20))
      const r = kind === 'group'
        ? await onebot.call('get_group_msg_history', { group_id: Number(id), count: n }, { timeoutMs: 15000 })
        : await onebot.call('get_friend_msg_history', { user_id: Number(id), count: n }, { timeoutMs: 15000 })
      const msgs = (r?.messages || []).slice(-n)
      if (!msgs.length) return { ok: true, lines: [] }
      const self = String(cfg.botQQ)
      const lines = msgs.map((m) => {
        const p = parseMessageEvent({ ...m, message_type: m.message_type || (kind === 'group' ? 'group' : 'private') }, self)
        const who = String(m.user_id ?? m.sender?.user_id) === self ? '你' : (m.sender?.card || m.sender?.nickname || String(m.user_id ?? ''))
        const t = m.time ? new Date(m.time * 1000).toTimeString().slice(0, 5) : ''
        return `${t} ${who}：${(p.text || '（图片/表情）').slice(0, 150)}`
      })
      return { ok: true, lines }
    }
    // —— 补发表情（拆条器之外的单独发送） ——
    case 'send_sticker': {
      const r = await hub.sendSticker(String(params.chatId || ''), String(params.name || ''))
      return r ? { ok: true } : { ok: false, message: '表情库里没找到合适的' }
    }
    // —— 白名单内主动发消息（主人私聊档才能用；拆条器支持 ||| / <voice> / <sticker:>） ——
    case 'send_message': {
      const [kind, id] = String(params.target || '').split(':')
      const okList = kind === 'group' ? cfg.allow.groups : kind === 'private' ? [cfg.ownerQQ, ...cfg.allow.private] : []
      if (!okList.includes(String(id))) return { ok: false, message: '不在白名单里，不能发' }
      await hub.deliver(`${kind}:${id}`, String(params.text || ''))
      return { ok: true, message: '发出去了' }
    }
    // —— B 站：看视频（不用登录） ——
    case 'bili_watch': {
      const bili = ctx.app?.biliModule
      if (!bili) return { ok: false, message: 'B 站模块没加载' }
      const w = await bili.watch(String(params.link || ''))
      return w
    }
    // —— 状态：外部脚本的健康检查 ——
    case 'status': {
      const s = await ctx.app.status()
      return { ok: true, enabled: s.enabled, dryRun: s.dryRun, onebot: s.onebot, loginOk: s.loginOk, stats: s.stats }
    }
    default:
      return { ok: false, message: `未知动作：${action}（可用：chat_history / send_sticker / send_message / bili_watch / status）` }
  }
}
