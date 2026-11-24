# Cline

```bash
node dist/cli/bin/qingshi.mjs install --client cline
```

写入 VS Code 的 Cline 扩展配置：

- Windows：`%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
- macOS：`~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`

## 验证

在 Cline 的 MCP Servers 面板点刷新，`qingshi` 应为绿色已连接。

## 注意

- 如果你用的是 VS Code Insiders / VSCodium，配置目录不同，用 `--config` 直接指定。
- 写入前会自动备份；内容一致时不会改动文件。
