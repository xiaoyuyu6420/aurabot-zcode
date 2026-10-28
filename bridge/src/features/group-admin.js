// 群管（M6 收尾）：主人开口时禁言、解禁、踢人、改头衔、发公告。
// 上游 modules/group-admin 的桥内适配：不做 DSH 工具注册，动作通过开放 HTTP 口
// （POST /api/open → action=group_admin）供 CLI 会话里的模型调用；权限校验照搬：
// turnHasOwner（5 分钟内主人说过话）+ 白名单 + 她的群身份 + 不能对主人操作。

import { createGroupRoles } from '../chat/group-roles.js'

export function createGroupAdmin({ getConfig, onebot, hub, log }) {
  const groupRoles = createGroupRoles({ onebot, getConfig, log })

  /**
   * @param {{action:'ban'|'unban'|'kick'|'title'|'notice', groupId?:string, userId?:string, minutes?:number, text?:string}} p
   * @returns {Promise<{ok:boolean, message:string}>}
   */
  async function admin(p) {
    const cfg = getConfig()
    const action = String(p.action || '')
    const gid = Number(p.groupId || 0)
    if (!gid) return { ok: false, message: '不知道是哪个群' }
    if (!cfg.allow.groups.includes(String(gid))) return { ok: false, message: '这个群不在白名单里' }
    // 调用方（开放口）已保证主人发起；这里再挡一层：不能对主人操作
    const uid = Number(p.userId || 0)
    if (action !== 'notice' && !uid) return { ok: false, message: '要说清楚对谁（QQ 号）' }
    if (uid && String(uid) === String(cfg.ownerQQ) && action !== 'unban' && action !== 'title') return { ok: false, message: '不能对主人做这个' }
    const role = await groupRoles.get(gid, { fresh: true })
    if (role && !groupRoles.canManage(role)) return { ok: false, message: '我在这个群只是普通成员，没有管理权限' }
    if (role === 'admin' && action === 'title') return { ok: false, message: '改专属头衔要群主才行，我只是管理员' }
    if (cfg.dryRun) return { ok: true, message: `试运行：本来要对群 ${gid} 做 ${action}` }
    switch (action) {
      case 'ban': await onebot.call('set_group_ban', { group_id: gid, user_id: uid, duration: Math.max(1, Number(p.minutes) || 10) * 60 }); break
      case 'unban': await onebot.call('set_group_ban', { group_id: gid, user_id: uid, duration: 0 }); break
      case 'kick': await onebot.call('set_group_kick', { group_id: gid, user_id: uid, reject_add_request: false }); break
      case 'title': await onebot.call('set_group_special_title', { group_id: gid, user_id: uid, special_title: String(p.text || '') }); break
      case 'notice': await onebot.call('_send_group_notice', { group_id: gid, content: String(p.text || '') }); break
      default: return { ok: false, message: '不认识的操作' }
    }
    log.info(`群管：${action} 群 ${gid}${uid ? ' 对 ' + uid : ''}${p.text ? '「' + String(p.text).slice(0, 20) + '」' : ''}`)
    return { ok: true, message: '做好了' }
  }

  /** 她在每个群里的身份（面板 /groups/roles 与上下文注入用）。 */
  async function rolesList() {
    const cfg = getConfig()
    const list = []
    for (const gid of cfg.allow.groups) {
      const role = await groupRoles.get(gid, { fresh: true }).catch(() => '')
      list.push({ groupId: gid, name: await hub.groupName(String(gid)), role, label: role ? groupRoles.label(role) : '查不到（她在群里吗？）', canManage: groupRoles.canManage(role) })
    }
    return list
  }

  return { admin, rolesList, groupRoles }
}
