# Cursor

```bash
node dist/cli/bin/qingshi.mjs install --client cursor
```

默认写项目 `.cursor/mcp.json`；用户级用：

```bash
qingshi install --client cursor --scope user
```

写入 `~/.cursor/mcp.json`。

## 验证

在 Cursor 的 MCP 设置里应看到 `qingshi` 为已连接，工具列表与 [docs/TOOLS.md](../TOOLS.md) 一致。

## 注意

- Cursor 有时会缓存 MCP 列表，改配置后重开窗口。
- 如果只想看片段手动粘贴：`qingshi print --client cursor`。
