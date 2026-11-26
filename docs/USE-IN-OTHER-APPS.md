# 接到别的客户端

目标：任何支持 stdio MCP 的客户端都能用，不依赖 DSH。

## 三步

1. 找到 node 和 server 的绝对路径：

   ```bash
   qingshi print --client codex
   ```

   输出里的 `command` 是 node，`args[0]` 是 `qingshi-mcp.mjs`。

2. 在客户端里添加 stdio 服务，名称 `qingshi`，命令与参数照抄。

3. 验证：

   ```bash
   qingshi doctor
   ```

   看到 `协议 … 工具 43 个` 就说明 server 正常；客户端里看不到工具，问题出在客户端配置而不是 server。

## 手动配置模板

JSON 类客户端（Trae / Cursor / Cline / Windsurf / Claude Code / WorkBuddy）：

```json
{
  "mcpServers": {
    "qingshi": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/qingshi-mcp.mjs"]
    }
  }
}
```

TOML 类（Codex）：

```toml
[mcp_servers.qingshi]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/qingshi-mcp.mjs"]
```

## 路径必须是绝对的

客户端启动子进程时工作目录不可控，相对路径会找不到入口。CLI 写配置时用的都是绝对路径。

## 多个客户端共存

它们共用同一份数据目录（默认 `~/qingshi-plugin`），登录一次即可。如果希望隔离（例如工作号/私人号），给某个客户端加环境变量：

```json
"env": { "QINGSHI_HOME": "/path/to/another/qingshi-home" }
```

## 不给客户端装东西的用法

只想临时试一下：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  | node dist/mcp-server/bin/qingshi-mcp.mjs
```

应返回一行 JSON；stderr 里是 `ready` 日志。
