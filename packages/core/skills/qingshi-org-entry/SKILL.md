---
name: qingshi-org-entry
description: 修改「青史永存」App 的组织管理与族谱血缘：在组织树里创建虚拟人物节点或添加现有用户、写生涯事件、传头像、改生卒资料；在族谱里按称谓递归定位并添加血缘家人（虚拟用户/已有用户/扫码邀请）。动手前必须先问清（虚拟还是现有用户、目标组织或锚点人、添加方式）并校验当前用户的管理权限。适用于家族、团队、专题等任何组织树录入，不限于历史人物。
---

# 青史永存 · 组织管理录入（随 dsh-qingshi 插件分发）

往青史永存的组织里加人、加故事、加头像、改资料。核心难点不在接口，而在**节点创建没有领域工具**（只能走 HTTP）、**正文过内容审核**、以及**建完必须回读校验**。

> 取用方式：MCP 客户端里调工具 `qingshi_skill`（name 留空即本技能）拿到本文档；有文件权限的 agent 直接读插件目录 `skills/qingshi-org-entry/SKILL.md`。配套脚本在同目录 `scripts/qs.mjs`。

## 0. 预期与边界（先读）

- 本技能只用于修改「青史永存」App（`https://api.iyouwc.cn`）里的**组织管理**：组织树节点（人物/分类）、成员资料（生卒、头像）、组织成员的生涯事件。
- 用户说「往青史里加/改/录…」默认就指组织管理。平台账号设置、与组织无关的个人空间操作不属于本技能。
- 任何**写操作**（建节点、写事件、传头像、改资料、删关系）动手前必须先走 §1「动手前必问」。

## 1. 动手前必问（缺一不可，不要跳过）

在任何写操作之前，先向用户确认：

1. **加什么人**：创建**虚拟用户**（tmp，不占真实账号）还是添加**现有用户**（真实账号）？
2. **哪个组织**：组织名称必须由用户明确说出。然后调 `get_my_org_list` 现查，名称**完全一致**才继续；有多个相似名称就列出来让用户挑。**org_id 不硬编码、不靠记忆**。
3. **权限校验**：目标组织必须是当前用户**有管理权限**的组织（判断方法见 §5.1）。校验不过就停手询问，不要试探性写入。
4. **挂到哪**：挂在哪个分类/父节点下（用户没说也要问）。

## 2. 前置：确认能读

登录由插件自己处理：MCP 里 `qingshi_me` 看当前登录态，未登录就 `qingshi_login`（插件自带登录小窗）。

凭据位置是**插件工作区**的 `auth.json`（含 `uid`、`accessToken`、`refreshToken`），解析顺序（`scripts/qs.mjs` 已内置）：

1. `$QINGSHI_WORKSPACE/auth.json`（显式指定）
2. `~/qingshi-plugin/auth.json`（默认位置）
3. `%APPDATA%/qingshi/auth.json`（老版本）
4. `$DSH_HOME/qingshi-workspace/auth.json`（老版本）
5. `~/.dsh/qingshi-workspace/auth.json`（老版本）

**不要把 token 打印到对话或写进文件。**

## 3. 两条通道怎么选

| 要做的事 | 用什么 |
|---|---|
| 读族谱/关系、查人、读事件全文 | 插件 MCP：`qingshi_family`、`qingshi_kinship`、`qingshi_profile`、`qingshi_find_experience`、`qingshi_event` |
| 给**已存在的人**写一条记录 | 插件 MCP：`qingshi_record`（带 `targetUid`，需配置开启 `allowFamilyWrite`） |
| **新建组织树节点**、改生日/卒日、传头像、批量写历史事件 | HTTP 直连（下文；插件没有这组领域工具） |
| 建完回读、验数、查重 | HTTP：`/organization/orgtree/get_org_tree`、`/get_career_list` |

规律：**读走 MCP，建走 HTTP，写完必须回读。**

## 4. HTTP 基础

```
BASE = https://api.iyouwc.cn
Header: Content-Type: application/json
Header: X-Client-Platform: plugin
Header: Authorization: Bearer <accessToken>
```

401 处理：`POST /get_token`，body `{}`，header 换成 `Bearer <refreshToken>`，新 token 在 `data.access_token`，替换后重试一次。

所有脚本写成 `.mjs` 文件再 `node xxx.mjs` 执行。**不要用 `node -e` 内联中文**——Windows PowerShell 会把引号和编码搞坏。

