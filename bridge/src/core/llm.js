// 直接问一次模型（不进会话）：给表情起备注、心情判断、记忆提炼等后台小任务用。
// 桥进程版：保持上游 askModel(dsh, o) 的调用契约形状不变（features/* 尽量原样搬入），
// dsh 参数换成桥自己提供的轻对象——模型走「zcode -p 一次性小任务」，零额外凭据。

import { spawn } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { detectCjs } from '../zcode.js'
import { dataDir, ensureDir } from './store.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function runOnce(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch (error) {}
      reject(new Error(`模型小任务超时（${Math.round(timeoutMs / 1000)}s）`))
    }, timeoutMs)
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v) } }
    child.stdout.on('data', (b) => out.push(b))
    child.stderr.on('data', (b) => err.push(b))
    child.on('error', (e) => done(reject, e))
    child.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8').trim()
      if (code !== 0) return done(reject, new Error(`zcode 退出码 ${code}：${Buffer.concat(err).toString('utf8').trim().slice(-300) || text.slice(-300)}`))
      let parsed = null
      try { parsed = JSON.parse(text) } catch (error) {
        const start = text.lastIndexOf('{\n  "sessionId"')
        if (start >= 0) { try { parsed = JSON.parse(text.slice(start)) } catch (error2) {} }
      }
      if (!parsed || typeof parsed.response !== 'string') return done(reject, new Error('模型输出解析不了'))
      done(resolve, parsed)
    })
  })
}

/**
 * 桥内 askModel：一次 spawn 一条短提示词。
 * o.system + o.text 拼成单条 prompt；o.images 落临时文件用 --attach。
 * @param {{system?:string, text:string, images?:Array<{data:string, mediaType?:string}>, timeoutMs?:number}} o
 * @returns {Promise<string>} 模型正文
 */
export async function askModel(_dsh, o = (typeof _dsh === 'object' && _dsh && _dsh.text !== undefined) ? _dsh : {}) {
  const cjs = detectCjs('')
  if (!cjs) throw new Error('找不到 zcode.cjs')
  const prompt = (o.system ? `[系统要求] ${o.system}\n\n` : '') + (o.text || '')
  const args = [cjs, '-p', prompt, '--json', '--surface', 'terminal', '--locale', 'zh-CN']
  const cwd = ensureDir(dataDir('tmp', 'ask'))
  args.push('--cwd', cwd)
  const files = []
  try {
    for (const img of (o.images || []).slice(0, 3)) {
      const f = join(cwd, `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${((img.mediaType || 'image/png').split('/')[1] || 'png').replace('+xml', '')}`)
      writeFileSync(f, Buffer.from(img.data, 'base64'))
      files.push(f)
      args.push('--attach', f)
    }
    // 后台小任务：短平快（表情备注/心情判断/记忆提炼都是十几秒的活），抖动重试一次
    const timeoutMs = o.timeoutMs || 120_000
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await runOnce(args, timeoutMs)
        return r.response.trim()
      } catch (error) {
        if (attempt === 1) throw error
        await sleep(2000)
      }
    }
  } finally {
    for (const f of files) { try { rmSync(f, { force: true }) } catch (error) {} }
  }
}

/** 上游契约兼容：features/* 传进来的 dsh 在桥里就是 { ask } 这个对象。 */
export function createDshBridge() {
  return { ask: askModel }
}
