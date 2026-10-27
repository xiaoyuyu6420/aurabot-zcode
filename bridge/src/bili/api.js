// B 站网页端接口：搜视频、看视频信息 / 字幕 / 评论、发评论、看别人的回复。
// 登录靠用户在面板里填的 Cookie（SESSDATA、bili_jct）；部分接口要 WBI 签名，buvid3 没有就自己申请一个。
// 只做看和评论，不碰改资料、关注、私信这类账号层面的操作。

import { createHash } from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]

/** 把用户粘贴的 Cookie 解析成键值；只认 B 站用得到的几个。 */
export function parseCookie(raw) {
  const out = {}
  for (const part of String(raw || '').split(/;\s*/)) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    if (['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4', 'DedeUserID__ckMd5', 'sid'].includes(k)) out[k] = part.slice(i + 1).trim()
  }
  return out
}

/** WBI 签名：按 mixin 表从两段 key 里取出 32 位，参数排序后连上它取 md5。 */
export function wbiSign(params, imgKey, subKey, now = Date.now()) {
  const raw = imgKey + subKey
  const mixin = MIXIN.map((i) => raw[i]).join('').slice(0, 32)
  const p = { ...params, wts: Math.round(now / 1000) }
  const query = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return query + '&w_rid=' + createHash('md5').update(query + mixin).digest('hex')
}

/** 从链接或文字里认出视频号：BV 号、av 号、b23.tv 短链（短链要先跳转）。 */
export function findVideoId(text) {
  const s = String(text || '')
  const bv = s.match(/\b(BV[0-9A-Za-z]{10})\b/)
  if (bv) return { bvid: bv[1] }
  const av = s.match(/\bav(\d{3,})\b/i)
  if (av) return { aid: av[1] }
  const short = s.match(/https?:\/\/b23\.tv\/[0-9A-Za-z]+/)
  if (short) return { short: short[0] }
  return null
}

const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")

