#!/usr/bin/env node
// 青史 CLI：把随包的 MCP server 写进各家 AI 客户端的配置。
//
//   qingshi install --client trae            # 写用户级 Trae 配置
//   qingshi install --client codex           # 写 ~/.codex/config.toml
//   qingshi print --client claude-code       # 只打印片段
//   qingshi doctor                           # 自检并真实握手
//   qingshi where                            # 打印数据目录
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import { CLIENTS, clientIds, resolveTarget, plan, commit, readText, removeFromConfig } from '../src/config.mjs'
import { assertNode, resolveServer, findCompatibleNode } from '../src/detect.mjs'
import { doctor } from '../src/doctor.mjs'
import { startServer } from '../src/rpc.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function version() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'))
    return String(pkg.version || '0.0.0')
  } catch {
    return '0.0.0'
  }
}

const HELP = `青史 CLI v${version()}

用法：qingshi <命令> [选项]

命令：
  install     把青史 MCP server 写入客户端配置
  uninstall   从客户端配置里移除青史
  print       只打印配置片段，不改文件
  doctor      检查 Node / server 路径 / 配置，并真实握手
  where       打印青史数据目录
  clients     列出支持的客户端
  help        显示本帮助

选项：
  --client <id>    客户端：${clientIds().join(' | ')}
  --scope <s>      user | project（默认取客户端推荐值）
  --config <file>  直接指定配置文件路径
  --dry-run        只显示将要写入的内容
  --force          覆盖已有但不同的 qingshi 配置
  --json           doctor / clients 输出 JSON

示例：
  qingshi install --client trae
  qingshi install --client claude-code --scope project
  qingshi print --client codex
  qingshi doctor --client trae
`

function die(message, code = 1) {
  process.stderr.write(`qingshi: ${message}\n`)
  process.exit(code)
}

function parse(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      client: { type: 'string' },
      scope: { type: 'string' },
      config: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  })
  return { values, positionals }
}

function pickClient(values) {
  const client = values.client
  if (!client) die(`缺少 --client。可用：${clientIds().join(', ')}`)
  if (!CLIENTS[client]) die(`未知客户端：${client}。可用：${clientIds().join(', ')}`)
  return client
}

function pickScope(values, client) {
  return values.scope || CLIENTS[client].defaultScope
}

/** 配置文件里已有的 qingshi 条目（只用于判断是否需要 --force） */
function existingEntry(client, text) {
  if (client.format === 'toml' || !text.trim()) return null
  try {
    const data = JSON.parse(text)
    return data?.mcpServers?.qingshi || null
  } catch {
    return null
  }
}

function commandInstall(values, serverPath, cwd) {
  const clientId = pickClient(values)
  const scope = pickScope(values, clientId)
  const { client, file } = resolveTarget(clientId, scope, cwd, values.config)

  // WorkBuddy 这类没有稳定配置文件位置的客户端：默认只打印片段
  if (client.printOnly && !values.config) {
    process.stdout.write(`${client.hint}\n\n${plan(client, file, serverPath, '').snippet}\n`)
    return
  }

  const text = readText(file)
  const result = plan(client, file, serverPath, text)

  if (!result.changed) {
    process.stdout.write(`已配置：${file}\n`)
    return
  }
  if (values['dry-run']) {
    process.stdout.write(`将写入：${file}\n\n${result.next}`)
    return
  }
  const previous = existingEntry(client, text)
  if (previous && !values.force && JSON.stringify(previous) !== JSON.stringify({ command: process.execPath, args: [serverPath] })) {
    die(`${file} 里已有不同的 qingshi 配置（可能含自定义 env）。确认覆盖请加 --force。`)
  }
  const saved = commit(file, result.next)
  process.stdout.write(`已写入：${file}\n`)
  if (saved) process.stdout.write(`已备份：${saved}\n`)
}