最小可复用脚本见本技能目录 `scripts/qs.mjs`（复制到临时目录运行，别放进被录入的项目里）：

```bash
node qs.mjs orgs                                  # 列组织：org_id / 根节点 / 人数 / 是否有管理权限
node qs.mjs members <org_id> [过滤词]              # 扁平成员列表（查重、看头像有无）
node qs.mjs node <org_id> <node_id>               # 单节点：父节点、头像、子节点数
node qs.mjs add <org_id> <anchor_uid> <昵称> [生日] [卒日] [性别]
node qs.mjs event <uid> <标题> <正文> [日期] [标签] [地点]
node qs.mjs events <uid>                          # 该人物全部事件
node qs.mjs one <event_id>                        # 单条事件全文
```

## 5. 读：拿到 org_id、权限和现有结构

```js
// 拿组织（含权限字段）
POST /organization/get_my_org_list   {}
// → data.list[].{ org_id, org_name, root_node_id, member_count, created_uid, manage_uids, is_manager, ... }

// 单个节点（含父节点，children 恒为空——树是懒加载的，不要指望它返回子树）
POST /organization/orgtree/get_org_tree_branch { org_id, node_id }
// → data.focus_node.{ node_id, parent_node_id, nickname, member_uid, avatar,
//                      children_count, can_manage_member }

// 全量成员（扁平，用于查重和批量核对）
POST /organization/get_all_org_members { org_id }
// → data.members[].{ uid, nickname, avatar, role, is_manager }
```

### 5.1 管理权限判断（§1 必问第 3 条的实现）

当前用户 uid 取 `auth.json` 的 `uid` 字段（`qingshi_me` 也可）。按优先级判断：

1. 组织条目 `created_uid === 本人 uid` → 创建者，必有权限
2. 组织条目 `manage_uids` 数组包含本人 uid
3. 条目 `is_manager === true` 或等效角色字段
4. 字段不在条目上时，打印原始条目人工判断，或交叉用 `get_all_org_members` 里该成员的 `is_manager`

`qs.mjs orgs` 已内置此判断，输出 `MANAGE` / `CHECK-PERM`。**非 MANAGE 一律停手。**

要点：`get_org_tree` / `get_org_tree_branch` 的 `children` 永远是空数组，`children_count` 只是计数。**枚举全树用 `get_all_org_members`**，定位某个节点用 `get_org_tree_branch`（`focus_node.parent_node_id` 给父级）。关系语义（父子/夫妻/兄弟）用 MCP `qingshi_kinship`、`qingshi_family` 读。

`node_id` 与 `member_uid` 通常相同；后续所有 `anchor_uid` / `of_uid` 都用这个 id。

## 6. 数据模型

```
org（组织）
└── 根节点「组织成员」            node_type: organization_member
    └── 分类节点（如「现代」「科技」）   ← 也是虚拟人物节点
        └── 人物节点
            └── 事件 event（生涯记录）
```

关键认知：**分类节点本质上也是一个人物节点**，只是被当成容器用。所以分类也能有头像、有生日。

## 7. 建：新增节点（先分清虚拟/现有）

### 7.1 虚拟用户（tmp，最常用）

```js
POST /organization/orgtree/add_org_relation_member
{
  org_id: "org_xxx",
  anchor_uid: "<父节点 uid>",        // 分类节点或根节点
  direction: "child",
  relation_zone: "child",
  relation_slot: "child",
  add_user_status: "tmp",            // tmp = 虚拟人物，不占真实账号
  tmp_user_data: {
    username: "唯一标识",             // 建议与 nickname 一致
    nickname: "显示名",
    gender: 1,                        // 1 男；女性节点可试 2 并回读 profile 确认
    birthday: "1928-10-01"            // 公元前写 "-0259-01-01"
  }
}
```

返回后取新 uid：优先 `data.uid` / `data.member_uid` / `data.node_id`；**若都没有，就用 `get_all_org_members` 按 nickname 反查**（同名要留意，可能是建重了）。

若返回 `data.message_id`，说明进了审批流，需立刻：

```js
POST /message/message_action { message_id: "<id>", action: "approved", comment: "" }
```

补卒日等字段（建节点时没传的）：

```js
POST /edit_userinfo { edit_user_uid: "<uid>", edit_dict: { birthday: "1893-12-26", deathday: "1976-09-09" } }
```

