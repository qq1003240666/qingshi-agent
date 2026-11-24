# 插件市场提交指南

青史 Agent 是一个**双形态**工具：既是 DSH 原生插件，也是标准 MCP server。下面按平台列出上线步骤，分为「能自动/半自动」和「需要手动审核」两类。

---

## ✅ 一、零成本自动收录（立刻生效）

### 1. GitHub Topics → DSH 社区插件市场（6+ 个站点自动收录）

**DSH 生态的插件市场靠 GitHub topics 自动发现**。把下面 topics 加到仓库 `Settings → Topics`：

| Topic | 作用 |
| --- | --- |
| `dsh-plugin` | DSH 插件索引核心标记 |
| `deepseek-harness` | DSH 别名，同样被收集器识别 |
| `mcp-server` | MCP 生态交叉索引 |
| `mcp` / `model-context-protocol` | MCP 通用标记 |
| `qingshi` / `青史` | 品牌名 |
| `ai-tools` | AI 工具通用标记 |
| `life-diary` / `family-tree` / `genealogy` | 功能分类 |

收录站点（每天自动扫描，通常 1-3 天出现）：
- [dshopen.org](https://dshopen.org/zh/) — DSH 开放插件市场
- [dshplugins.com](https://dshplugins.com/) — DSH 插件目录（带人工审核）
- [dshplugin.store](https://www.dshplugin.store/) — DSH Plugin Store
- [dshplugin.app](https://dshplugin.app/) — DSH Plugin Registry

设置步骤：
1. 打开 https://github.com/qq1003240666/qingshi-agent
2. 点击仓库名右边的 ⚙️ **齿轮 (Settings)**
3. 滚到最下面 **Topics** 区域
4. 粘贴上面的 topics（按空格分隔）
5. 保存

**同时**在 `packages/dsh-adapter/package.json` 的 `keywords` 字段加 `dsh-plugin` 和 `deepseek-harness`——有些站点读 npm 包的 keywords。

---

### 2. awesome-mcp-servers 提 PR（MCP 官方 Awesome 列表）

仓库：https://github.com/modelcontextprotocol/awesome-mcp-servers

步骤：
1. Fork + Clone 该仓库
2. 在适合的分类下（比如「Productivity & Lifelong」或「Data & Analytics」）加一行：

```markdown
- **[qingshi-agent](https://github.com/qq1003240666/qingshi-agent)** — 青史记录系统 MCP server：36 个工具，覆盖登录、记录、族谱（亲属称谓计算）、窗口自动化。标准 stdio MCP，支持 Codex / Claude Code / Trae / WorkBuddy / Cursor / Cline / Windsurf。Node.js (MIT)
```

3. 提 PR，描述里说清楚：这个 MCP server 同时也是 DSH 插件（dsh-adapter），一份内核两种形态。

---

### 3. Protodex（通用 MCP Server 目录）

https://protodex.io/submit

步骤：
1. 打开页面
2. 填 GitHub 仓库 URL：`https://github.com/qq1003240666/qingshi-agent`
3. 选 MCP server 类型：`stdio`
4. 等审核（官方说 7 天内）

也可以通过 GitHub Issue 快速提交：在 Protodex repo 开 issue，标题 `Add qingshi-agent MCP Server`。

---

## 📝 二、需要手动提交（有审核流程）

### 4. Claude Directory（Anthropic 官方插件目录）

入口：https://claude.ai/directory/manage（需要 **付费 Claude Pro/Max 计划**）

青史 Agent 属于 **MCP connector**（不是 Plugin bundle，因为没有 skills）：

准备材料：
- [x] GitHub 仓库：`https://github.com/qq1003240666/qingshi-agent`（已公开）
- [x] 文档 URL：指向 README.md 的「快速上手」章节
- [x] Privacy Policy URL：如果没有，用 GitHub 仓库的 `SECURITY.md` 或 `LICENSE` 页说明数据处理
- [x] Icon：`packages/dsh-adapter/icon.svg`（已有）
- [x] Screenshots：**需要截图**——至少一张显示工具列表、一张显示实际使用效果

提交步骤：
1. 登录 claude.ai/directory/manage
2. 选 **Submit new → Connector pre-submission checklist**
3. 填 GitHub URL，走 checklist
4. 提交后等审核（通常 1-3 天）

---

### 5. Codex Plugin Directory（OpenAI 官方插件目录）

入口：https://developers.openai.com/plugins

青史 Agent 属于 **Plugin with MCP server**（Codex Plugin 支持 bundling MCP server）：

准备材料：
- [x] GitHub 仓库（公开）
- [x] 安装方式文档（README 的「快速上手」章节）
- [x] 截图（至少 1 张）
- [ ] MCP server 测试（在 ChatGPT developer mode 里跑通）

提交步骤：
1. 打开 https://agents/plugins/catalog → Plugin Submission Portal
2. 扫 server、填 listing copy、上传截图
3. 提交后在 portal 里 track 状态
4. 审核通过后你自己 publish（Portal 不给自动发布）

---

### 6. Trae MCP 市场（字节内置市场）

**Trae CN / Trae 桌面版内置了 MCP 市场**（`Settings → MCP → 从市场添加`），目前**没有公开的开发者提交入口**。市场里的 MCP server 似乎是 Trae 团队手动精选的。

进入 Trae 市场的可能路径：
1. 在 Trae 社区发帖推荐（https://forum.trae.ai 或飞书群）
2. 通过火山引擎开发者渠道联系（docs.volcengine.com/docs/trae-cn）
3. 先在 awesome-mcp-servers 里通过，Trae 团队可能会参考

**临时替代方案**：Trae 用户可以直接 `qingshi install --client trae`（CLI 写 `%APPDATA%\Trae CN\User\mcp.json`），不需要市场。

---

### 7. Cursor / Cline / Windsurf / WorkBuddy

**这四家没有正式插件市场**。它们的 MCP server 通过配置文件注册，不是中央商店。

但可以在社区目录里被发现：
- Cursor：[Cursor MCP Servers 仓库](https://github.com/modelcontextprotocol/awesome-mcp-servers)（和上面 awesome-mcp-servers 同一个）
- Cline：在 Cline 的文档里可以提 PR 加 MCP server 推荐
- Windsurf：Windsurf 有 [Extensions Marketplace](https://windsurf.com/marketplace)，但目前扩展主要是主题和语法高亮，MCP server 通过配置文件注册
- WorkBuddy：通过 WorkBuddy 的配置界面手动添加

---

## 🔧 提交清单 Checklist

在开始提交前确认：

- [x] GitHub repo 公开
- [x] `package.json` 有 keywords（root + dsh-adapter 都有）
- [ ] GitHub Topics 已加（至少 `dsh-plugin`、`mcp-server`）
- [x] README.md 有完整的快速上手（已重写为用户视角）
- [x] 有 icon（`icon.svg`）
- [ ] 至少 3 张截图（工具列表、实际使用、CLI doctor 输出）
- [x] 有 LICENSE（MIT）
- [x] 有 SECURITY.md（说明 token 处理）
- [x] Release v0.24.0 已发（tarball + sha256）
- [x] `qingshi doctor` 真实握手验证通过（协议 2025-06-18、工具 36 个）

---

## 总结：优先级排序

| 优先级 | 平台 | 成本 | 等待 |
| --- | --- | --- | --- |
| 🥇 立即 | GitHub Topics（DSH 自动收录） | 0 | 1-3 天 |
| 🥈 本周 | awesome-mcp-servers 提 PR | 0 | PR merge |
| 🥉 本周 | Protodex 提交 | 0 | 7 天 |
| 4. | Claude Directory | 需付费计划 | 1-3 天 |
| 5. | Codex Plugin Directory | 需 submission portal | 不确定 |
| 6. | Trae MCP 市场 | 无公开入口 | 不确定 |
| 7. | Cursor/Cline 等 | 无市场 | — |
