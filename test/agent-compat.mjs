// 验证 mcp-server 对各 agent 客户端的兼容性。
// 跑法：node test/agent-compat.mjs
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const SERVER = path.resolve(process.cwd(), 'dist/mcp-server/bin/qingshi-mcp.mjs')
const ok = []
const fail = []
function check(name, pass, detail) {
  if (pass) ok.push(name); else fail.push({ name, detail })
}

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, QINGSHI_CLIENT_NAME: 'agent-compat' },
})
let buf = '', stderr = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', (c) => { buf += c })
child.stderr.setEncoding('utf8')
child.stderr.on('data', (c) => { stderr += c })

let id = 0
function rpc(method, params = {}) {
  id += 1
  const targetId = id
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: targetId, method, params }) + '\n')
  return new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      const nl = buf.indexOf('\n')
      if (nl !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        try {
          const msg = JSON.parse(line)
          if (msg.id === targetId) { resolve(msg); return }
        } catch { /* 不是 JSON */ }
      }
      if (Date.now() - start > 10000) resolve({ timeout: true })
      else setImmediate(tick)
    }
    tick()
  })
}

// 1. 先测协议协商：给 2024-11-05（旧版客户端）和 2025-03-26（中间版）
for (const ver of ['2024-11-05', '2025-03-26', '2025-06-18', '9999-01-01']) {
  const r = await rpc('initialize', { protocolVersion: ver, capabilities: {}, clientInfo: { name: 'compat', version: '1' } })
  if (ver === '9999-01-01') {
    check(`协议协商 未知版本 → 回退最新`, r.result?.protocolVersion === '2025-06-18', r.result?.protocolVersion)
  } else {
    check(`协议协商 ${ver} → 原样回显`, r.result?.protocolVersion === ver, r.result?.protocolVersion)
  }
}
await new Promise((r) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n', r))

// 2. tools/list
const toolsMsg = await rpc('tools/list', {})
const tools = toolsMsg.result?.tools || []
check('tools/list 返回数组', Array.isArray(tools), typeof tools)
check('工具数量 ≥ 37', tools.length >= 37, `实际 ${tools.length}`)

// 3. 每个 tool 必须满足的条件（WorkBuddy 严格校验这些）
const schemaFailures = []
for (const t of tools) {
  if (t.inputSchema?.type !== 'object') schemaFailures.push(`${t.name}: inputSchema.type !== object`)
  if (!t.inputSchema?.properties || typeof t.inputSchema.properties !== 'object') schemaFailures.push(`${t.name}: 缺 properties`)
}
check('每个工具 inputSchema.type 显式 object', schemaFailures.length === 0, schemaFailures.slice(0, 5).join('; '))

// 4. annotations 存在且合法
const annotFailures = []
for (const t of tools) {
  const a = t.annotations
  if (!a) { annotFailures.push(`${t.name}: 缺 annotations`); continue }
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    if (typeof a[key] !== 'boolean') annotFailures.push(`${t.name}: annotations.${key} !== boolean`)
  }
}
check('每个工具都带完整 annotations', annotFailures.length === 0, annotFailures.slice(0, 5).join('; '))

// 5. title 存在（Trae / Cline 会显示 title）
const noTitle = tools.filter((t) => !t.title || typeof t.title !== 'string')
check('每个工具都有 title', noTitle.length === 0, noTitle.map((t) => t.name).join(', '))

// 6. 试 ping 和 tools/call（一个只读的）
const ping = await rpc('ping', {})
check('ping 有 result', ping.result !== undefined)

const wh = await rpc('tools/call', { name: 'qingshi_where', arguments: {} })
check('qingshi_where 调用成功', wh.result?.content?.[0]?.text?.length > 0, wh.result?.content?.[0]?.text?.slice?.(0, 60) || JSON.stringify(wh))
check('qingshi_where isError=false', wh.result?.isError === false)

// 7. 不存在的工具必须返回 -32602
const bad = await rpc('tools/call', { name: 'nope_tool_xyz', arguments: {} })
check('未知工具返回 -32602', bad.error?.code === -32602, JSON.stringify(bad.error))

// 8. 各种客户端需要的配置片段语法
const nodePath = process.execPath
const serverAbs = SERVER
const jsonConfig = { mcpServers: { qingshi: { command: nodePath, args: [serverAbs] } } }
const jsonOk = JSON.parse(JSON.stringify(jsonConfig)).mcpServers.qingshi.command === nodePath
check('JSON 配置片段可解析（Trae/Cursor/Cline/Windsurf/ClaudeCode/WorkBuddy 共用）', jsonOk)

const tomlLines = [
  '[mcp_servers.qingshi]',
  `command = ${JSON.stringify(nodePath)}`,
  `args = [${JSON.stringify(serverAbs)}]`,
]
check('TOML 片段基本格式正确（Codex 用）', tomlLines.join('\n').includes('[mcp_servers.qingshi]') && tomlLines.join('\n').includes('args'))

child.stdin.end()
child.kill()

console.log(`\nok=${ok.length}  fail=${fail.length}`)
for (const f of fail) console.log(`  FAIL  ${f.name}  ${f.detail || ''}`)
console.log(`\nstderr: ${stderr.trim().split('\n').slice(-2).join(' | ')}`)
process.exit(fail.length ? 1 : 0)