在世写 `deathday: ""`。

### 7.2 现有用户（真实账号）

- 接口同为 `/organization/orgtree/add_org_relation_member`，但 `add_user_status` 不是 `tmp`，载荷字段也不同——**本技能未验证过真实用户入组的字段**，先用最小载荷试探再回读，不要凭空造字段。
- 现有用户的 uid 必须由用户提供，或先在成员列表/搜索里确认，**不要按昵称猜 uid**。

## 8. 写：生涯事件

单条事件（最常用，已验证）：

```js
POST /add_event
{
  of_type: "user", of_id: "<uid>", of_uid: "<uid>",
  title: "标题",
  content: "正文",
  location: { name: "地点" },
  start_date: "1949-10-01",
  end_date: "",            // 阶段事件才填
  is_Stage: false,
  event_tag: "record",     // birthday / record / ...
  media_list: []
}
```

带人物资料一起写的老接口（建档时用）：

```js
POST /add_career
{
  of_type: "user", of_id: "<uid>", of_uid: "<uid>",
  event: { title, start_date, end_date: "", event_tag, location, content,
           visibility: "public", related_users: [] },
  user_fields: { uid, nickname, gender: 1, birthday, deathday }
}
```

硬约束：

- `title.length <= 30`（**必检**，超了直接失败）
- `content.length >= 40`（**必检**）
- 日期 `YYYY-MM-DD`，公元前 `-YYYY-MM-DD`
- 写前先 `get_career_list` 查同 uid 同标题，存在就跳过（幂等）

**共同经历人**（`/add_event_share`）：

- 只支持**人物个人事件**（`of_type:'user'`）。**组织事件一律返回 500「没有修改该事件共同经历人的权限」**，别再试。
- 同一事件关联多人：`target_uids` 传数组，**一次请求**，不要拆成多次。
- 被邀请人生卒必须覆盖事件日期，否则 400「存在日期不符合」。
- 邀请发出后要审批：`message/get_message_list` 翻页找 `biz_key` 含 `event_participant_invite` 的待审项 → `message/message_action { message_id, action:'approved' }`。审批后事件才出现在对方生涯。

## 9. 回读校验（必做）

```js
POST /get_career_list { of_type: "user", of_id: "<uid>", of_uid: "<uid>", content_preview_limit: 0 }
// → event_list[].{ event_id, title, start_date, content(截断) }

POST /get_event { event_id }
// → data.event_data.{ title, content, start_date, location.name, event_tag }
```

`get_career_list` 的 content 是**截断的**，核对全文必须用 `get_event`。

## 10. 头像

四步，缺一不可：

```js
// 1) 要签名
POST /get_oss_upload_signature
{ biz_type: "avatar", of_uid: "<uid>", target_type: "tmp_user_profile",
  file_name: "avatar.png", file_size: 12345, content_type: "image/png" }
// → data.{ host, form_data, object_key, upload_file_id, public_url }

// 2) multipart 上传到 data.host：form_data 全部字段 + 文件字段
//    文件字段名用 "file"，文件名必须与 file_name 一致

// 3) 确认
POST /confirm_oss_upload { upload_file_id, object_key }

// 4) 回读
POST /organization/get_all_org_members { org_id }
// 找到该 uid，比对 members[].avatar === public_url
```

校验要求：本地文件 sha256 与下载回来的 sha256 一致；`avatar` 等于 `public_url`；批量传完检查**没有跨人物重复**（同一 URL 出现两次就是传错）。

分类节点头像：用 System.Drawing 生成文字图（楷体、米黄底、双线边框）再走同一流程。PowerShell 生成中文时用 `[char]0xXXXX` 拼字符，避免编码错乱。

## 11. 代码规则（qs.mjs 已内置，手写脚本同样必须遵守）

这些规则已写进 `scripts/qs.mjs`，未来改代码或手写脚本时保持一致：

