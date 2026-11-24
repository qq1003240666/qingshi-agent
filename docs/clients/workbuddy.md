# WorkBuddy

WorkBuddy 的 MCP 服务通常在应用内「连接器 / MCP」界面添加，没有稳定的配置文件路径，因此 CLI 默认只打印片段：

```bash
node dist/cli/bin/qingshi.mjs print --client workbuddy
```

把输出填进界面里的 stdio 服务：

- 名称：`qingshi`
- 命令：输出里的 `command`
- 参数：输出里的 `args`（只有一项，指向 `qingshi-mcp.mjs`）

## 已知配置文件时

```bash
qingshi install --client workbuddy --config <WorkBuddy 的 mcp.json 路径>
```

这样会按 JSON 合并写入，并在写入前备份。

## 验证

```bash
qingshi doctor
```

`doctor` 不依赖 WorkBuddy，直接拉起 server 握手；这一步通过就说明 server 本身没问题，剩下的只是客户端有没有正确启动它。

## 注意

- WorkBuddy 对 `inputSchema` 校验较严格；本项目在 MCP 层把参数表统一转成合法 JSON Schema，`type` 显式为 `object`。
- 工具注解（`readOnlyHint` / `destructiveHint`）会被用来决定是否弹确认框。