export function createBiliApi({ getCookie, log, fetchImpl = fetch }) {
  let wbi = null // { img, sub, at }
  let buvid = ''

  function cookieHeader() {
    const c = parseCookie(getCookie())
    if (!c.buvid3 && buvid) c.buvid3 = buvid
    return Object.entries(c).map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async function req(url, { method = 'GET', form, timeoutMs = 20000 } = {}) {
    const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com', cookie: cookieHeader() }
    let body
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(form).toString()
    }
    const r = await fetchImpl(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) })
    const j = await r.json().catch(() => ({ code: r.status, message: 'HTTP ' + r.status }))
    if (j.code !== 0) {
      const e = new Error(`B 站返回 ${j.code}${j.message ? '：' + j.message : ''}`)
      e.code = j.code
      throw e
    }
    return j.data
  }

  /** 没有 buvid3 时申请一个（搜索等接口没有它会被风控）。 */
  async function ensureBuvid() {
    if (buvid || parseCookie(getCookie()).buvid3) return
    try {
      const d = await req('https://api.bilibili.com/x/frontend/finger/spi')
      buvid = d.b_3 || ''
    } catch (error) {
      log?.debug('申请 buvid 失败：', error.message)
    }
  }

  /** 登录状态 + WBI 签名用的 key（没登录也能拿到 key）。 */
  async function nav() {
    const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie: cookieHeader() }
    const r = await fetchImpl('https://api.bilibili.com/x/web-interface/nav', { headers, signal: AbortSignal.timeout(15000) })
    const j = await r.json()
    const d = j.data || {}
    const key = (u) => String(u || '').split('/').pop().split('.')[0]
    if (d.wbi_img) wbi = { img: key(d.wbi_img.img_url), sub: key(d.wbi_img.sub_url), at: Date.now() }
    return { isLogin: Boolean(d.isLogin), uname: d.uname || '', mid: d.mid || 0 }
  }

  async function signed(base, params) {
    if (!wbi || Date.now() - wbi.at > 6 * 3600_000) await nav()
    if (!wbi) throw new Error('拿不到 B 站的签名 key')
    return base + '?' + wbiSign(params, wbi.img, wbi.sub)
  }

  /** 搜视频：[{bvid, aid, title, author, play, pubdate, duration, desc}] */
  async function search(keyword, { page = 1 } = {}) {
    await ensureBuvid()
    const d = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/search/type', { search_type: 'video', keyword, page }))
    return (d.result || []).map((v) => ({
      bvid: v.bvid, aid: v.aid, title: stripHtml(v.title), author: v.author, play: Number(v.play) || 0, pubdate: (v.pubdate || 0) * 1000, duration: v.duration, desc: stripHtml(v.description).slice(0, 200),
    }))
  }

  /** 热门视频。 */
  async function popular({ ps = 20 } = {}) {
    await ensureBuvid()
    const d = await req(`https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=1`)
    return (d.list || []).map((v) => ({ bvid: v.bvid, aid: v.aid, title: v.title, author: v.owner?.name, play: v.stat?.view || 0, pubdate: (v.pubdate || 0) * 1000, desc: String(v.desc || '').slice(0, 200) }))
  }

  /** 视频信息。 */
  async function view({ bvid, aid }) {
    await ensureBuvid()
    // 不签名的旧接口经常被风控（412），用 WBI 签名的那个
    const d = await req(await signed('https://api.bilibili.com/x/web-interface/wbi/view', bvid ? { bvid } : { aid }))
    return {
      bvid: d.bvid, aid: d.aid, cid: d.cid, title: d.title, desc: String(d.desc || '').slice(0, 600), author: d.owner?.name, authorMid: d.owner?.mid,
      play: d.stat?.view || 0, like: d.stat?.like || 0, reply: d.stat?.reply || 0, pubdate: (d.pubdate || 0) * 1000, duration: d.duration, tname: d.tname,
    }
  }

  /** 字幕全文（优先中文；AI 字幕要登录才有）。拿不到返回 ''。 */
  async function subtitle({ bvid, aid, cid }) {
    try {
      const d = await req(await signed('https://api.bilibili.com/x/player/wbi/v2', { ...(bvid ? { bvid } : { aid }), cid }))
      const list = d.subtitle?.subtitles || []
      const pick = list.find((s) => /zh|中文/.test(s.lan + s.lan_doc)) || list[0]
      if (!pick?.subtitle_url) return ''
      const url = pick.subtitle_url.startsWith('//') ? 'https:' + pick.subtitle_url : pick.subtitle_url
      const r = await fetchImpl(url, { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' }, signal: AbortSignal.timeout(15000) })
      const j = await r.json()
      return (j.body || []).map((x) => x.content).join(' ')
    } catch (error) {
      log?.debug('拿字幕失败：', error.message)
      return ''
    }
  }

  /** 热门评论：[{rpid, name, mid, text, like, replies}] */
  async function comments(aid, { limit = 12 } = {}) {
    const d = await req(await signed('https://api.bilibili.com/x/v2/reply/wbi/main', { type: 1, oid: aid, mode: 3, plat: 1, web_location: 1315875 }))
    return (d.replies || []).slice(0, limit).map((r) => ({ rpid: r.rpid, name: r.member?.uname, mid: r.mid, text: String(r.content?.message || '').slice(0, 200), like: r.like, replies: r.rcount || 0 }))
  }

  /** 发评论；root/parent 不传就是一级评论。要登录。 */
  async function postComment(aid, message, { root, parent } = {}) {
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw new Error('没登录 B 站（Cookie 里要有 bili_jct）')
    const d = await req('https://api.bilibili.com/x/v2/reply/add', { method: 'POST', form: { type: 1, oid: aid, message, plat: 1, csrf, ...(root ? { root, parent: parent || root } : {}) } })
    return { rpid: d.rpid }
  }

  /** 点赞视频。要登录。 */
  async function likeVideo(aid) {
    const csrf = parseCookie(getCookie()).bili_jct
    if (!csrf) throw new Error('没登录 B 站')
    await req('https://api.bilibili.com/x/web-interface/archive/like', { method: 'POST', form: { aid, like: 1, csrf } })
  }

  /** 别人回复她的消息：[{id, time, name, mid, text, myText, oid, root, parent, title, uri}] */
  async function replyFeed() {
    const d = await req('https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web')
    return (d.items || []).map((x) => ({
      id: String(x.id), time: (x.reply_time || 0) * 1000, name: x.user?.nickname, mid: x.user?.mid,
      text: String(x.item?.source_content || '').slice(0, 300), myText: String(x.item?.target_reply_content || x.item?.root_reply_content || '').slice(0, 300),
      oid: x.item?.subject_id, root: x.item?.root_id || x.item?.source_id, parent: x.item?.source_id, title: x.item?.title || '', uri: x.item?.uri || '', type: x.item?.business_id,
    }))
  }

  /** b23.tv 短链跳一下拿到真实地址。 */
  async function resolveShort(url) {
    const r = await fetchImpl(url, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) })
    return r.headers.get('location') || ''
  }

  return { nav, search, popular, view, subtitle, comments, postComment, likeVideo, replyFeed, resolveShort }
}
