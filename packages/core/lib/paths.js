// 统一的数据目录。
//
// 一个原则：**同一台机器、同一个系统用户，只有一份数据**，跟在哪个宿主里跑没关系
// （DSH 插件、MCP server、Claude Code、Codex、命令行都算）。这样登录一次，
// 换个客户端不用再登；草稿、窗口注册表、localStorage 快照也都能接着用。
//
// 默认位置固定在用户 home 根目录下的 qingshi-plugin：
//   Windows  C:\Users\<你>\qingshi-plugin
//   macOS    /Users/<你>/qingshi-plugin
//   Linux    ~/qingshi-plugin
//
// 想换地方（移动硬盘、测试用临时目录）：
//   1. 环境变量 QINGSHI_HOME=/some/dir
//   2. 插件配置 workspaceDir（DSH）或 QINGSHI_WORKSPACE（MCP/命令行）
// 优先级：显式配置 > QINGSHI_HOME > ~/qingshi-plugin > 当前目录/.qingshi-plugin > 临时目录。
import { existsSync, mkdirSync, copyFileSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, platform, tmpdir } from 'node:os'

export const APP_DIR_NAME = 'qingshi-plugin'

/** 平台默认的数据目录 —— 统一落到 home 根目录，不再按 APPDATA / Library / XDG 分。 */
export function defaultHomeDir() {
  return join(homedir(), APP_DIR_NAME)
}

/** 老版本用过、需要迁移过来的目录（加了新平台默认，防止升级丢数据）。 */
export function legacyDirs() {
  const dirs = []
  // DSH 时代的 workspace
  if (process.env.DSH_HOME) dirs.push(join(process.env.DSH_HOME, 'qingshi-workspace'))
  dirs.push(join(homedir(), '.dsh', 'qingshi-workspace'))
  if (process.env.DSH_WORKSPACE) dirs.push(join(process.env.DSH_WORKSPACE, '.qingshi-workspace'))
  dirs.push(join(process.cwd(), '.qingshi-workspace'))
  // 上一版按平台分的位置（升级到 0.24+ 时搬过来）
  const os = platform()
  if (os === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    dirs.push(join(appData, 'qingshi'))
  } else if (os === 'darwin') {
    dirs.push(join(homedir(), 'Library', 'Application Support', 'qingshi'))
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
    dirs.push(join(xdg, 'qingshi'))
  }
  return Array.from(new Set(dirs))
}

/** 目录能不能真的写进去（建目录 + 写一个探针文件 + 删掉）。 */
export function isWritableDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return false
  }
  const probe = join(dir, '.write-probe')
  try {
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return true
  } catch {
    try { rmSync(probe, { force: true }) } catch {}
    return false
  }
}

/** 当前工作目录下的备选（不少 AI 客户端只允许写项目目录）。 */
export function cwdFallbackDir() {
  return join(process.cwd(), '.' + APP_DIR_NAME)
}

/** 最后兜底：系统临时目录，至少别让登录直接失败。 */
export function tmpFallbackDir() {
  return join(tmpdir(), APP_DIR_NAME)
}

/**
 * 按「可写」选目录，返回 {dir, source}。source 用来解释为什么落在这里。
 * 顺序：显式配置 → QINGSHI_HOME → ~/qingshi-plugin → 当前目录/.qingshi-plugin → 临时目录。
 */
export function pickHomeDir(config = {}) {
  const explicit = String(config.workspaceDir || process.env.QINGSHI_WORKSPACE || '').trim()
  if (explicit) return { dir: explicit, source: 'config' }
  const envHome = String(process.env.QINGSHI_HOME || '').trim()
  if (envHome) return { dir: envHome, source: 'env' }
  const candidates = [
    { dir: defaultHomeDir(), source: 'home' },
    { dir: cwdFallbackDir(), source: 'cwd' },
    { dir: tmpFallbackDir(), source: 'tmp' },
  ]
  for (const c of candidates) {
    if (isWritableDir(c.dir)) return c
  }
  return { dir: defaultHomeDir(), source: 'home' }
}

/** 数据根目录（只要路径）。 */
export function resolveHomeDir(config = {}) {
  return pickHomeDir(config).dir
}

/** 给工具用：现在到底存在哪、能不能写、里面有什么。 */
export function describeHomeDir(config = {}) {
  const { dir, source } = pickHomeDir(config)
  const files = []
  for (const name of ['auth.json', 'drafts.json', 'users.json', 'browser-storage.json', 'browser-window.json']) {
    try {
      if (existsSync(join(dir, name))) files.push(name)
    } catch {}
  }
  return { dir, source, writable: isWritableDir(dir), files }
}

// 迁移时搬哪些东西：凭证、草稿、图片、用户缓存、窗口/页面状态。
// shots（截图）不搬——体积最大、也没必要。
const MIGRATE_FILES = [
  'auth.json',
  'drafts.json',
  'users.json',
  'browser-window.json',
  'browser-profile.json',
  'browser-storage.json',
]
const MIGRATE_DIRS = ['media', 'trash']

/**
 * 要不要做老数据迁移？只在「用默认位置」时做。
 * 显式指定了目录（测试、临时工作区、自己选的路径）就说明他要一份干净的，别把别人的数据灌进去。
 */
export function shouldMigrate(config = {}) {
  const explicit = String(config.workspaceDir || process.env.QINGSHI_WORKSPACE || '').trim()
  if (explicit) return false
  if (String(process.env.QINGSHI_NO_MIGRATE || '').trim()) return false
  return true
}

/**
 * 第一次跑新版本时，把老目录里的数据搬到新位置（只补缺，不覆盖）。
 * 同步调用，只在插件加载时跑一次；任何失败都静默跳过，不能拖住插件。
 * @returns {string[]} 实际搬过来的东西
 */
export function migrateLegacy(home) {
  const moved = []
  try {
    if (process.env.QINGSHI_NO_MIGRATE) return moved
    if (!existsSync(home)) mkdirSync(home, { recursive: true })
    for (const old of legacyDirs()) {
      if (old === home || !existsSync(old)) continue
      for (const name of MIGRATE_FILES) {
        const src = join(old, name)
        const dest = join(home, name)
        if (existsSync(src) && !existsSync(dest)) {
          try {
            copyFileSync(src, dest)
            moved.push(name)
          } catch {}
        }
      }
      for (const name of MIGRATE_DIRS) {
        const src = join(old, name)
        const dest = join(home, name)
        if (existsSync(src) && !existsSync(dest)) {
          try {
            cpSync(src, dest, { recursive: true })
            moved.push(name + '/')
          } catch {}
        }
      }
    }
  } catch {}
  return moved
}
