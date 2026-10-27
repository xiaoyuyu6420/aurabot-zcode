// 数据目录、JSON 读写（UTF-8 无 BOM、先写临时文件再改名）。
// 桥进程独立于宿主：数据目录默认是仓库里的 workspace/（配置、日志、队列、会话表都在里面），
// 环境变量 AURABOT_DATA_DIR 可整体挪走。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 桥进程的数据根目录：<仓库>/workspace（值守会话的工作区也是它）。 */
export function dataRoot() {
  return process.env.AURABOT_DATA_DIR || join(BRIDGE_ROOT, '..', 'workspace')
}

export function dataDir(...parts) {
  return join(dataRoot(), ...parts)
}

export function bridgeRoot(...parts) {
  return join(BRIDGE_ROOT, ...parts)
}

export function ensureDir(p) {
  mkdirSync(p, { recursive: true })
  return p
}

export function readJson(file, fallback) {
  try {
    let text = readFileSync(file, 'utf8')
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    return JSON.parse(text)
  } catch (error) {
    return typeof fallback === 'function' ? fallback() : fallback
  }
}

export function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

export { existsSync }
