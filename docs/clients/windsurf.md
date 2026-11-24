# Windsurf

```bash
node dist/cli/bin/qingshi.mjs install --client windsurf
```

写入 `~/.codeium/windsurf/mcp_config.json`：

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

## 验证

Windsurf 的 Cascade → MCP 面板里刷新后应看到 `qingshi`。

## 注意

- Windsurf 运行时写配置后建议重启窗口。
- 与其他客户端共用同一份数据目录，登录一次即可。