- **认证**：按 §2 的顺序找 `auth.json`（`uid`、`accessToken`、`refreshToken`）。任何请求 401 → `POST /get_token`（body `{}`，header 换 `Bearer <refreshToken>`）→ 取 `data.access_token` 换新后重试一次。请求头必带 `X-Client-Platform: plugin`；fetch 统一 30 秒超时。
- **事件两道硬校验**（qs.mjs 的 event 命令直接抛错，不静默放行）：`title.length > 30` 拒绝；`content.length < 40` 拒绝。
- **幂等**：`add_event` 前先 `get_career_list`，同 uid 下已有**同标题**事件 → SKIP 不写。
- **uid 取值链**：建节点返回后按 `data.uid` → `data.member_uid` → `data.node_id` 顺序取；全空则用 `get_all_org_members` 按 nickname 反查，同名 ≥2 个必须 WARN（可能建重了）。
- **审批流**：add 返回 `data.message_id` → 立即 `message_action approved`；不审批节点等于没建。
- **卒日**：建节点没传的字段用 `edit_userinfo` 补；在世 `deathday: ""`。
- **限流重试**：返回 code 500 且 message 含「请求过于频繁」→ 解析「N 秒」，sleep(N+0.4s) 后重试（最多 4~6 次）；批量操作请求间隔保持 700~900ms。
- **执行方式**：脚本一律写成 `.mjs` 用 `node` 执行（禁止 `node -e` 内联中文）；脚本与中间产物放临时目录，不放被录入的项目里、不落盘 token。

## 12. 注意事项（踩过的坑）

1. **正文里的敏感人名/职务会被静默拦截**：返回失败但没有具体违规词。历史/政治题材改写为第三人称「他」「时任某某职务」，年份史实不动；节点 nickname 用真名本身不拦。
2. **先查重再建**：同名节点可能已存在于别的分类，重复建会出现两个同名人物。先全树搜 nickname。
3. **不要硬编码 org_id / 根 uid**：每个组织不同，从 `get_my_org_list` 现取，且组织名称要与用户确认的一致。
4. **审批流别漏**：`message_id` 不处理，节点会停在待审状态，等于没建。
5. **建节点返回里没有 uid 时不要猜**：用 `get_all_org_members` 按 nickname 反查。
6. **不要在被录入的项目里跑脚本**：把脚本和候选素材放临时目录，只把结果写回云端。
7. **删除关系用 `send_delete_org_relation_member`，属于破坏性操作**：先只读确认 node_id，确认后再执行，不要批量删。
8. **凭据只在进程内用**，不落盘、不打印、不写进文档。
9. **图片抓取**：百度百科词条卡 API 最稳，维基/搜狗常超时或返回 forbid，别反复重试。
10. **改生卒可能被已有事件卡住**：人物名下已有事件日期超出新生卒范围时，`edit_userinfo` 会被后端拒绝（例：苏秦名下有 1973 年「马王堆帛书」纪事，生年怎么改都不行）。改之前先看该人物事件的最早/最晚日期。读虚拟人物生卒用 `get_manageable_tmp_user_detail { target_uid }` → `data.user.{birthday, deathday}`。

## 13. 一次完整录入的检查清单

- [ ] 已问清：**虚拟 or 现有用户**、**组织名称**、挂载位置
- [ ] 登录可用（`qingshi_me` 或 qs.mjs 能读）
- [ ] `get_my_org_list` 拿到 org_id，**名称与用户说的完全一致**
- [ ] **权限校验通过**（created_uid=本人 或 manage_uids 含本人，qs.mjs orgs 显示 MANAGE）
- [ ] `get_all_org_members` 查重（同名节点可能已存在别的分类）
- [ ] `get_org_tree_branch` 确认父节点 uid
- [ ] 逐个 `add_org_relation_member`，处理 message_id
- [ ] `edit_userinfo` 补 birthday / deathday
- [ ] 每条事件：title ≤ 30、content ≥ 40、日期格式合法、同标题未存在
- [ ] `add_event` 后 `get_event` 核对全文与日期
- [ ] 头像：签名 → 上传 → 确认 → `get_all_org_members` 比对 URL 与 sha256
- [ ] 最终 `get_all_org_members` 统计：节点数、每人的事件数、头像齐全

## 14. 常见错误对照

