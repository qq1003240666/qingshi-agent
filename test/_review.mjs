// 一次性审查脚本：扫常见问题
// 用法：在仓库根目录 node test/_review.mjs
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const root = resolve(HERE, '..')
const issues = []

function check(label, pass, detail) {
  if (pass) return
  issues.push({ label, detail })
}

function rel(file) {
  return file.replace(root + '\\', '').replace(root + '/', '')
}

// —— 1. 测试 import 路径 ——
const smoke = readFileSync(join(root, 'test', 'smoke.mjs'), 'utf8')
const mcpTest = readFileSync(join(root, 'test', 'mcp.mjs'), 'utf8')
const pathsTest = readFileSync(join(root, 'test', 'paths.mjs'), 'utf8')
const smokeImports = [...smoke.matchAll(/from ['"][^'"]+['"]|import\(['"][^'"]+['"]\)/g)].map((m) => m[0])
const mcpImports = [...mcpTest.matchAll(/from ['"][^'"]+['"]|import\(['"][^'"]+['"]\)/g)].map((m) => m[0])
const pathsImports = [...pathsTest.matchAll(/from ['"][^'"]+['"]|import\(['"][^'"]+['"]\)/g)].map((m) => m[0])
check('test/smoke.mjs import 指向 packages/core 或 dist', /packages\/core\/index|dist\/dsh-plugin/.test(smokeImports.join(' ')), smokeImports.join(', '))
check('test/mcp.mjs import 指向 packages/mcp-server 或 dist', /packages\/mcp-server|dist\/mcp-server/.test(mcpImports.join(' ')), mcpImports.join(', '))
check('test/paths.mjs import 指向 packages/core/lib', /packages\/core\/lib/.test(pathsImports.join(' ')), pathsImports.join(', '))

// —— 2. manifest vs 注册工具 ——
const coreIndex = readFileSync(join(root, 'packages', 'core', 'index.js'), 'utf8')
const manifestFile = await import(pathToFileURL(join(root, 'packages', 'core', 'lib', 'tool-manifest.js')).href)
const manifestNames = manifestFile.TOOL_MANIFEST.map((t) => t.name)
// 所有 name: 'qingshi_xxx' 都是注册工具（不管有没有 defineTool 包装）
const registerNames = [...coreIndex.matchAll(/name:\s*['"](qingshi_[a-z0-9_]+)['"]/g)].map((m) => m[1])
const uniqueRegisters = [...new Set(registerNames)]
const missingMeta = uniqueRegisters.filter((n) => !manifestNames.includes(n))
check('所有注册工具都在 manifest 里登记', missingMeta.length === 0, `缺：${missingMeta.join(', ')}`)
const extraMeta = manifestNames.filter((n) => !uniqueRegisters.includes(n))
check('manifest 没有多登记的幽灵工具', extraMeta.length === 0, `多：${extraMeta.join(', ')}`)

// —— 3. 文档漂移 ——
const docTools = await import(pathToFileURL(join(root, 'scripts', 'doc-tools.mjs')).href)
if (!existsSync(join(root, 'docs', 'TOOLS.md'))) issues.push({ label: '缺 docs/TOOLS.md', detail: '运行 npm run gen-docs' })
else check('docs/TOOLS.md 与 manifest 一致', readFileSync(join(root, 'docs', 'TOOLS.md'), 'utf8') === docTools.renderPage())

const readme = readFileSync(join(root, 'README.md'), 'utf8')
check('README.md 存在且有内容', readme.length > 2000, `只有 ${readme.length} 字符，可能是空壳`)
check('README 提到 Node 22+', /Node\.js.*22|node.*22/i.test(readme))
check('README 提到 qingshi-cli 用法', /qingshi.*install|qingshi.*doctor/i.test(readme))

const cfg = await import(pathToFileURL(join(root, 'packages', 'cli', 'src', 'config.mjs')).href)
for (const id of cfg.clientIds()) {
  check(`docs/clients/${id}.md 存在`, existsSync(join(root, 'docs', 'clients', `${id}.md`)))
}

// —— 4. 缺失发布文件 ——
for (const f of ['CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', '.github/workflows/ci.yml', '.github/workflows/release.yml']) {
  check(`${f} 存在`, existsSync(join(root, f)))
}

// —— 5. CHANGELOG 版本覆盖 ——
if (existsSync(join(root, 'CHANGELOG.md'))) {
  const cl = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  check(`CHANGELOG 提到 v${pkg.version}`, cl.includes(pkg.version))
}

// —— 6. dsh-adapter/package.json files 字段 ——
const dshPkg = JSON.parse(readFileSync(join(root, 'packages', 'dsh-adapter', 'package.json'), 'utf8'))
const expectedInDsh = ['cordis.patch.yml', 'install.mjs', 'icon.svg', 'locale', 'bin']
const hasCoreInDsh = (dshPkg.files || []).some((f) => ['index.js', 'lib', 'shell', 'skills'].includes(f))
check('dsh-adapter files 不含 core 独有文件', !hasCoreInDsh, (dshPkg.files || []).join(', '))

// —— 7. dist/cli resolveServer 相对路径 ——
const distCliBin = join(root, 'dist', 'cli', 'bin', 'qingshi.mjs')
const distMcp = join(root, 'dist', 'mcp-server', 'bin', 'qingshi-mcp.mjs')
check('dist 里 mcp-server 能被 cli 找到（相对路径正确）', existsSync(distMcp), `找不到 ${rel(distMcp)}`)

// —— 8. dsh-adapter install.mjs 过时文案 ——
const install = readFileSync(join(root, 'packages', 'dsh-adapter', 'install.mjs'), 'utf8')
check('install.mjs 没有过时注释「随 dsh-qingshi」', !/随 dsh-qingshi/i.test(install))

// —— 9. SECURITY.md 至少说清 token 处理 ——
if (existsSync(join(root, 'SECURITY.md'))) {
  const sec = readFileSync(join(root, 'SECURITY.md'), 'utf8')
  check('SECURITY.md 提到 token', /token/i.test(sec))
  check('SECURITY.md 提到 auth.json', /auth\.json/i.test(sec))
}

console.log(`\n📋 审查结果：${issues.length} 项`)
for (const i of issues) console.log(`  ✗ ${i.label}${i.detail ? ' — ' + i.detail : ''}`)
if (!issues.length) console.log('  ✅ 一切正常')
process.exit(issues.length ? 1 : 0)
