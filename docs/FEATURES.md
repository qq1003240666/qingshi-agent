# 青史 Agent · 插件作用说明

> 本文档面向**终端用户**和**AI Agent**（MCP server 的 system instructions 也会参考这里的说法）。
> 完整安装指南见 [README.md](../README.md)，39 个工具的参数明细见 [docs/TOOLS.md](TOOLS.md)。

---

## 一句话是什么

**把微信小程序「青史永存」里的人生记录，接到你常用的 AI 客户端里。**

青史永存是一部**留给未来的电子史书**——帮助普通人留下属于自己的故事：每天的经历、人生的节点、家族的脉络。

- 小程序站点：[www.iyouwc.cn](https://www.iyouwc.cn)
- H5 应用：[qingshi.iyouwc.cn](https://qingshi.iyouwc.cn)

你在青史永存里记的每一条经历、拍的每一张照片、建的每一个家族节点——AI 现在能直接读、能帮你分析、能替你记新的一笔。不需要复制粘贴，不需要导出 Excel。

![核心场景](images/hero.jpg)

---

## 为什么要做这个

青史永存想做的不是另一个日记 App——它想做的是**一部留给未来的电子史书**：让每一个普通人都能轻松地为自己、为家人、为后代留下故事。

但光有存储不够。你写了几百条经历、建了十几代族谱——这些数据如果只是躺在一个小程序里，没有被阅读、被整理、被讲述，那它和没写差不多。AI 是最自然的阅读者和讲述者。

### 痛点

1. **你的人生数据被困在小程序里**。想让 AI 帮你回顾过去、整理履历、给家族写故事——AI 根本不知道这些数据的存在。
2. **换 AI 客户端要重配一切**。你在 DSH 写了 10 个自定义工具，换 Codex 用不了；换 Trae 又要重写一遍。
3. **AI 瞎编你的事**。"你 2019 年去过黄山"——不，你去的是泰山，AI 没有真实数据就只能凭印象。

### 解决

青史 Agent 做了三件事：

```
一份内核        →  同时给 DSH（原生气泡）和 MCP（39 个标准工具）用
一键配置        →  qingshi install --client <trae|codex|claude-code|...>
真实数据源      →  全部从青史永存后端实时拉，AI 永远读的是你最新的记录
```

---

## 能力全景（AI 能做什么）

### 🧬 身份与自我认知

你问 AI **"我是谁"**，它先调 `qingshi_me`——读青史里的昵称、生日、个性标签、个人简介——算出你今年多大，整理一段有温度的自我介绍。

```
你：我是谁？今年多大？
AI：（调 qingshi_me）你在青史里记录的昵称是"阿蒙"，1995 年 6 月 20 日生，
    今年 30 岁。个性标签是"爱旅行、爱摄影、偶尔写点东西"。
    你的简介写的是…
```

### 🧭 经历与回忆

你问 **"我去过哪些地方"** 或 **"给我讲讲我的故事"**，AI 调 `qingshi_find_experience` 拉全部生涯记录，按地点 / 时间 / 关键词过滤：

```
你：我去过哪些地方？按省份列一下。
AI：（调 qingshi_find_experience 加 startYear=2015）
    北京（2015-2017 读书、2018 工作）、山东（青岛旅行 2019）、
    云南（大理 2021 毕业旅行）、西藏（自驾 2023）、
    四川（成都 2024 公差）…一共 5 个省份 11 次出行。
```

### 👨‍👩‍👧 族谱与血缘

你问 **"我妈妈是谁"**，AI 不需要你描述关系——它自己：

1. `qingshi_family_all` 拉完整族谱
2. `qingshi_kinship` 找到妈妈的节点（算亲属称谓）
3. `qingshi_find_experience` 读妈妈的生涯记录
4. `qingshi_about_me` 拿妈妈的简介

```
你：我妈妈是谁？她这一生是怎么过来的？
AI：妈妈本名李秀英，1972 年生，今年 53 岁。
    青史里她建了 24 条生涯事件：
    - 1995 年 大学毕业分配到县医院
    - 2001 年 生了你
    - 2018 年 退休后开始学国画
    …
```

![族谱示例](images/family.jpg)

### ✍️ 记新的一笔

你随口说 **"今天去了趟青龙峡，风景真好"**，AI 不会只回"听起来不错"——它会：

1. `qingshi_tags` 看有哪些标签可选
2. 挑 `travel`（旅行）+ `scenery`（风景）
3. `qingshi_record` 整理成标准记录（**不传 `confirm: true` 只生成预览，不真写云端**）
4. 等你确认后才 `confirm: true` 写入

### 📷 一堆照片，整理成经历

你说 **"帮我整理一下这些照片到青史"** 并给一个相册目录（或直接把照片拖进对话），流程是：

1. `qingshi_photo_scan` 扫描目录，读出每张的**拍摄时间**（EXIF → 文件名 → 文件时间，三级兜底）和 **GPS**
2. 按**地点 + 拍摄时间**聚成「拍摄场次」，GPS 会反查成地名（如「大理市」），按时间顺序列给你看
3. 如果当前模型能读图，它看几张有代表性的照片，按照片内容起标题、写正文、选标签；读不了图就按时间地点命名并明确告诉你
4. 它把每组的**标题 / 正文 / 日期**列给你，问你是否保存
5. 你确认后，`qingshi_photo_save` 先调 `qingshi_storage` 核对云空间额度——**不够就整体拒绝，不会传一半**
6. 额度够就逐组上传图片并写入记录，最后报告每组结果和 event_id

如果某个场次和已有记录是同一次，它会用 `qingshi_edit` 追加图片，而不是新建重复记录。
整个扫描是**只读**的：不移动、不上传、不改任何文件。上传只在你确认之后才发生。

### 🪟 AI 直接操作青史页面

你说 **"打开青史"**，AI 调 `qingshi_open_h5` 弹出一个独立的 Chrome 应用窗口（没有地址栏，直接就是青史 H5）。之后可以：

- `qingshi_ui_goto` 跳到某个页面
- `qingshi_ui_click` 按文字或选择器点按钮
- `qingshi_ui_type` 填输入框
- `qingshi_ui_shot` 截图
- `qingshi_ui_tap` 在族谱无限画布上点坐标

整个过程窗口一直留在桌面上，用户随时能看到、能接管。

### 🔐 安全（AI 绝对不会做的事）

| 操作 | 闸门 |
|---|---|
| `qingshi_delete` | **带 `destructiveHint: true`**，客户端会弹确认框 |
| `qingshi_logout` | 同上 |
| `qingshi_record` 写云端 | 需要显式 `confirm: true`，否则只生成预览 |
| 读取 token | **永远不会**出现在工具参数或对话里，只存在本机 `~/qingshi-plugin/auth.json`（0600 权限） |

---

## 支持哪些 AI 客户端

一个 MCP server，覆盖 7 种主流客户端 + 1 种 DSH 原生插件：

```
           ┌─ DSH (DeepSeek Harness) ─── dsh-adapter 原生插件
           │
青史 Agent ─┼─ Codex CLI               ─── stdio MCP + ~/.codex/config.toml
           │
           ├─ Claude Code              ─── stdio MCP + claude mcp add
           │
           ├─ Trae / Trae CN           ─── stdio MCP + %APPDATA%\Trae CN\User\mcp.json
           │
           ├─ WorkBuddy                ─── stdio MCP + 界面粘贴
           │
           ├─ Cursor                   ─── stdio MCP + .cursor/mcp.json
           │
           ├─ Cline                   ─── stdio MCP + VS Code globalStorage
           │
           └─ Windsurf                 ─── stdio MCP + ~/.codeium/windsurf/mcp_config.json
```

多客户端同时使用时，**全部读写同一份青史数据**（登录态、草稿、族谱节点都共享）。

![多客户端](images/clients.jpg)

---

## 给 AI Agent 的 System Prompt

MCP server 在 `initialize` 阶段会自动注入以下系统指令，让模型知道怎么正确调用工具：

> **听到「打开青史」→ 先调 `qingshi_open_h5` 开窗，不要先解释、不要反问。**
>
> 「我是谁」「我多大」「我去过哪里」「给我讲讲我的故事」这类**没提青史、也没说清要查什么**的话，也要调工具。**不要回"我不知道你的信息"**——东西都在里面。
>
> 写记录时先调 `qingshi_tags` 挑好标签，再整理时间地点正文，调 `qingshi_record`。传 `confirm: true` 才真的写进云端。
>
> 操作族谱前先 `qingshi_family_all` 看清结构，再按需求选 `qingshi_family_expand` / `qingshi_kinship` / `qingshi_family_add`。
>
> 所有写操作工具（record / edit / delete / logout / family_add）在 MCP 层带了 `destructiveHint`，客户端会自动弹确认。

---

## 安全设计

![安全](images/security.jpg)

| 设计 | 说明 |
|---|---|
| **Token 隔离** | 存在本机 `~/qingshi-plugin/auth.json`（权限 0600），永远不会作为工具参数或工具输出的一部分出现 |
| **写闸门** | `qingshi_record` 不传 `confirm: true` 时只生成预览，不调用云端写入接口 |
| **破坏性标记** | `qingshi_delete`、`qingshi_logout` 等工具在 MCP schema 里带 `destructiveHint: true`，支持的客户端会弹确认框 |
| **窗口只连青史域** | H5 自动化操作的 URL 范围限制在 `qingshi.iyouwc.cn`，不会跳去任意外部 URL |
| **双 token 体系** | access_token 短过期 + refresh_token 自动续期，后端按 `uid + platform` 隔离，插件登录不会顶掉微信小程序登录 |
| **署名机制** | AI 协助录入的记录会在正文末尾追加「本条由 <客户端名> 协助录入」，用户知道哪些是 AI 写的 |

---

## 39 个工具一览（按功能分组）

### 登录 / 身份管理（5）
`qingshi_login` · `qingshi_save_login` · `qingshi_logout` · `qingshi_where` · `qingshi_me`

### 查资料 / 只读（6）
`qingshi_search` · `qingshi_find_experience` · `qingshi_tags` · `qingshi_about_me` · `qingshi_event` · `qingshi_pages`

### 记录 / 发布（7）
`qingshi_record` · `qingshi_edit` · `qingshi_delete` · `qingshi_restore` · `qingshi_set_privacy` · `qingshi_draft` · `qingshi_publish`

### 族谱（9）
`qingshi_family` · `qingshi_family_all` · `qingshi_family_add` · `qingshi_family_invite` · `qingshi_kinship` · `qingshi_open_event` · `qingshi_prepare_event` · `qingshi_family_expand` · `qingshi_family_layout`

### 照片整理与云空间（3）
`qingshi_photo_scan` · `qingshi_photo_save` · `qingshi_storage`

### 窗口自动化（9）
`qingshi_open_h5` · `qingshi_ui_read` · `qingshi_ui_goto` · `qingshi_ui_click` · `qingshi_ui_type` · `qingshi_ui_tap` · `qingshi_ui_shot` · `qingshi_skill` · `qingshi_profile`

### 详细参数表
见 [docs/TOOLS.md](TOOLS.md)（机器生成，自动与源码同步）。

---

## 谁适合用

| 人群 | 典型场景 |
|---|---|
| **青史永存的老用户** | 想让 AI 帮你整理过去、给家族写回忆录、分析人生轨迹 |
| **家族记录者** | 族谱维护、亲属称谓计算、家族故事收集 |
| **传记写作者** | 批量读取生涯事件、按主题筛选、生成叙事大纲 |
| **个人知识管理** | 把青史当作"人生时间线数据库"，让 AI 自由查询 |
| **DSH 深度用户** | 原生气泡体验 + 自动记录（autoRecord） |
| **多 AI 客户端用户** | 一份数据、一个 CLI、任意切换 |

---

## 快速上手（三分钟）

```bash
# 1. 下载 release tarball 并解压

# 2. 确认 Node 版本
node -v   # >= 22.4

# 3. 一键配置你的 AI 客户端
node dist/cli/bin/qingshi.mjs install --client trae      # 或 codex / claude-code / workbuddy / cursor / cline / windsurf

# 4. 验证
node dist/cli/bin/qingshi.mjs doctor

# 5. 打开 AI 客户端，说一句「打开青史」
#    弹出登录窗口 → 用青史永存的手机号登一次 → 以后不用再登
```

详细安装、各客户端手动配置路径、环境变量等，见 [README.md](../README.md)。

---

## 技术架构（给开发者）

```
packages/core/index.js          青史内核（39 个工具定义 + 登录流程 + 请求层）
packages/core/lib/             工具模块（request / browser / career-api / workspace / paths / tool-manifest ...）
packages/dsh-adapter/          DSH 原生适配（cordis.patch.yml / 安装器 / locale）
packages/mcp-server/mcp/       标准 MCP server（协议协商 / JSON Schema 转换 / annotations）
packages/cli/                  多客户端配置 CLI（install / uninstall / print / doctor / where / clients）
scripts/build.mjs              零依赖构建：把 core 摊平复制到 dist/ 三目录
```

构建产物：
- `dist/dsh-plugin/` — DSH 插件目录（解压后 `node dsh-plugin/install.mjs` 安装）
- `dist/mcp-server/` — MCP server（stdio 传输，被各家客户端 spawn）
- `dist/cli/` — 配置 CLI（`qingshi.cmd` 或 `node dist/cli/bin/qingshi.mjs`）

所有产物都是 JS/ESM + Node 内置模块，**零 npm install 依赖**。

---

## License

MIT — 自由使用、修改、分发。但**青史永存**本身（微信小程序 + 后端 API）是独立产品，青史 Agent 只是它的第三方接入工具。
