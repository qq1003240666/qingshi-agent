import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const MIN_NODE = [22, 4]

export function nodeVersion() {
  return process.versions.node
}

function nodeGte([major, minor]) {
  const [curMajor, curMinor] = process.versions.node.split('.').map(Number)
  return curMajor > major || (curMajor === major && curMinor >= minor)
}

/** 检查系统里有没有「另外一份」符合版本的 Node（除了当前进程用的这份） */
export function findCompatibleNode() {
  try {
    const out = execSync('where.exe node 2>$null || echo NONE', { encoding: 'utf8', timeout: 3000 }).trim()
    if (!out || out === 'NONE') return []
    const lines = out.split(/\r?\n/).filter(Boolean)
    const ok = []
    for (const line of lines) {
      try {
        const ver = execSync(`"${line}" -e "process.stdout.write(process.versions.node)"`, { encoding: 'utf8', timeout: 3000 }).trim()
        const [major, minor] = ver.split('.').map(Number)
        if (major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])) ok.push({ path: line, version: ver })
      } catch { /* 单个坏的就跳过 */ }
    }
    return ok
  } catch { return [] }
}

export function assertNode() {
  if (nodeGte(MIN_NODE)) return
  const [major, minor] = process.versions.node.split('.').map(Number)
  const hint = `\n  当前 Node ${process.versions.node} 太老，青史 MCP server 需要 Node >= ${MIN_NODE.join('.')}\n\n  装一个新的：\n    Windows  winget install OpenJS.NodeJS.LTS\n    macOS     brew install node@22\n    或去       https://nodejs.org/ 下载 LTS\n\n  装完关掉终端重开，再跑 qingshi doctor 确认一下。`
  const error = new Error(`Node ${process.versions.node} 不满足要求（需 >= ${MIN_NODE.join('.')}）`)
  error.hint = hint
  throw error
}

/** 当前 CLI 所在目录（dist/cli/src 或 dist/cli/bin） */
export function cliDir(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl))
}

/** 找到随包的 MCP server 入口 */
export function resolveServer(metaUrl) {
  if (process.env.QINGSHI_MCP) {
    const custom = path.resolve(process.env.QINGSHI_MCP)
    if (!fs.existsSync(custom)) throw new Error(`QINGSHI_MCP 指向的文件不存在：${custom}`)
    return custom
  }
  const here = cliDir(metaUrl)
  const candidates = [
    path.resolve(here, '..', '..', 'mcp-server', 'bin', 'qingshi-mcp.mjs'),
    path.resolve(here, '..', '..', '..', 'mcp-server', 'bin', 'qingshi-mcp.mjs'),
    path.resolve(process.cwd(), 'dist', 'mcp-server', 'bin', 'qingshi-mcp.mjs'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('找不到 mcp-server/bin/qingshi-mcp.mjs，请先运行 npm run build，或用 QINGSHI_MCP 指定入口。')
}

export function appDataDir() {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
}

/** Trae / Trae CN 的用户级 MCP 配置；优先返回已经存在的那个 */
export function traeUserConfig() {
  const candidates = [
    path.join(appDataDir(), 'Trae CN', 'User', 'mcp.json'),
    path.join(appDataDir(), 'Trae', 'User', 'mcp.json'),
  ]
  return candidates.find((file) => fs.existsSync(file)) || candidates[0]
}

export function vscodeUserDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || '', 'Code', 'User')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User')
  return path.join(os.homedir(), '.config', 'Code', 'User')
}
