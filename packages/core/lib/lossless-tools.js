// 无损压缩：jpegtran（JPEG）+ oxipng（PNG）。
//
// 设计原则：
//   1. 优先用系统 PATH 里已有的 jpegtran / oxipng；
//   2. 没有就去工作区 tools/ 目录找；还没有才在用户同意后自动下载安装；
//   3. 任何一步失败都不阻断主流程——原图照常上传，只是把原因告诉用户。
//
// 自动安装在 Windows 上：
//   jpegtran ← imagemin 托管的 libjpeg-turbo 免安装二进制（不触发管理员权限）
//   oxipng   ← GitHub release 的 portable zip
// macOS / Linux 只做 PATH 探测，缺失时明确提示用户自行安装。
import { execFile } from 'node:child_process'
import { mkdir, writeFile, stat, rm } from 'node:fs/promises'
import { dirname, join, basename } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const EXE = process.platform === 'win32' ? '.exe' : ''

export const TOOL_NAMES = ['jpegtran', 'oxipng']

export function toolsDir(workspaceDir) {
  return join(String(workspaceDir || '.'), 'tools')
}

async function exists(file) {
  try {
    const info = await stat(file)
    return info.isFile()
  } catch {
    return false
  }
}

async function onPath(name) {
  try {
    const command = process.platform === 'win32' ? 'where' : 'which'
    const { stdout } = await run(command, [name], { windowsHide: true, timeout: 8000 })
    return String(stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || ''
  } catch {
    return ''
  }
}

/** 本地 tools/ 优先，其次系统 PATH。 */
export async function findTool(name, workspaceDir) {
  const local = join(toolsDir(workspaceDir), `${name}${EXE}`)
  if (await exists(local)) return local
  return onPath(name)
}

async function download(url, dest, headers = {}) {
  const response = await fetch(url, { redirect: 'follow', headers })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, buffer)
  return buffer.length
}

async function findFileFuzzy(root, fileName, depth = 4) {
  let entries = []
  try {
    entries = await (async () => {
      const { readdir } = await import('node:fs/promises')
      return readdir(root, { withFileTypes: true })
    })()
  } catch {
    return ''
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full
  }
  if (depth <= 0) return ''
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findFileFuzzy(join(root, entry.name), fileName, depth - 1)
    if (found) return found
  }
  return ''
}

async function extractArchive(archive, destDir) {
  await mkdir(destDir, { recursive: true })
  if (process.platform === 'win32') {
    // Windows 10+ 自带 bsdtar，可直接解 zip
    await run('tar', ['-xf', archive, '-C', destDir], { windowsHide: true, timeout: 120000 })
    return
  }
  if (archive.endsWith('.tar.gz') || archive.endsWith('.tgz')) {
    await run('tar', ['-xzf', archive, '-C', destDir], { windowsHide: true, timeout: 120000 })
    return
  }
  try {
    await run('unzip', ['-o', archive, '-d', destDir], { windowsHide: true, timeout: 120000 })
  } catch {
    await run('python3', ['-c', 'import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, destDir], {
      windowsHide: true,
      timeout: 120000,
    })
  }
}

const OXIPNG_VERSION = '10.2.1'

function oxipngUrl() {
  const arm = process.arch === 'arm64'
  if (process.platform === 'win32') {
    return arm
      ? `https://github.com/oxipng/oxipng/releases/download/v${OXIPNG_VERSION}/oxipng-${OXIPNG_VERSION}-aarch64-pc-windows-msvc.zip`
      : `https://github.com/oxipng/oxipng/releases/download/v${OXIPNG_VERSION}/oxipng-${OXIPNG_VERSION}-x86_64-pc-windows-msvc.zip`
  }
  if (process.platform === 'darwin') {
    return arm
      ? `https://github.com/oxipng/oxipng/releases/download/v${OXIPNG_VERSION}/oxipng-${OXIPNG_VERSION}-aarch64-apple-darwin.tar.gz`
      : `https://github.com/oxipng/oxipng/releases/download/v${OXIPNG_VERSION}/oxipng-${OXIPNG_VERSION}-x86_64-apple-darwin.tar.gz`
  }
  return arm
    ? `https://github.com/oxipng/oxipng/releases/download/v${OXIPNG_VERSION}/oxipng-${OXIPNG_VERSION}-aarch64-unknown-linux-gnu.tar.gz`
    : `https://github.com/oxipng/oxipng/releases/download/v${OXIPNG_VERSION}/oxipng-${OXIPNG_VERSION}-x86_64-unknown-linux-gnu.tar.gz`
}

async function installOxipng(workspaceDir, logger) {
  const dir = join(toolsDir(workspaceDir), 'oxipng')
  const archive = join(dir, basename(oxipngUrl()))
  logger?.(`下载 oxipng：${oxipngUrl()}`)
  await download(oxipngUrl(), archive)
  await extractArchive(archive, dir)
  const binary = await findFileFuzzy(dir, `oxipng${EXE}`)
  if (!binary) throw new Error('解压后没找到 oxipng 可执行文件')
  const target = join(toolsDir(workspaceDir), `oxipng${EXE}`)
  await (async () => {
    const { copyFile, chmod } = await import('node:fs/promises')
    await copyFile(binary, target)
    await chmod(target, 0o755).catch(() => {})
  })()
  await rm(archive, { force: true }).catch(() => {})
  return target
}