| 现象 | 原因 | 处理 |
|---|---|---|
| 401 | accessToken 过期 | `/get_token` 换新后重试一次 |
| 500「请求过于频繁，请在 N 秒后重试」 | 触发限流 | 解析 N，sleep 后重试；批量间隔 700~900ms |
| 写操作报权限类错误 | 目标组织非本人管理 | 停手，向用户确认组织；勿试探写入 |
| EPERM / 不让写 | 往受保护目录写 | 换临时目录 |
| 事件加不上、无违规提示 | 正文含敏感人名/职务 | 改第三人称，只留职务 |
| 500「没有修改该事件共同经历人的权限」 | 组织事件不能邀请共同经历人 | 只对人物个人事件（of_type:'user'）邀请 |
| 400「存在日期不符合」 | 被邀请人生卒未覆盖事件日期 | 核对该人生卒；别为凑关联改史实生卒 |
| edit_userinfo 改生卒被拒 | 名下事件日期超出新生卒范围 | 先处理越界事件或放弃修改 |
| 节点建了但树里没有 | message_id 未审批 / 建到了别的 anchor | 审批后用 `get_all_org_members` 反查 nickname |
| 头像传了不显示 | 少了 `confirm_oss_upload` | 补确认步骤再回读 |
| 中文乱码 / 引号被吃掉 | `node -e` 内联 | 写成 `.mjs` 文件执行 |

## 15. 族谱血缘：添加「爷爷的爷爷」这类关系（插件工具已内置）

插件提供三个族谱血缘工具，不用手写 HTTP：

| 工具 | 用途 |
|---|---|
| `qingshi_family_all` | 一次读全某人的完整族谱树（需对目标人有管理权限）；称谓递归匹配首选 |
| `qingshi_family_add` | 直接添加：tmp 虚拟用户 / created 已有用户；自动自审批 |
| `qingshi_family_invite` | 生成扫码邀请二维码（PNG 存临时目录），对方扫码确认后入谱 |

### 标准步骤（动手前照这个顺序走）

1. **确认意图**：先问用户是否要修改族谱血缘关系、加的是谁（称谓）。
2. **称谓递归定位**：用 `qingshi_family_all`（没权限再退 `qingshi_family` 逐层 up/down）把称谓换算成关系链：
   - 爷爷 = up×2；曾祖父 = up×3；**高祖父（爷爷的爷爷）= up×4**
   - 插件 KIN_TERMS 已内置常见称谓，`qingshi_kinship` 也能解析
   - 把链路上每层的人列给用户确认：「父亲 → 祖父（已录入）→ 曾祖（缺）→ 高祖（缺）」
3. **权限校验**：确认当前用户对锚点人有管理权（后端 `can_manage_target_user` = 目标人的 `manage_uids` 含当前用户）。没权限时全树读/分层读都会报错，停手问用户。
4. **确认添加方式**（问用户）：
   - **扫码添加**：`qingshi_family_invite` 生成二维码，真实亲人自己扫码入谱
   - **指定已有用户**：`qingshi_family_add mode=created`（uid 必须用户提供或搜索确认，不要按昵称猜）
   - **创建虚拟用户**：`qingshi_family_add mode=tmp`（nickname/gender/birthday 必填）
5. **发请求 + 自审批 + 回读**：`qingshi_family_add` 自动走 `send_add_family_member` → `message_action approved`；返回「当前没有可处理的审批组」说明需要对方/家庭管理员同意；成功后用 `qingshi_family` 回读层级与称谓。

### 逐层补链示例：添加「爷爷的爷爷」（高祖父）

- 祖父链完整时：对「祖父」调 `qingshi_family_add { familyType:'parent', relationship:'man', familyId:'new_parent', mode:'tmp', tmpUser:{...} }` → 得到曾祖父；
- 再对「曾祖父」重复同样调用 → 高祖父。
- **每加一层回读一次**：下一层的锚点要用新层真实 family_id，不能继续用 new_parent。

### 参数速记

- `familyType`：parent=往父层加；child=往子层加
- `relationship`：man=父亲/男性；woman=母亲/女性；child=子女
- `familyId`：既有层 id；新层占位 **new_parent / new_child / new_child_family**
- mode=tmp 时 target_uid 由工具自动生成 `tmp:<时间戳>`，不用自己造

### 注意

- 父/母角色唯一：目标层已有父亲（或母亲）时后端拒绝；配偶/重组家庭走 new_child_family。
- 后端 service 有血缘校验：父必须比子女大 12 岁以上、同代兄弟姐妹年龄差 ≤30 岁、生日不能晚于今天等，tmpUser.birthday 乱填会被拒。
- 审批三组（父角色管理员/母角色管理员/被添加人管理员，any_one）：任一组含真实审批人就要等审批；全是 tmp 的链路通常自动通过。
- 扫码邀请只能由**被邀请人**扫码确认，agent 无法代接受；把 PNG 发给用户即可。
- 删家庭成员走 `send_delete_family_member`（同类审批流），破坏性操作，先只读确认再动手。