function commandUninstall(values, cwd) {
  const clientId = pickClient(values)
  const scope = pickScope(values, clientId)
  const { client, file } = resolveTarget(clientId, scope, cwd, values.config)
  if (!fs.existsSync(file)) {
    process.stdout.write(`文件不存在，无需移除：${file}\n`)
    return
  }
  const result = removeFromConfig(client, file)
  if (!result.changed) {
    process.stdout.write(`配置里没有 qingshi：${file}\n`)
    return
  }
  if (values['dry-run']) {
    process.stdout.write(`将从 ${file} 移除：\n\n${result.text}`)
    return
  }
  const saved = commit(file, result.text)
  process.stdout.write(`已移除：${file}\n`)
  if (saved) process.stdout.write(`已备份：${saved}\n`)
}

function commandPrint(values, serverPath, cwd) {
  const clientId = pickClient(values)
  const scope = pickScope(values, clientId)
  const { client } = resolveTarget(clientId, scope, cwd, values.config)
  process.stdout.write(plan(client, '', serverPath, '').snippet + '\n')
  if (client.hint) process.stdout.write(`\n${client.hint}\n`)
}

async function commandDoctor(values, serverPath, cwd) {
  const clientId = values.client && CLIENTS[values.client] ? values.client : values.client
  if (values.client && !CLIENTS[values.client]) die(`未知客户端：${values.client}。可用：${clientIds().join(', ')}`)
  const result = await doctor({
    client: clientId,
    scope: clientId ? pickScope(values, clientId) : undefined,
    cwd,
    serverMetaUrl: new URL('../../mcp-server/bin/qingshi-mcp.mjs', import.meta.url).href,
  })
  if (values.json) {
    process.stdout.write(JSON.stringify({ ok: result.fail.length === 0, lines: result.lines, fail: result.fail }, null, 2) + '\n')
  } else {
    for (const line of result.lines) process.stdout.write(`${line}\n`)
    for (const line of result.fail) process.stdout.write(`FAIL  ${line}\n`)
    process.stdout.write(result.fail.length ? '\n自检未通过\n' : '\n自检通过\n')
  }
  if (result.fail.length) process.exitCode = 1
}

async function commandWhere(serverPath) {
  const session = startServer(serverPath)
  try {
    await session.initialize('qingshi-cli')
    const result = await session.request('tools/call', { name: 'qingshi_where', arguments: {} })
    const text = (result.content || []).map((item) => item.text || '').join('\n')
    process.stdout.write(`${text || '（无输出）'}\n`)
  } finally {
    session.close()
  }
}

function commandClients(values) {
  if (values.json) {
    const data = clientIds().map((id) => ({
      id,
      label: CLIENTS[id].label,
      format: CLIENTS[id].format,
      defaultScope: CLIENTS[id].defaultScope,
    }))
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
    return
  }
  const rows = clientIds().map((id) => {
    const client = CLIENTS[id]
    const scopes = Object.keys(client.scope).join('/')
    return `  ${id.padEnd(12)} ${client.label.padEnd(12)} ${client.format.padEnd(5)} ${scopes}`
  })
  process.stdout.write(`  ${'id'.padEnd(12)} ${'客户端'.padEnd(10)} 格式  可用 scope\n`)
  process.stdout.write(rows.join('\n') + '\n')
}

async function main() {
  const { values, positionals } = parse(process.argv.slice(2))
  if (values.version) {
    process.stdout.write(`${version()}\n`)
    return
  }
  const command = positionals[0] || 'help'
  if (values.help || command === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (command === 'clients') {
    commandClients(values)
    return
  }

  assertNode()
  const cwd = process.cwd()
  const serverPath = resolveServer(import.meta.url)

  switch (command) {
    case 'install':
      commandInstall(values, serverPath, cwd)
      break
    case 'uninstall':
      commandUninstall(values, cwd)
      break
    case 'print':
      commandPrint(values, serverPath, cwd)
      break
    case 'doctor':
      await commandDoctor(values, serverPath, cwd)
      break
    case 'where':
      await commandWhere(serverPath)
      break
    default:
      die(`未知命令：${command}\n\n${HELP}`)
  }
}

main().catch((error) => {
  let msg = error?.message || String(error)
  if (error?.hint) msg += error.hint
  process.stderr.write(`qingshi: ${msg}\n`)
  process.exit(1)
})
