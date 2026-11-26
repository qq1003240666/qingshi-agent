# CHANGELOG

## 未发布

### 新功能

- **照片整理**：新增 `qingshi_photo_scan`（只读），扫描文件夹或零散文件，纯 JS 解析拍摄时间（JPEG EXIF → PNG eXIf / tEXt → MP4 mvhd → 文件名 → 文件时间，逐级兜底）和 GPS，按时间间隔 + 距离聚成「拍摄场次」，并在已登录时给出与已有生涯记录的候选匹配（日期接近 + 地点距离）。
- **给已有记录追加图片**：`qingshi_edit` 新增 `imagePaths`，上传后与原有图片合并回写，不覆盖已上传的图；支持 `dryRun` 预览，`dryRun` 时不上传。
- 工具总数 36 → **37**。

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
