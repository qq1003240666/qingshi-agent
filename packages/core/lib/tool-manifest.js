// 工具元数据单一事实来源：
// - title：MCP tools/list 里给客户端看的短标题
// - annotations：MCP 工具注解，客户端据此决定是否自动放行/弹确认
// 这份表由 test/tool-manifest.test.mjs 校验：每个注册工具都必须在这里登记。

const READ_ONLY = new Set([
  'qingshi_me',
  'qingshi_where',
  'qingshi_search',
  'qingshi_find_experience',
  'qingshi_event',
  'qingshi_tags',
  'qingshi_about_me',
  'qingshi_pages',
  'qingshi_ui_read',
  'qingshi_ui_shot',
  'qingshi_family',
  'qingshi_kinship',
  'qingshi_family_all',
  'qingshi_photo_scan',
  'qingshi_storage',
  'qingshi_phone_upload_status',
])

// 会覆盖或删除既有数据的操作
const DESTRUCTIVE = new Set(['qingshi_delete', 'qingshi_edit', 'qingshi_logout'])

// 只操作本地窗口，不碰外部世界
const LOCAL_ONLY = new Set([
  'qingshi_open_h5',
  'qingshi_ui_read',
  'qingshi_ui_goto',
  'qingshi_ui_click',
  'qingshi_ui_type',
  'qingshi_ui_tap',
  'qingshi_ui_shot',
  'qingshi_family_layout',
  'qingshi_photo_scan',
])

const TITLES = {
  qingshi_login: '登录青史',
  qingshi_save_login: '保存登录凭证',
  qingshi_where: '查看数据目录',
  qingshi_me: '查看我的资料',
  qingshi_search: '搜索用户',
  qingshi_find_experience: '查找经历',
  qingshi_record: '记录生涯事件',
  qingshi_tags: '查看标签',
  qingshi_about_me: '读取个人简介',
  qingshi_profile: '修改个人资料',
  qingshi_set_privacy: '设置事件隐私',
  qingshi_draft: '生成待发布草稿',
  qingshi_publish: '发布草稿',
  qingshi_open_h5: '打开青史窗口',
  qingshi_ui_read: '读取窗口内容',
  qingshi_ui_goto: '窗口内跳转',
  qingshi_ui_click: '窗口内点击',
  qingshi_ui_type: '窗口内输入',
  qingshi_ui_tap: '窗口内轻触',
  qingshi_ui_shot: '窗口截图',
  qingshi_pages: '查看页面地图',
  qingshi_event: '读取事件详情',
  qingshi_edit: '修改事件',
  qingshi_delete: '删除事件',
  qingshi_restore: '恢复事件',
  qingshi_family: '族谱分层导航',
  qingshi_kinship: '计算亲属称谓',
  qingshi_open_event: '打开事件页面',
  qingshi_prepare_event: '准备事件页面',
  qingshi_family_expand: '展开族谱节点',
  qingshi_family_layout: '调整族谱布局',
  qingshi_logout: '退出登录',
  qingshi_skill: '读取操作技能',
  qingshi_family_add: '添加族谱成员',
  qingshi_family_invite: '生成族谱邀请码',
  qingshi_family_all: '读取完整族谱',
  qingshi_photo_scan: '扫描照片场次',
  qingshi_storage: '查看存储额度',
  qingshi_photo_save: '保存照片到青史',
  qingshi_phone_upload_start: '手机扫码上传照片',
  qingshi_phone_upload_status: '查看手机上传进度',
  qingshi_phone_upload_pick: '把手机照片取回电脑',
  qingshi_phone_upload_finish: '手机上传收尾',
}

export const TOOL_MANIFEST = Object.freeze(
  Object.keys(TITLES).map((name) =>
    Object.freeze({
      name,
      title: TITLES[name],
      readOnly: READ_ONLY.has(name),
      destructive: DESTRUCTIVE.has(name),
      localOnly: LOCAL_ONLY.has(name),
    }),
  ),
)

const BY_NAME = new Map(TOOL_MANIFEST.map((item) => [item.name, item]))

export function titleFor(name) {
  return BY_NAME.get(name)?.title || name
}

export function annotationsFor(name) {
  const item = BY_NAME.get(name)
  const readOnly = item ? item.readOnly : false
  return {
    title: titleFor(name),
    readOnlyHint: readOnly,
    destructiveHint: item ? item.destructive : false,
    idempotentHint: readOnly,
    openWorldHint: item ? !item.localOnly : true,
  }
}

/** 返回注册了但没有登记元数据的工具名，CI/测试用 */
export function missingMeta(names) {
  return [...names].filter((name) => !BY_NAME.has(name))
}
