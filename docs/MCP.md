# MCP 协议说明

## 传输

stdio，一行一条 JSON-RPC 2.0 消息。**stdout 只走协议**，任何日志都写 stderr。

入口：`dist/mcp-server/bin/qingshi-mcp.mjs`，启动后 stderr 会打印 `qingshi-mcp ready: <N> tools`。

## 握手

客户端 `initialize` 里报的协议版本，命中就原样回显，否则回最新支持的版本：

| 版本 | 状态 |
| --- | --- |
| `2025-06-18` | 支持 |
| `2025-03-26` | 支持 |
| `2024-11-05` | 兼容 |

返回：

```json
{
  "protocolVersion": "2025-06-18",
  "capabilities": { "tools": { "listChanged": false } },
  "serverInfo": { "name": "qingshi", "version": "0.24.0" },
  "instructions": "…"
}
```

`clientInfo.name` 会被记下来，写记录时用于署名（例如 `—— 本条由 claude-code 协助录入`）。

## 工具

`tools/list` 返回的每个工具有：

- `name`、`title`、`description`
- `inputSchema`：合法 JSON Schema（`type: "object"`、`properties`，必要时 `required`）
- `annotations`：`readOnlyHint`、`destructiveHint`、`idempotentHint`、`openWorldHint`

注解来自 `packages/core/lib/tool-manifest.js`，是单一事实来源；测试会校验每个注册工具都登记了元数据。

## 调用结果

统一返回文本：

```json
{ "content": [{ "type": "text", "text": "…" }], "isError": false }
```

工具内部出错不会抛给协议层，而是 `isError: true` 并把原因写进 text，避免客户端直接断连。

## 支持的方法

| 方法 | 说明 |
| --- | --- |
| `initialize` | 握手、协商版本、返回 instructions |
| `notifications/initialized` | 通知，不回复 |
| `ping` | 返回空 result |
| `tools/list` | 全部工具 |
| `tools/call` | 执行工具 |
| `resources/list` / `prompts/list` | 返回空数组 |

未知方法返回 `-32601`，未知工具返回 `-32602`，JSON 解析失败返回 `-32700`。

## 环境变量

与 CLI/插件一致，见 [README](../README.md#环境变量)。MCP 客户端配置里可以用 `env` 覆盖，例如：

```json
{
  "mcpServers": {
    "qingshi": {
      "command": "node",
      "args": ["…/qingshi-mcp.mjs"],
      "env": { "QINGSHI_CLIENT_NAME": "claude-code" }
    }
  }
}
```
