#!/usr/bin/env node
// qingshi-mcp：青史 MCP server 的入口（stdio 传输）。
// 用法：node dist/mcp-server/bin/qingshi-mcp.mjs
//
// stdout 是 MCP 协议通道，任何调试输出都必须走 stderr。
console.log = console.error
console.info = console.error
console.debug = console.error

import('../mcp/server.mjs')
  .then((mod) => {
    const { envConfig, loadTools, createServer, serveStdio } = mod
    const config = envConfig()
    return loadTools(config).then(({ tools, instructions }) => {
      serveStdio(createServer({ tools, instructions }))
      process.stderr.write(`qingshi-mcp ready: ${tools.size} tools\n`)
    })
  })
  .catch((error) => {
    process.stderr.write(`qingshi-mcp failed: ${error?.stack || error}\n`)
    process.exit(1)
  })
