// 零依赖构建：不做打包/转译，按「拷贝即产物」把 core 摊平进每个分发包。
// 产物流程：packages/* → dist/{dsh-plugin,mcp-server,cli}
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const dist = path.join(root, 'dist')

const packages = path.join(root, 'packages')
const core = path.join(packages, 'core')
const dsh = path.join(packages, 'dsh-adapter')
const mcp = path.join(packages, 'mcp-server')
const cli = path.join(packages, 'cli')

function reset(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

function copy(src, dest) {
  if (!fs.existsSync(src)) return
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (from) => path.basename(from) !== 'node_modules',
  })
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

function copyCore(target) {
  copy(path.join(core, 'index.js'), path.join(target, 'index.js'))
  copy(path.join(core, 'lib'), path.join(target, 'lib'))
  copy(path.join(core, 'shell'), path.join(target, 'shell'))
  copy(path.join(core, 'docs'), path.join(target, 'docs'))
}

// 核心包与 MCP 包不能出现静态 @deepseek-ai 导入；
// index.js 里那个 try/catch 的动态 import 是允许的（DSH 不装也能跑）。
function assertNoDsh(dir) {
  const offenders = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'shell') continue
        walk(full)
        continue
      }
      if (!/\.(mjs|js|cjs)$/.test(entry.name)) continue
      const text = fs.readFileSync(full, 'utf8')
      if (/^\s*import\s+[^;\n]*from\s+['"]@deepseek-ai\//m.test(text)) offenders.push(full)
    }
  }
  walk(dir)
  if (offenders.length) {
    throw new Error('产物里仍有静态 @deepseek-ai 导入：\n' + offenders.join('\n'))
  }
}

function assertFile(file) {
  if (!fs.existsSync(file)) throw new Error('构建产物缺失：' + file)
}

// ---------- dsh-plugin ----------
reset(path.join(dist, 'dsh-plugin'))
copyCore(path.join(dist, 'dsh-plugin'))
for (const name of ['cordis.patch.yml', 'install.mjs', 'icon.svg', 'locale', 'bin']) {
  copy(path.join(dsh, name), path.join(dist, 'dsh-plugin', name))
}
writeJson(path.join(dist, 'dsh-plugin', 'package.json'), {
  name: 'dsh-qingshi',
  version,
  type: 'module',
  description: '青史 DSH 插件（同一份内核也可作为独立 MCP server 使用）',
  main: 'index.js',
  exports: {
    '.': './index.js',
    './package.json': './package.json',
    './locale/*': './locale/*',
  },
  bin: { 'qingshi-open': 'bin/open.mjs' },
  engines: { node: '>=22.4' },
})

// ---------- mcp-server ----------
reset(path.join(dist, 'mcp-server'))
copyCore(path.join(dist, 'mcp-server'))
copy(path.join(mcp, 'mcp'), path.join(dist, 'mcp-server', 'mcp'))
copy(path.join(mcp, 'bin'), path.join(dist, 'mcp-server', 'bin'))
writeJson(path.join(dist, 'mcp-server', 'package.json'), {
  name: '@qingshi/mcp-server',
  version,
  type: 'module',
  description: '青史标准 MCP server（stdio）',
  bin: { 'qingshi-mcp': 'bin/qingshi-mcp.mjs' },
  exports: { '.': './mcp/server.mjs' },
  engines: { node: '>=22.4' },
})
assertNoDsh(path.join(dist, 'mcp-server'))

// ---------- cli ----------
reset(path.join(dist, 'cli'))
copy(path.join(cli, 'bin'), path.join(dist, 'cli', 'bin'))
copy(path.join(cli, 'src'), path.join(dist, 'cli', 'src'))
writeJson(path.join(dist, 'cli', 'package.json'), {
  name: '@qingshi/cli',
  version,
  type: 'module',
  bin: { qingshi: 'bin/qingshi.mjs' },
  engines: { node: '>=22.4' },
})
assertNoDsh(path.join(dist, 'cli'))

for (const file of [
  'dist/dsh-plugin/index.js',
  'dist/dsh-plugin/lib/request.js',
  'dist/dsh-plugin/shell/preload.js',
  'dist/dsh-plugin/docs/org-entry/SKILL.md',
  'dist/mcp-server/index.js',
  'dist/mcp-server/lib/tool-manifest.js',
  'dist/mcp-server/mcp/server.mjs',
  'dist/mcp-server/bin/qingshi-mcp.mjs',
  'dist/cli/bin/qingshi.mjs',
]) {
  assertFile(path.join(root, file))
}

process.stdout.write(`build ok: v${version}\n`)
process.stdout.write(`  dist/dsh-plugin\n  dist/mcp-server\n  dist/cli\n`)
