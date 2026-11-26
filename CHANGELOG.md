# CHANGELOG

## 未发布

### 新功能

- **照片整理**：新增 `qingshi_photo_scan`（只读），扫描文件夹或零散文件，纯 JS 解析拍摄时间（JPEG EXIF → PNG eXIf / tEXt → MP4 mvhd → 文件名 → 文件时间，逐级兜底）和 GPS，按「地点 + 时间」聚成「拍摄场次」（GPS 反查地名），并在已登录时给出与已有生涯记录的候选匹配（日期接近 + 地点距离）；支持 `offset` 分页，保证全部照片都能扫完。
- **批量保存照片**：新增 `qingshi_photo_save`，一组照片 = 一条生涯记录；分两步——先预览拿到每组标题/时间/张数/总大小，用户确认后 `confirm=true` 才真正上传；上传前自动核对云空间额度，不够就整体拒绝，不传一半；遍历所有分组并逐组报告结果。
- **查看存储额度**：新增 `qingshi_storage`（只读），读取 `/get_user_storage_quota`，显示总量 / 已用 / 预留 / 剩余 / 使用率，可传 `requiredBytes` 直接判断够不够。
- **给已有记录追加图片**：`qingshi_edit` 新增 `imagePaths`，上传后与原有图片合并回写，不覆盖已上传的图；支持 `dryRun` 预览，`dryRun` 时不上传。
- 工具总数 36 → **39**。

### 修复

- **HEIC 支持**：后端不支持 heic/heif，收到会明确提示「请先转成 JPG」。插件在上传前自动把 HEIC/HEIF 转成 JPG，再走与小程序 / H5 完全相同的三步上传。解码按 `sips`（macOS）→ Windows WIC（需系统装「HEIF 图像扩展」）→ `heif-convert` → `magick` → `ffmpeg` 依次尝试，全失败时给出可执行的安装提示；临时 JPG 在上传结束（成功或失败）后自动清理。
- 插件转换前会**先按文件名识别拍摄时间**（`IMG_20230815_091233.HEIC`、`mmexport1692000000000` 等）：转换器没带出 EXIF 时间时，把它写进 JPG 的 `DateTime` / `DateTimeOriginal`，并把文件修改时间也设为拍摄时间，保证后续分组和入库时间正确。
- **新增 `scripts/heic2jpg.py`**：批量/离线把 HEIC 转 JPG，**完整保留 EXIF**（拍摄时间 DateTimeOriginal、GPS 经纬度、机型、镜头），`--keep-time` 还能把输出文件的修改时间设为拍摄时间。依赖 `pip install pillow-heif`，已用含 GPS 的真实 HEIC 验证：转换后拍摄时间、机型、GPS 全部一致。
- 图片上传严格对齐青史标准上传链路（小程序 / H5 的 `utils/upload.js` 与后端 `validate_single_upload_request`），保证三端同一套逻辑：
  - 签名请求补齐 `custom_object_key`，字段命名与前端一致：`biz_type / of_uid / target_type / custom_object_key / file_name / file_size / content_type`
  - 上传前校验扩展名白名单（`career_media` 只允许 jpg/jpeg/png/webp/gif/mp4/mov/m4v/webm）、文件大小必须 > 0，错误提示在前端就给出，不再等后端拒
  - 文件名没有扩展名时按 `content_type` 自动补全（与前端 `ensureFileExtension` 一致）
  - 直传 OSS 的字段名固定 `file`，`form_data` 原样透传
  - 返回的 `upload_file_id` / `url` / `content_type` 优先取 `/confirm_oss_upload` 的结果
  - 新增 `test/upload.test.mjs` 固化这条契约（4 项断言）

## v0.24.0 (2026-11-24)

### 破坏性变更

- **数据目录固定到 `~/qingshi-plugin`**（Windows：`C:\Users\<你>\qingshi-plugin`，macOS / Linux：`~/qingshi-plugin`），不再按平台落到 APPDATA / Library / .config。老位置（%APPDATA%\qingshi、~/Library/Application Support/qingshi、~/.config/qingshi、~/.dsh/qingshi-workspace）的凭证、草稿、媒体会在首次启动时自动迁移过来。

### 新功能

- **MCP 协议升级**：支持 `2025-06-18` / `2025-03-26` / `2024-11-05` 协商，客户端报什么版本就回什么，未知版本回退到 `2025-06-18`。
- **MCP 工具注解**：每个工具带 `title`、`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`，Trae / Cline 等客户端据此决定是否弹确认。
- **多客户端 CLI**：一条命令把 MCP server 写进 Codex（TOML）、Trae / Claude Code / WorkBuddy / Cursor / Cline / Windsurf（JSON）的配置文件。幂等，写前自动备份。
- **自检命令**：`qingshi doctor` 真实 spawn MCP server 做握手并报告协议版本 / 工具数；`qingshi where` 打印数据目录。
- **新增 4 个 DSH 独有的工具**：`qingshi_skill`、`qingshi_family_add`、`qingshi_family_invite`、`qingshi_family_all`，工具总数 **36**。
- **工具参数 DSL → JSON Schema 自动转换**：MCP 层严格校验，保证 `inputSchema.type === object` 且 properties 合法（WorkBuddy 客户端最严格）。
- **Monorepo 结构**：`packages/core`（唯一内核）、`packages/dsh-adapter`（DSH 适配壳）、`packages/mcp-server`（标准 stdio MCP）、`packages/cli`（多客户端配置）；零依赖「拷贝即产物」构建。

### 修复

- `@deepseek-ai/dsh-tools` 改为可选 peer dependency，MCP 宿主不装它也能跑（用 try/catch 动态 import 回退）。
- `qingshi_where` 等数据工具在未登录时给出可读文案，不再抛异常。
- `qingshi_open_h5` 窗口自动化的 CDP 端口发现在 Windows 下更稳。
- 登录 token 从不进入工具参数或输出，只落本地 `auth.json`（0600）。

## v0.17.0 及以前

DSH 插件单体时期的版本，历史在 release 分支保留。