// imagemin 托管的 libjpeg-turbo 免安装二进制（win32 x64），不需要管理员权限。
// 走 GitHub contents API 而不是 raw.githubusercontent.com，后者在国内经常连不上。
const JPEGTRAN_BIN_VERSION = '7.0.0'
const JPEGTRAN_BIN_BASE = 'https://api.github.com/repos/imagemin/jpegtran-bin/contents/vendor/win/x64'
const GITHUB_RAW_HEADERS = { Accept: 'application/vnd.github.raw' }

async function installJpegtran(workspaceDir, logger) {
  if (process.platform !== 'win32') {
    throw new Error('这台机器不是 Windows，暂不自动安装 jpegtran；请用系统包管理器安装 libjpeg-turbo（自带 jpegtran）')
  }
  const dir = toolsDir(workspaceDir)
  const target = join(dir, `jpegtran${EXE}`)
  const dllTarget = join(dir, 'libjpeg-62.dll')
  const exeUrl = `${JPEGTRAN_BIN_BASE}/jpegtran.exe?ref=v${JPEGTRAN_BIN_VERSION}`
  const dllUrl = `${JPEGTRAN_BIN_BASE}/libjpeg-62.dll?ref=v${JPEGTRAN_BIN_VERSION}`
  logger?.(`下载 jpegtran（免安装版）：${exeUrl}`)
  await download(exeUrl, target, GITHUB_RAW_HEADERS)
  await download(dllUrl, dllTarget, GITHUB_RAW_HEADERS)
  const { chmod } = await import('node:fs/promises')
  await chmod(target, 0o755).catch(() => {})
  return target
}

/**
 * 找一个工具；找不到且 allowInstall 时才下载安装。
 * @returns {{ ok: boolean, path: string, installed: boolean, needConsent: boolean, message: string }}
 */
export async function ensureTool(name, { workspaceDir, allowInstall = false, logger } = {}) {
  if (!TOOL_NAMES.includes(name)) {
    return { ok: false, path: '', installed: false, needConsent: false, message: `未知工具：${name}` }
  }
  const existing = await findTool(name, workspaceDir)
  if (existing) {
    return { ok: true, path: existing, installed: false, needConsent: false, message: '已找到' }
  }
  if (!allowInstall) {
    return {
      ok: false,
      path: '',
      installed: false,
      needConsent: true,
      message: `这台电脑没有 ${name}。要我现在下载安装到 ${toolsDir(workspaceDir)} 吗？（只装本地，不写系统目录）`,
    }
  }
  try {
    const path = name === 'oxipng'
      ? await installOxipng(workspaceDir, logger)
      : await installJpegtran(workspaceDir, logger)
    return { ok: true, path, installed: true, needConsent: false, message: '安装完成' }
  } catch (error) {
    return {
      ok: false,
      path: '',
      installed: false,
      needConsent: false,
      message: `自动安装 ${name} 失败：${String(error?.message || error).slice(0, 240)}`,
    }
  }
}

async function runTool(binary, args, logger) {
  try {
    await run(binary, args, { windowsHide: true, timeout: 180000, maxBuffer: 8 * 1024 * 1024 })
    return true
  } catch (error) {
    logger?.(`${basename(binary)} 执行失败：${String(error?.stderr || error?.message || error).slice(0, 200)}`)
    return false
  }
}

/**
 * 就地无损压缩一张图。失败时返回原文件，不抛错。
 * @returns {{ path, bytesBefore, bytesAfter, tool, note }}
 */
export async function optimizeImageInPlace(filePath, { workspaceDir, allowInstall = false, logger } = {}) {
  const before = await stat(filePath).catch(() => null)
  if (!before || !before.isFile()) {
    return { path: filePath, bytesBefore: 0, bytesAfter: 0, tool: '', note: '文件不存在' }
  }
  const extension = String(filePath).toLowerCase().split('.').pop()
  const kind = extension === 'png' ? 'oxipng' : ['jpg', 'jpeg'].includes(extension) ? 'jpegtran' : ''
  if (!kind) {
    return { path: filePath, bytesBefore: before.size, bytesAfter: before.size, tool: '', note: '该格式不做无损压缩' }
  }

  const tool = await ensureTool(kind, { workspaceDir, allowInstall, logger })
  if (!tool.ok) {
    return {
      path: filePath,
      bytesBefore: before.size,
      bytesAfter: before.size,
      tool: '',
      note: tool.message,
      needConsent: tool.needConsent,
    }
  }

  const temp = `${filePath}.${kind}.tmp`
  const args = kind === 'jpegtran'
    ? ['-copy', 'all', '-optimize', '-outfile', temp, filePath]
    : ['-o', '2', '--strip', 'safe', '--out', temp, filePath]

  const okay = await runTool(tool.path, args, logger)
  const after = okay ? await stat(temp).catch(() => null) : null
  if (after && after.size > 0 && after.size < before.size) {
    const { rename } = await import('node:fs/promises')
    await rename(temp, filePath)
    return {
      path: filePath,
      bytesBefore: before.size,
      bytesAfter: after.size,
      tool: kind,
      note: '',
    }
  }
  await rm(temp, { force: true }).catch(() => {})
  return {
    path: filePath,
    bytesBefore: before.size,
    bytesAfter: before.size,
    tool: '',
    note: okay ? '压缩后没有变小，保留原图' : `${kind} 执行失败，保留原图`,
  }
}
