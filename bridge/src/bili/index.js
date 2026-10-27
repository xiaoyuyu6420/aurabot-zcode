// 内置能力：B 站（M5）。别人发来链接她能「看」视频（标题、简介、字幕、热评）；定时自己去刷、评论、回评论，看到好玩的分享给主人。
// 上游 modules/bili + bili/duty.js 原样搬入；差异只有两处：
//   think() 上游走 hub.runSystemTurn（DSH agent 会话），桥内用 zcode CLI 的临时会话（askModel 风格，长任务专用 cwd）；
//   挂载点从 api.every 换成看门狗 tick（app.js）。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBili } from './duty.js'
import { createBiliApi } from './api.js'

/**
 * @param {{getConfig, hub, memory, log, zcode}} deps zcode = CLI 驱动（后台小任务用它）
 */
export function createBiliModule({ getConfig, hub, memory, log, zcode }) {
  let thinkBusy = 0
  // 后台思考：临时目录 + 临时会话（每次新会话，不带聊天人格上下文，纯任务）
  async function runSystemTurn(name, title, prompt, { timeoutMs = 180000 } = {}) {
    const cfg = getConfig().zcode
    const dir = mkdtempSync(join(tmpdir(), 'aurabot-think-'))
    thinkBusy++
    try {
      const r = await zcode.runOnceIn(dir, prompt, { timeoutMs })
      return r.text
    } finally {
      thinkBusy--
      try { rmSync(dir, { recursive: true, force: true }) } catch (error) {}
    }
  }

  const hubAdapter = { ...hub, runSystemTurn }
  const bili = createBili({
    getConfig,
    hub: hubAdapter,
    memory,
    log,
    api: createBiliApi({ getCookie: () => getConfig().bili?.cookie || '', log }),
  })
  return bili
}
