# Codex CLI

```bash
node dist/cli/bin/qingshi.mjs install --client codex
```

写入 `~/.codex/config.toml`：

```toml
[mcp_servers.qingshi]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["E:\\path\\to\\dist\\mcp-server\\bin\\qingshi-mcp.mjs"]
```

## 项目级

```bash
qingshi install --client codex --scope project
```

写入当前目录的 `.codex/config.toml`，适合只给某个仓库用。

## 验证

```bash
qingshi doctor --client codex
```

`doctor` 会真的拉起 server、完成 MCP 握手并报告工具数；如果 Codex 里看不到工具，先跑它。

## 注意

- 只改 `[mcp_servers.qingshi]` 这一段，其它配置原样保留，写入前生成 `.bak-<时间戳>`。
- 重复执行是幂等的：内容一致时不写文件。
- 若你给这个条目加过 `env`，CLI 会要求加 `--force` 才覆盖。
