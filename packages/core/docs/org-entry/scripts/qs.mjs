// 青史组织树录入助手（随 qingshi-agent 分发，配套 skills/qingshi-org-entry/SKILL.md）。
// 复制到临时目录后运行：node qs.mjs <command> [...args]
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const BASE = 'https://api.iyouwc.cn'

let access = ''
let refresh = ''
let myUid = ''

// 按插件工作区的解析顺序找 auth.json（见 SKILL.md §2）
async function loadAuth() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const candidates = []
  if (process.env.QINGSHI_WORKSPACE) candidates.push(join(process.env.QINGSHI_WORKSPACE, 'auth.json'))
  candidates.push(join(home, 'qingshi-plugin', 'auth.json'))
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'qingshi', 'auth.json'))
  if (process.env.DSH_HOME) candidates.push(join(process.env.DSH_HOME, 'qingshi-workspace', 'auth.json'))
  candidates.push(join(home, '.dsh', 'qingshi-workspace', 'auth.json'))
  for (const p of candidates) {
    try {
      const a = JSON.parse(await readFile(p, 'utf8'))
      access = a.accessToken
      refresh = a.refreshToken
      myUid = a.uid || ''
      return
    } catch {
      /* 试下一个位置 */
    }
  }
  throw new Error('没找到 auth.json，先跑 qingshi_login。找过的位置：' + candidates.join(' ; '))
}

// 管理权限判断：created_uid=本人 / manage_uids 含本人 / is_manager。规则见 SKILL.md §5.1
function hasManage(o, topLevelManageUids = []) {
  return o.created_uid === myUid
    || (Array.isArray(o.manage_uids) && o.manage_uids.includes(myUid))
    || (Array.isArray(topLevelManageUids) && topLevelManageUids.includes(myUid))
    || o.is_manager === true
}

async function post(api, data, token) {
  const res = await fetch(BASE + api, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Platform': 'plugin',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(data || {}),
    signal: AbortSignal.timeout(30000),
  })
  const t = await res.text()
  try { return JSON.parse(t) } catch { return { code: res.status, message: t.slice(0, 300) } }
}

async function authed(api, data) {
  let b = await post(api, data, access)
  if (b.code === 401) {
    const r = await post('/get_token', {}, refresh)
    if (r.code === 200 && r.data?.access_token) {
      access = r.data.access_token
      b = await post(api, data, access)
    }
  }
  return b
}

function out(label, obj) {
  console.log(`[${label}] ${JSON.stringify(obj).slice(0, 1500)}`)
}

async function listMembers(orgId) {
  const r = await authed('/organization/get_all_org_members', { org_id: orgId })
  return r.data?.members || r.data?.member_list || r.data?.list || []
}

async function findUidByNickname(orgId, nickname) {
  const hits = (await listMembers(orgId)).filter((m) => m.nickname === nickname)
  if (hits.length > 1) console.log(`WARN 同名节点 ${hits.length} 个:`, hits.map((h) => h.uid).join(','))
  return hits[0]?.uid || ''
}

const [cmd, ...args] = process.argv.slice(2)
await loadAuth()

if (cmd === 'orgs') {
  const r = await authed('/organization/get_my_org_list', {})
  const manages = r.data?.manage_uids || []
  for (const o of r.data?.list || []) {
    const ok = hasManage(o, manages)
    console.log(o.org_id, o.root_node_id, o.org_name, o.member_count, ok ? 'MANAGE' : 'CHECK-PERM', `created=${o.created_uid || '?'}`)
  }
} else if (cmd === 'members') {
  const [orgId, filter = ''] = args
  const list = await listMembers(orgId)
  for (const m of list) {
    if (filter && !m.nickname.includes(filter)) continue
    console.log(m.uid, '|', m.nickname, '|', m.avatar ? 'avatar' : 'no-avatar')
  }
  console.log('TOTAL', list.length)
} else if (cmd === 'node') {
  const [orgId, nodeId] = args
  const r = await authed('/organization/orgtree/get_org_tree_branch', { org_id: orgId, node_id: nodeId })
  const n = r.data?.focus_node || (r.data?.tree || [])[0] || {}
  console.log(JSON.stringify({ nickname: n.nickname, uid: n.member_uid, avatar: n.avatar, children_count: n.children_count, parent: n.parent_node_id }, null, 2))
} else if (cmd === 'add') {
  const [orgId, anchorUid, nickname, birthday = '', deathday = '', gender = '1'] = args
  const r = await authed('/organization/orgtree/add_org_relation_member', {
    org_id: orgId,
    anchor_uid: anchorUid,
    direction: 'child',
    relation_zone: 'child',
    relation_slot: 'child',
    add_user_status: 'tmp',
    tmp_user_data: { username: nickname, nickname, gender: Number(gender), birthday },
  })
  out('add', { code: r.code, message: r.message, data: r.data })
  if (r.data?.message_id) {
    const m = await authed('/message/message_action', { message_id: r.data.message_id, action: 'approved', comment: '' })
    out('approve', { code: m.code, message: m.message })
  }
  let uid = r.data?.uid || r.data?.member_uid || r.data?.node_id || ''
  if (!uid) uid = await findUidByNickname(orgId, nickname)
  if (uid && deathday !== '') {
    const e = await authed('/edit_userinfo', { edit_user_uid: uid, edit_dict: { birthday, deathday } })
    out('edit', { code: e.code, message: e.message })
  }
  console.log('UID', uid || '(未取到，请用 tree 命令回读)')
} else if (cmd === 'event') {
  const [uid, title, content, startDate = '', eventTag = 'record', location = ''] = args
  if (title.length > 30) throw new Error(`title 超长: ${title.length}`)
  if (content.length < 40) throw new Error(`content 过短: ${content.length}`)
  const exist = await authed('/get_career_list', { of_type: 'user', of_id: uid, of_uid: uid, content_preview_limit: 0 })
  if ((exist.event_list || []).some((e) => e.title === title)) {
    console.log('SKIP 已存在同标题:', title)
  } else {
    const r = await authed('/add_event', {
      of_type: 'user', of_id: uid, of_uid: uid,
      title, content,
      location: location ? { name: location } : {},
      start_date: startDate, end_date: '', is_Stage: false,
      event_tag: eventTag, media_list: [],
    })
    out('event', { code: r.code, message: r.message, event_id: r.event_id || r.data?.event_id })
  }
} else if (cmd === 'events') {
  const [uid] = args
  const r = await authed('/get_career_list', { of_type: 'user', of_id: uid, of_uid: uid, content_preview_limit: 0 })
  for (const e of r.event_list || []) console.log(e.start_date, '|', e.title, '|', e.event_id)
} else if (cmd === 'one') {
  const [eventId] = args
  const r = await authed('/get_event', { event_id: eventId })
  const ev = r.data?.event_data || {}
  console.log(JSON.stringify({ title: ev.title, start_date: ev.start_date, location: ev.location?.name, content: ev.content }, null, 2))
} else {
  console.log('用法: orgs | members <org_id> [过滤词] | node <org_id> <node_id> | add <org_id> <anchor_uid> <nickname> [birthday] [deathday] [gender] | event <uid> <title> <content> [start_date] [event_tag] [location] | events <uid> | one <event_id>')
}
