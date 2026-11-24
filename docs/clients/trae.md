# Trae

```bash
node dist/cli/bin/qingshi.mjs install --client trae
```

默认写用户级 `%APPDATA%\Trae CN\User\mcp.json`（没有 Trae CN 时退回 `%APPDATA%\Trae\User\mcp.json`）：

```json
{
  "mcpServers": {
    "qingshi": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["E:\\path\\to\\dist\\mcp-server\\bin\\qingshi-mcp.mjs"]
    }
  }
}
```

## 项目级

```bash
qingshi install --client trae --scope project
```

写入当前目录 `.trae/mcp.json`，只对当前项目生效。

## 验证

1. `qingshi doctor --client trae`
2. 打开 Trae 的 MCP 面板，确认 `qingshi` 已加载并显示工具。
3. 在对话里让它调用 `qingshi_where`，应返回本机数据目录。

## 注意

- Trae 已运行时写配置可能需要重启窗口才会重新加载 MCP。
- 同一台机器上 Trae 与 Trae CN 是两份配置；CLI 优先写已经存在的那个，另一个需要用 `--config` 指定。
