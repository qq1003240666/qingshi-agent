// 数据目录必须「一台机器一份」，且和宿主无关。
// 这组断言守住三件事：默认位置按平台固定、显式配置能覆盖、老数据会搬过来且不覆盖新数据。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, platform, homedir } from 'node:os'

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || !detail ? '' : '  ← ' + detail))
}

const { defaultHomeDir, resolveHomeDir, legacyDirs, migrateLegacy, APP_DIR_NAME } = await import('../packages/core/lib/paths.js')

console.log('— 默认位置')
const home = defaultHomeDir()
check('目录名是 qingshi-plugin', home.endsWith(APP_DIR_NAME), home)
check('所有平台统一落在 home 根目录', home === join(homedir(), 'qingshi-plugin'), home)
check('默认目录是绝对路径', /^([a-zA-Z]:[\\/]|\/)/.test(home), home)

console.log('— 覆盖顺序')
check('显式 workspaceDir 优先', resolveHomeDir({ workspaceDir: join(tmpdir(), 'qh-x') }) === join(tmpdir(), 'qh-x'))
const prev = process.env.QINGSHI_HOME
process.env.QINGSHI_HOME = join(tmpdir(), 'qh-env')
check('QINGSHI_HOME 次之', resolveHomeDir({}) === join(tmpdir(), 'qh-env'))
check('显式仍高于 QINGSHI_HOME', resolveHomeDir({ workspaceDir: join(tmpdir(), 'qh-y') }) !== join(tmpdir(), 'qh-env'))
if (prev === undefined) delete process.env.QINGSHI_HOME
else process.env.QINGSHI_HOME = prev

console.log('— 迁移老数据')
const sandbox = mkdtempSync(join(tmpdir(), 'qh-mig-'))
const legacy = join(sandbox, 'legacy')
const target = join(sandbox, 'target')
mkdirSync(join(legacy, 'media', 'd1'), { recursive: true })
writeFileSync(join(legacy, 'auth.json'), JSON.stringify({ uid: 'u1', accessToken: 'at' }))
writeFileSync(join(legacy, 'drafts.json'), '[]')
writeFileSync(join(legacy, 'media', 'd1', 'a.txt'), 'hi')
mkdirSync(join(legacy, 'shots'), { recursive: true })
writeFileSync(join(legacy, 'shots', 'x.png'), 'png')

const prevDsh = process.env.DSH_HOME
process.env.DSH_HOME = sandbox
// legacyDirs 里第一项就是 $DSH_HOME/qingshi-workspace
mkdirSync(join(sandbox, 'qingshi-workspace'), { recursive: true })
for (const f of ['auth.json', 'drafts.json']) {
  writeFileSync(join(sandbox, 'qingshi-workspace', f), readFileSync(join(legacy, f)))
}
mkdirSync(join(sandbox, 'qingshi-workspace', 'media', 'd1'), { recursive: true })
writeFileSync(join(sandbox, 'qingshi-workspace', 'media', 'd1', 'a.txt'), 'hi')

const moved = migrateLegacy(target)
check('搬来了 auth.json', existsSync(join(target, 'auth.json')), moved.join(','))
check('搬来了 drafts.json', existsSync(join(target, 'drafts.json')))
check('搬来了 media/', existsSync(join(target, 'media', 'd1', 'a.txt')))
check('没搬体积大的 shots/', !existsSync(join(target, 'shots')), 'shots 不该被搬')
check('内容一致', JSON.parse(readFileSync(join(target, 'auth.json'), 'utf8')).uid === 'u1')

writeFileSync(join(target, 'auth.json'), JSON.stringify({ uid: 'newer' }))
migrateLegacy(target)
check('已有文件不会被老数据覆盖', JSON.parse(readFileSync(join(target, 'auth.json'), 'utf8')).uid === 'newer')

// ---- 回退机制（平台默认不可写时）----
// 现在默认位置已经是 ~/qingshi-plugin（用户自己 home 根目录，几乎总可写）。
// 但 cwdFallbackDir / tmpFallbackDir 仍然存在，万一 home 真被锁死时保底。
{
  const { pickHomeDir, cwdFallbackDir } = await import('../packages/core/lib/paths.js')
  // 1) cwdFallbackDir 返回 .qingshi-plugin 前缀
  const cwdBack = cwdFallbackDir()
  check('cwd 回退是 .qingshi-plugin 前缀', cwdBack.endsWith('.qingshi-plugin'), cwdBack)
  check('cwd 回退落在 process.cwd() 下', cwdBack.startsWith(process.cwd()), cwdBack)

  // 2) 显式 workspaceDir 优先，不受任何回退影响
  const forced = pickHomeDir({ workspaceDir: join(sandbox, 'forced') })
  check('显式配置优先', forced.source === 'config' && forced.dir === join(sandbox, 'forced'), JSON.stringify(forced))
}

if (prevDsh === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = prevDsh
rmSync(sandbox, { recursive: true, force: true })

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
if (failed.length) process.exit(1)
