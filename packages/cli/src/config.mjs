import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { traeUserConfig, vscodeUserDir } from './detect.mjs'

export const CLIENTS = {
  'claude-code': {
    label: 'Claude Code',
    format: 'json',
    defaultScope: 'project',
    scope: {
      project: (cwd) => path.join(cwd, '.mcp.json'),
      user: null, // 官方推荐用 claude mcp add，不直接改 ~/.claude.json
    },
    hint: '用户级可执行：claude mcp add qingshi -- <node> <server>',
  },
  codex: {
    label: 'Codex CLI',
    format: 'toml',
    defaultScope: 'user',
    scope: {
      user: () => path.join(os.homedir(), '.codex', 'config.toml'),
      project: (cwd) => path.join(cwd, '.codex', 'config.toml'),
    },
  },
  trae: {
    label: 'Trae',
    format: 'json',
    defaultScope: 'user',
    scope: {
      user: () => traeUserConfig(),
      project: (cwd) => path.join(cwd, '.trae', 'mcp.json'),
    },
  },
  workbuddy: {
    label: 'WorkBuddy',
    format: 'json',
    defaultScope: 'user',
    scope: {
      user: (cwd) => path.join(cwd, '.workbuddy', 'mcp.json'),
    },
    printOnly: true,
    hint: '优先在 WorkBuddy 的「连接器 / MCP」界面添加 stdio 服务；或用 --config <路径> 写入它指定的配置文件。',
  },
  cursor: {
    label: 'Cursor',
    format: 'json',
    defaultScope: 'project',
    scope: {
      project: (cwd) => path.join(cwd, '.cursor', 'mcp.json'),
      user: () => path.join(os.homedir(), '.cursor', 'mcp.json'),
    },
  },
  cline: {
    label: 'Cline',
    format: 'json',
    defaultScope: 'user',
    scope: {
      user: () =>
        path.join(vscodeUserDir(), 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    },
  },
  windsurf: {
    label: 'Windsurf',
    format: 'json',
    defaultScope: 'user',
    scope: {
      user: () => path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    },
  },
}

export function clientIds() {
  return Object.keys(CLIENTS)
}

export function resolveTarget(clientId, scope, cwd, customConfig) {
  const client = CLIENTS[clientId]
  if (!client) throw new Error(`未知客户端：${clientId}。可用：${clientIds().join(', ')}`)
  if (customConfig) return { client, file: path.resolve(customConfig) }
  const resolver = client.scope[scope]
  if (!resolver) {
    throw new Error(
      `${client.label} 不支持 scope=${scope}。${client.hint || '可用 scope：' + Object.keys(client.scope).join(', ')}`,
    )
  }
  return { client, file: resolver(cwd) }
}

/** 统一路径分隔符为正斜杠（兼容所有客户端） */
function toPosix(p) {
  return String(p).replace(/\\/g, '/')
}

/** 客户端配置里的服务条目（JSON 格式通用） */
export function serverEntry(serverPath) {
  return { command: toPosix(process.execPath), args: [toPosix(serverPath)] }
}

export function jsonSnippet(serverPath) {
  return JSON.stringify({ mcpServers: { qingshi: serverEntry(serverPath) } }, null, 2)
}

function tomlQuote(value) {
  return JSON.stringify(String(value))
}

export function tomlSnippet(serverPath) {
  return [
    '[mcp_servers.qingshi]',
    `command = ${tomlQuote(toPosix(process.execPath))}`,
    `args = [${tomlQuote(toPosix(serverPath))}]`,
    '',
  ].join('\n')
}

export function snippet(client, serverPath) {
  return client.format === 'toml' ? tomlSnippet(serverPath) : jsonSnippet(serverPath)
}

function readText(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function backup(file) {
  if (!fs.existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${file}.bak-${stamp}`
  fs.copyFileSync(file, target)
  return target
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, text)
  fs.renameSync(temp, file)
}

function mergeJson(existingText, serverPath) {
  let data = {}
  if (existingText.trim()) {
    try {
      data = JSON.parse(existingText)
    } catch (error) {
      throw new Error(`现有配置不是合法 JSON（${error.message}），已中止，未做任何修改。`)
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('现有配置顶层不是对象，已中止。')
  }
  const servers = data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {}
  const entry = serverEntry(serverPath)
  if (JSON.stringify(servers.qingshi) === JSON.stringify(entry)) return existingText
  const next = { ...servers, qingshi: entry }
  return JSON.stringify({ ...data, mcpServers: next }, null, 2) + '\n'
}

function mergeToml(existingText, serverPath) {
  const block = tomlSnippet(serverPath)
  const lines = existingText.split(/\r?\n/)
  const header = '[mcp_servers.qingshi]'
  const envHeader = '[mcp_servers.qingshi.env]'
  const start = lines.findIndex((line) => line.trim() === header || line.trim() === envHeader)
  if (start === -1) {
    const prefix = existingText.trim() ? existingText.replace(/\s*$/, '') + '\n\n' : ''
    return prefix + block
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) {
      end = i
      break
    }
  }
  const section = lines.slice(start, end).join('\n').trim()
  if (section === block.trim()) return existingText
  const before = lines.slice(0, start).join('\n').replace(/\s*$/, '')
  const after = lines.slice(end).join('\n').replace(/^\s*/, '')
  return [before, block.trimEnd(), after].filter(Boolean).join('\n\n') + '\n'
}

/** 计算写入结果，不改文件 */
export function plan(client, file, serverPath, existingText) {
  const next = client.format === 'toml' ? mergeToml(existingText, serverPath) : mergeJson(existingText, serverPath)
  const current = existingText
  return { next, changed: next !== current, snippet: snippet(client, serverPath) }
}

export function commit(file, text) {
  const saved = backup(file)
  writeAtomic(file, text)
  return saved
}

export function removeFromConfig(client, file) {
  if (!fs.existsSync(file)) return { changed: false, text: '' }
  const text = fs.readFileSync(file, 'utf8')
  if (client.format === 'toml') {
    const lines = text.split(/\r?\n/)
    const start = lines.findIndex((line) => line.trim() === '[mcp_servers.qingshi]')
    if (start === -1) return { changed: false, text }
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^\s*\[/.test(lines[i])) {
        end = i
        break
      }
    }
    const next = [...lines.slice(0, start), ...lines.slice(end)].join('\n').replace(/\n{3,}/g, '\n\n')
    return { changed: next !== text, text: next }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('现有配置不是合法 JSON，无法安全删除。')
  }
  if (!data?.mcpServers?.qingshi) return { changed: false, text }
  delete data.mcpServers.qingshi
  return { changed: true, text: JSON.stringify(data, null, 2) + '\n' }
}

export { readText }
