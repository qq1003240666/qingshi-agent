# 青史 Agent

把「青史」的记录能力接到主流 AI 编程 / 聊天客户端里。核心思路：**一份内核 + 三种适配**。

```
           ┌─────────────────┐
           │   packages/core │  ← 唯一的工具定义、登录、请求层、族谱自动化
           └────────┬────────┘
                    │ 被三个适配层消费
        ┌───────────┼───────────┐
        ▼           ▼           ▼
  dsh-adapter  mcp-server     cli
  DSH 宿主壳    标准 stdio     一键配置
  cordis patch MCP            写各家配置
  locale / 安装器
```

- **dsh-adapter**：给 DeepSeek Harness 用，提供 `cordis.patch.yml`、locale、安装器。内核直接 import core，没有独立实现。
- **mcp-server**：标准 stdio MCP。Claude Code、Codex、Cursor、Cline、Windsurf、WorkBuddy、Trae **全部走这一条**——不需要给每家做一份 plugin 目录。
- **cli**：一条命令把 mcp-server 写进各家客户端的配置文件（JSON / TOML）。

## 快速开始

### 从 Release 安装（推荐）

1. 下载 `qingshi-<version>.tar.gz` 并解压。
2. 确认 Node >= 22.4。
3. 写配置：

```bash
node dist/cli/bin/qingshi.mjs install --client trae
node dist/cli/bin/qingshi.mjs doctor
```

Windows 解压后也可以直接用 `qingshi.cmd install --client trae`。

### 从源码

```bash
npm run build
node dist/cli/bin/qingshi.mjs install --client claude-code --scope project
```

构建是零依赖的「拷贝即产物」：把 `packages/core` 摊平复制到 `dist/dsh-plugin`、`dist/mcp-server`、`dist/cli`，不打包、不转译。

## 支持的客户端

| 客户端 | 命令 | 配置文件 |
| --- | --- | --- |
| Claude Code | `qingshi install --client claude-code` | 项目 `.mcp.json`，用户级用 `claude mcp add` |
| Codex CLI | `qingshi install --client codex` | `~/.codex/config.toml` |
| Trae | `qingshi install --client trae` | `%APPDATA%\Trae CN\User\mcp.json` |
| WorkBuddy | `qingshi print --client workbuddy` | 界面里添加 stdio 服务，或用 `--config` |
| Cursor | `qingshi install --client cursor` | `.cursor/mcp.json` |
| Cline | `qingshi install --client cline` | VS Code globalStorage |
| Windsurf | `qingshi install --client windsurf` | `~/.codeium/windsurf/mcp_config.json` |

逐家说明见 [docs/clients](docs/clients)。

## CLI

```text
qingshi install    写入客户端配置（--dry-run 只看不写，--force 覆盖已有条目）
qingshi uninstall  移除配置（会先备份）
qingshi print      只打印片段，适合粘贴到图形界面
qingshi doctor     检查 Node / server 路径 / 配置，并真实握手、列出工具数
qingshi where      打印青史数据目录
qingshi clients    列出支持的客户端
```

通用选项：`--client <id>`、`--scope user|project`、`--config <file>`、`--dry-run`、`--force`、`--json`。

写文件前会把原文件备份成 `<file>.bak-<时间戳>`；配置已经一致时不会重复写。

## 工具清单

