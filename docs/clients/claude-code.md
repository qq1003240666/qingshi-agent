# Claude Code

## 项目级（推荐，团队共享）

在项目根目录执行：

```bash
node dist/cli/bin/qingshi.mjs install --client claude-code --scope project
```

会写入 `.mcp.json`：

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

`command` 用的是运行 CLI 时的 node 绝对路径，换机器后重新执行一次即可。

## 用户级

Claude Code 官方建议用命令而不是手改 `~/.claude.json`：

```bash
claude mcp add qingshi -- <node 路径> <qingshi-mcp.mjs 路径>
```

先用 `qingshi print --client claude-code` 拿到两个路径。

## 验证

```bash
qingshi doctor --client claude-code --scope project
```

在 Claude Code 里执行 `/mcp` 应能看到 `qingshi` 以及工具数量。

## 注意

- 不要把 `auth.json` 加进版本库；它默认在 `~/qingshi-plugin`，不在项目里。
- 登录取 token 时用 `qingshi_login`，SMS 验证码由用户自己输入，不经过模型。
