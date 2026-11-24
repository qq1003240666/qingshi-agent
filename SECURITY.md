# Security

## Token 不落对话、不落日志、不落 stdout

青史的登录凭证（`access_token` / `refresh_token`）**绝不**作为工具参数出现，也**绝不**写进任何工具返回的文本里。

- 存在 `~/qingshi-plugin/auth.json`（权限 0600，Windows 上 ACL 也只给当前用户）。
- MCP server 把 `console.log` / `console.info` / `console.debug` 全部重定向到 stderr，stdout 只走 JSON-RPC 协议行。任何 agent 只要按 MCP 标准读 stdout，永远看不到凭证。
- 所有请求通过 `X-Client-Platform` 与 `X-Client-Name` 署名，后端可追溯但不在工具层暴露。

## 危险操作闸门

- `qingshi_record` / `qingshi_edit` 等写云端数据的工具，不传 `confirm: true` 只返回预览文本，不真的提交。
- `qingshi_delete` 的 MCP 注解带 `destructiveHint: true`，支持此注解的客户端会弹确认框。
- `qingshi_logout` 同样标 `destructiveHint`，防止 agent 误登出。

## 窗口自动化的权限

`qingshi_open_h5` / `qingshi_ui_*` 系列工具操作的是本地 `qingshi.iyouwc.cn` H5 窗口，不会跳去任意 URL（除非显式 `route` 且在白名单路由里）。Electron 外壳只 load 授权的域。

## 第三方依赖

- 内核和 MCP server 运行时**零依赖**（只用 Node 内置模块）。
- `@deepseek-ai/dsh-tools` 是可选 peer，只在 DSH 宿主下才会被 import。
- Electron 随包附带但只在用户选 kiosk/app 窗口模式时用到；用户没装 Electron 会自动退回系统 Chrome/Edge 的 `--app` 模式。

## 报告漏洞

请直接发 PR 或 issue，不要在公开渠道披露。所有漏洞会在新版本修复并同步到 CHANGELOG。
