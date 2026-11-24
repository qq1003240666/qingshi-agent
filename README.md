# 青史 Agent

把「青史」的记录能力接到你常用的 AI 编程 / 聊天客户端里。支持 Codex、Claude Code、Trae、WorkBuddy、Cursor、Cline、Windsurf，一份工具同时用在所有客户端。

---

## 快速上手（三分钟）

### 1. 确认环境

需要 **Node.js >= 22.4**。

```bash
node -v   # 应该是 v22.4 或更新
```

没有？Windows 跑 `winget install OpenJS.NodeJS.LTS`，macOS 跑 `brew install node@22`，或去 [nodejs.org](https://nodejs.org/) 下载 LTS。

### 2. 下载并解压

从 [Releases](https://github.com/qq1003240666/qingshi-agent/releases) 下载 `qingshi-<version>.tar.gz`，解压到任意目录。

### 3. 一键配置你的 AI 客户端

```bash
# Trae
node dist/cli/bin/qingshi.mjs install --client trae

# Codex CLI
node dist/cli/bin/qingshi.mjs install --client codex

# Claude Code
node dist/cli/bin/qingshi.mjs install --client claude-code

# 想装哪个就装哪个，支持同时装多个
```

Windows 解压后也可以直接用 `qingshi.cmd install --client trae`。

### 4. 验证

```bash
node dist/cli/bin/qingshi.mjs doctor
```

应该看到类似：

```
Node 22.x.x  OK
MCP server  <你的解压目录>/dist/mcp-server/bin/qingshi-mcp.mjs
协议  2025-06-18  server qingshi@0.24.0
工具  36 个
instructions 已注入

自检通过
```

然后打开 AI 客户端，说一句「打开青史」——会弹出登录窗口。登录一次，以后所有客户端共用同一份数据。

---

## 支持的客户端

| 客户端 | 一键配置 | 手动配置路径 | 逐家说明 |
| --- | --- | --- | --- |
| **Trae / Trae CN** | `qingshi install --client trae` | `%APPDATA%\Trae CN\User\mcp.json` | [docs/clients/trae.md](docs/clients/trae.md) |
| **Codex CLI** | `qingshi install --client codex` | `~/.codex/config.toml` | [docs/clients/codex.md](docs/clients/codex.md) |
| **Claude Code** | `qingshi install --client claude-code` | `.mcp.json`（`claude mcp add` 也行） | [docs/clients/claude-code.md](docs/clients/claude-code.md) |
| **WorkBuddy** | `qingshi print --client workbuddy` | 界面里「连接器 / MCP」粘贴片段 | [docs/clients/workbuddy.md](docs/clients/workbuddy.md) |
| **Cursor** | `qingshi install --client cursor` | `.cursor/mcp.json` | [docs/clients/cursor.md](docs/clients/cursor.md) |
| **Cline** | `qingshi install --client cline` | VS Code globalStorage | [docs/clients/cline.md](docs/clients/cline.md) |
| **Windsurf** | `qingshi install --client windsurf` | `~/.codeium/windsurf/mcp_config.json` | [docs/clients/windsurf.md](docs/clients/windsurf.md) |

DSH（DeepSeek Harness）用户：下载 `dsh-plugin/` 目录或整套 release，然后运行 `node dsh-plugin/install.mjs`，或手动跑 `bin/install-to-harness.cmd`。

---

## CLI 命令

```text
qingshi install       写入客户端配置（--dry-run 只看不写，--force 覆盖已有条目）
qingshi uninstall     移除配置（会先备份）
qingshi print         只打印配置片段，适合粘贴到图形界面
qingshi doctor        检查 Node / server 路径 / 配置，并真实握手、列出工具数
qingshi where         打印青史数据目录
qingshi clients       列出支持的客户端
```

通用选项：`--client <id>`、`--scope user|project`、`--config <file>`、`--dry-run`、`--force`、`--json`。

配置写入前会把原文件备份成 `<file>.bak-<时间戳>`；如果现有配置和要写的完全一致，不会重复写。

---

## 工具清单（36 个）

### 登录 / 身份

| 工具 | 说明 |
| --- | --- |
| `qingshi_login` | 登录青史。会弹出短信验证码页面，AI 帮你填手机号和验证码 |
| `qingshi_save_login` | 把凭证存到本机（内部用） |
| `qingshi_logout` | 退出登录（会让所有客户端一起失效） |
| `qingshi_where` | 数据目录在哪、里面有什么 |

### 查资料（全部只读）

| 工具 | 说明 |
| --- | --- |
| `qingshi_me` | 我的资料（头像、生日、签名、标签） |
| `qingshi_profile` | 修改资料（生日 / 签名 / 标签等） |
| `qingshi_search` | 搜索用户（名字 / uid / 手机号片段） |
| `qingshi_find_experience` | 查生涯记录（关键词、标签、时间范围） |
| `qingshi_tags` | 所有标签的使用频次 |
| `qingshi_about_me` | 一段个人简介（让 AI 自我介绍时用） |
| `qingshi_pages` | 青史 H5 所有页面的路由地图 |
| `qingshi_event` | 读某条事件的完整详情 |

### 记录与发布

| 工具 | 说明 |
| --- | --- |
| `qingshi_record` | 记一条生涯事件（标题、正文、标签、时间、地点、图片）。**不传 `confirm: true` 时只生成预览，不真的写入云端** |
| `qingshi_edit` | 修改已有事件 |
| `qingshi_delete` | 删除事件（带破坏性标记，AI 客户端会弹确认） |
| `qingshi_restore` | 从回收站恢复事件 |
| `qingshi_set_privacy` | 设置事件隐私（公开 / 亲友可见 / 仅自己） |
| `qingshi_draft` | 把待发布内容打包成草稿 |
| `qingshi_publish` | 发布草稿 |

### 族谱

| 工具 | 说明 |
| --- | --- |
| `qingshi_family` | 族谱分层导航（只看一层，返回子节点列表） |
| `qingshi_family_all` | 拉完整族谱（适合第一次打开时看全貌） |
| `qingshi_family_add` | 添加一个新成员 |
| `qingshi_family_invite` | 生成邀请二维码 |
| `qingshi_kinship` | 算两个节点之间的亲属称谓（表哥 / 姨奶 等） |
| `qingshi_open_event` | 打开某条事件的 H5 页面 |
| `qingshi_prepare_event` | 为创建 / 编辑事件准备好页面状态 |
| `qingshi_family_expand` | 展开某个节点查看下一层 |
| `qingshi_family_layout` | 调整族谱里某个节点的位置 |

### 窗口自动化（需要弹出青史 H5 窗口）

| 工具 | 说明 |
| --- | --- |
| `qingshi_open_h5` | 弹出一个 Chrome / Edge 应用窗口（无地址栏、无标签页） |
| `qingshi_ui_read` | 读取当前页面：标题、文本、按钮、输入框 |
| `qingshi_ui_goto` | 窗口内跳转 |
| `qingshi_ui_click` | 按文字或选择器点击 |
| `qingshi_ui_type` | 往输入框填值 |
| `qingshi_ui_tap` | 在画布坐标上点一下（族谱无限画布专用） |
| `qingshi_ui_shot` | 窗口截图 |
| `qingshi_skill` | 返回"AI 操作青史技能"的完整文本（首次加载会看到） |

完整说明和参数见 [docs/TOOLS.md](docs/TOOLS.md)。

---

## 数据放在哪

| 系统 | 路径 |
| --- | --- |
| Windows | `C:\Users\<你>\qingshi-plugin\` |
| macOS | `/Users/<你>/qingshi-plugin/` |
| Linux | `~/qingshi-plugin/` |

里面：

```
auth.json              登录凭证（只本机可读）
drafts.json            待发布草稿
users.json             搜过的用户缓存
browser-profile/       浏览器登录态（Chrome 用户数据目录）
browser-window.json    上次开的窗口位置和尺寸
media/                 事件配图（上传过的）
```

所有客户端共用同一份数据——在 Trae 里登录，Codex 打开时已经是登录状态，反之亦然。

### 想换位置？

设环境变量 `QINGSHI_HOME=/你/想/放/的/位置`，下次启动生效。

### 升级会不会丢数据？

不会。老版本在 `%APPDATA%\qingshi`、`~/Library/Application Support/qingshi`、`~/.config/qingshi`、`~/.dsh/qingshi-workspace` 里的数据，首次启动新版本时会**自动搬过去**（只补缺，不覆盖）。

---

## 给 AI Agent 的使用要点

MCP server 的 `initialize` 会注入一段 system instructions，让模型知道怎么正确调用工具。下面是摘要，你可以作为 AI 自定义指令使用：

> **最优先：用户说「打开青史」→ 先调 `qingshi_open_h5` 开窗，不要先解释、不要反问。**
>
> 「我是谁」「我多大」「我去过哪里」「给我讲讲我的故事」这类没提青史的话，也要调工具：先 `qingshi_me` 拿身份，再按需 `qingshi_find_experience` / `qingshi_family`。**不要回"我不知道你的信息"**——东西都在里面。
>
> 写记录时：先按标签挑好（`qingshi_tags` 可查），再把时间、地点、正文整理好，调 `qingshi_record`。传 `confirm: true` 才真的写进云端。
>
> 操作族谱前先 `qingshi_family_all` 看清结构，再按需求选 `qingshi_family_expand` / `qingshi_kinship` / `qingshi_family_add`。
>
> 所有写操作工具（record / edit / delete / logout / family_add / family_invite）在 MCP 层带了 `destructiveHint` 或非只读标记，客户端会自动弹确认。

---

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `QINGSHI_HOME` | 强制指定数据目录 |
| `QINGSHI_CLIENT_NAME` | 写记录时的署名，会自动拼到正文末尾（例如 `trae` / `codex`） |
| `QINGSHI_BROWSER` | 指定 Chrome / Edge 可执行文件路径（自动查找失败时用） |
| `QINGSHI_BROWSER=none` | 测试 / 无界面环境里彻底关掉浏览器 |
| `QINGSHI_API_BASE_URL` | 后端地址（默认 `https://api.iyouwc.cn`） |
| `QINGSHI_WEB_BASE_URL` | H5 站点（默认 `https://qingshi.iyouwc.cn`） |

---

## 安全要点

- **Token 不经过对话**：`auth.json` 只存在本机（权限 0600），永远不会出现在工具参数或输出里。
- **写操作有闸门**：`qingshi_record`、`qingshi_edit` 等不传 `confirm: true` 只给预览，不真的写云端。
- **危险工具显式标记**：`qingshi_delete`、`qingshi_logout` 等带 `destructiveHint: true`，支持的客户端会自动弹确认框。
- **窗口只连青史域**：H5 自动化只操作 `qingshi.iyouwc.cn` 页面，不会跳去任意 URL。

详细见 [SECURITY.md](SECURITY.md)。

---

## 开发与贡献

```bash
npm run build        # 生成 dist/（零依赖，直接拷贝）
node test/_review.mjs  # 静态审查（manifest 覆盖 / 文档漂移 / 安全）
node test/agent-compat.mjs  # MCP 协议兼容性（15 项）
npm run gen-docs     # 刷新 docs/TOOLS.md 与 README 工具表
npm run check-docs   # CI 用：文档与源码不一致就失败
npm run pack         # 生成 artifacts/qingshi-<version>.tar.gz + sha256
```

完整开发指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

MIT
