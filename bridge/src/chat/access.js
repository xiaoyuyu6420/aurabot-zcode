// 谁能跟她说话、她在每个会话里有多大权限。纯函数。

/** 权限档位：full = DSH 完整工具；social = 只有 QQ 社交工具；chat = 纯聊天，没有工具。 */
export const LEVELS = ['full', 'social', 'chat']

/**
 * @param {object} cfg 插件配置
 * @param {{kind:'private'|'group', userId:string, groupId:string}} msg
 * @returns {{allowed: boolean, reason: string}}
 */
export function checkAllowed(cfg, msg) {
  const owner = String(cfg.ownerQQ || '')
  if (msg.kind === 'private') {
    if (msg.userId === owner) return { allowed: true, reason: '主人' }
    const list = (cfg.allow?.private || []).map(String)
    return list.includes(msg.userId)
      ? { allowed: true, reason: '私聊白名单' }
      : { allowed: false, reason: '不在私聊白名单' }
  }
  const groups = (cfg.allow?.groups || []).map(String)
  return groups.includes(msg.groupId)
    ? { allowed: true, reason: '群白名单' }
    : { allowed: false, reason: '不在群白名单' }
}

/** 这个会话用哪一档权限。群聊永远不超过 social。 */
export function levelFor(cfg, chat) {
  const owner = String(cfg.ownerQQ || '')
  if (chat.kind === 'private' && chat.userId === owner) {
    return LEVELS.includes(cfg.ownerLevel) ? cfg.ownerLevel : 'full'
  }
  return 'social'
}

/** 档位 → agent preset id。 */
export function presetFor(level) {
  return level === 'full' ? 'aurabot-private' : 'aurabot-social'
}

/** 只有主人能做的事（群管、点歌、写文件……）。 */
export function isOwner(cfg, userId) {
  return String(userId || '') !== '' && String(userId) === String(cfg.ownerQQ || '')
}
