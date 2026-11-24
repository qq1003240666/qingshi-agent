# Contributing

## 开发环境

- Node.js **>= 22.4**
- 操作系统：Windows / macOS / Linux 都能跑测试，Electron 外壳构建主要在 Windows（产物里已附带 exe）

## 结构

```
packages/core         内核：所有工具定义、登录、请求层、族谱自动化
packages/dsh-adapter  DSH 宿主的 cordis.patch.yml / locale / 安装器
packages/mcp-server   标准 stdio MCP 适配层
packages/cli          多客户端配置 CLI
scripts               build.mjs / gen-docs.mjs / check-docs.mjs / pack.mjs
test                  测试（全部 node:test）
```

## 跑起来

```bash
npm run build        # 构建 dist/
node test/_review.mjs  # 静态审查
node test/agent-compat.mjs  # MCP 兼容性检查
npm run gen-docs     # 刷 docs/TOOLS.md + README 工具表
```

## 加一个新工具

1. 在 `packages/core/index.js` 的 `apply()` 里用 `ctx.tools.register(defineTool({...}))` 注册。
2. 在 `packages/core/lib/tool-manifest.js` 里登记 `TITLES[name]` 和 `READ_ONLY` / `DESTRUCTIVE` / `LOCAL_ONLY`。
3. `node test/_review.mjs` —— 它会检查 manifest 和注册是否一致，漏了会直接 FAIL。
4. `npm run gen-docs` 刷文档。

## 改了 manifest 但没跑 gen-docs？

CI 的 `check-docs` 会 fail。不要手改 docs/TOOLS.md 和 README 里的工具表——它们是生成物。

## PR 准则

- 保持零依赖：core 和 mcp-server 不能加 npm 包。
- 不要把 token 塞进日志、工具输出、错误消息。
- 破坏性变更必须改 CHANGELOG 并在描述里写清迁移路径。
- Windows 路径用 `path.join`，不要手写反斜杠。

## 发版

- `git tag vX.Y.Z && git push --tags`
- `.github/workflows/release.yml` 会自动 build + `gh release create`，产物 `qingshi-X.Y.Z.tar.gz` + sha256。