<!-- TOOLS:START -->
| 工具 | 标题 | 类型 |
| --- | --- | --- |
| `qingshi_login` | 登录青史 | 写入 |
| `qingshi_save_login` | 保存登录凭证 | 写入 |
| `qingshi_where` | 查看数据目录 | 只读 |
| `qingshi_me` | 查看我的资料 | 只读 |
| `qingshi_search` | 搜索用户 | 只读 |
| `qingshi_find_experience` | 查找经历 | 只读 |
| `qingshi_record` | 记录生涯事件 | 写入 |
| `qingshi_tags` | 查看标签 | 只读 |
| `qingshi_about_me` | 读取个人简介 | 只读 |
| `qingshi_profile` | 修改个人资料 | 写入 |
| `qingshi_set_privacy` | 设置事件隐私 | 写入 |
| `qingshi_draft` | 生成待发布草稿 | 写入 |
| `qingshi_publish` | 发布草稿 | 写入 |
| `qingshi_open_h5` | 打开青史窗口 | 本地窗口 |
| `qingshi_ui_read` | 读取窗口内容 | 只读 |
| `qingshi_ui_goto` | 窗口内跳转 | 本地窗口 |
| `qingshi_ui_click` | 窗口内点击 | 本地窗口 |
| `qingshi_ui_type` | 窗口内输入 | 本地窗口 |
| `qingshi_ui_tap` | 窗口内轻触 | 本地窗口 |
| `qingshi_ui_shot` | 窗口截图 | 只读 |
| `qingshi_pages` | 查看页面地图 | 只读 |
| `qingshi_event` | 读取事件详情 | 只读 |
| `qingshi_edit` | 修改事件 | 危险写 |
| `qingshi_delete` | 删除事件 | 危险写 |
| `qingshi_restore` | 恢复事件 | 写入 |
| `qingshi_family` | 族谱分层导航 | 只读 |
| `qingshi_kinship` | 计算亲属称谓 | 只读 |
| `qingshi_open_event` | 打开事件页面 | 写入 |
| `qingshi_prepare_event` | 准备事件页面 | 写入 |
| `qingshi_family_expand` | 展开族谱节点 | 写入 |
| `qingshi_family_layout` | 调整族谱布局 | 本地窗口 |
| `qingshi_logout` | 退出登录 | 危险写 |
| `qingshi_skill` | 读取操作技能 | 写入 |
| `qingshi_family_add` | 添加族谱成员 | 写入 |
| `qingshi_family_invite` | 生成族谱邀请码 | 写入 |
| `qingshi_family_all` | 读取完整族谱 | 只读 |
<!-- TOOLS:END -->

完整的说明见 [docs/TOOLS.md](docs/TOOLS.md)。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `QINGSHI_API_BASE_URL` | 后端地址，默认 `https://api.iyouwc.cn` |
| `QINGSHI_WEB_BASE_URL` | H5 站点，默认 `https://qingshi.iyouwc.cn` |
| `QINGSHI_HOME` | 数据目录（token、草稿、截图） |
| `QINGSHI_CLIENT_NAME` | 写记录时的署名，例如 `claude-code` |
| `QINGSHI_ALLOW_FAMILY_WRITE` | `1` 允许族谱写入 |
| `QINGSHI_LOGIN_TIMEOUT_MS` | 登录等待时长 |

数据默认落在用户目录下的 `qingshi-plugin`（Windows：`C:\Users\<你>\qingshi-plugin`，macOS：`~/qingshi-plugin`，Linux：`~/qingshi-plugin`）。登录凭证只存在本机 `auth.json`（权限 0600），不会出现在工具参数或输出里。

## 开发

```bash
npm run build       # 生成 dist/
npm test            # node:test，跑 dist 产物
npm run gen-docs    # 刷新 docs/TOOLS.md 与 README 工具表
npm run check-docs  # CI 用：文档与源码不一致就失败
npm run pack        # artifacts/qingshi-<version>.tar.gz + sha256
```

目录：

```text
packages/core         内核：36 个工具定义、登录、请求层、族谱自动化、窗口壳
packages/dsh-adapter  DSH 宿主适配壳：cordis.patch.yml / locale / 安装器（内核 = core）
packages/mcp-server   标准 stdio MCP 适配层（codex / claude-code / trae / workbuddy …全走它）
packages/cli          多客户端配置 CLI：一键写各家配置文件
scripts               构建、文档、打包
test                  node:test 测试
```

## 为什么没有 codex-adapter / claude-code-adapter？

因为 Codex、Claude Code、Trae、WorkBuddy、Cursor、Cline、Windsurf **全部支持 MCP**，只要有一份 stdio server + 一份配置文件即可。CLI 已经覆盖了 7 种客户端的配置写入路径和格式，新增客户端只需在 CLI 的 `CLIENTS` 表里加一行路径映射。

DSH 之所以需要单独的 adapter，是因为它有自己的插件加载机制（cordis.patch.yml + Harness profile 安装器），不是 MCP 驱动的。

## 安全

见 [SECURITY.md](SECURITY.md)。要点：token 不经过对话、不落日志；写操作默认要用户确认；`qingshi_delete` 等危险工具在 MCP 层带 `destructiveHint`。

## License

MIT
