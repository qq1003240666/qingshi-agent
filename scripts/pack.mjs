// 打包：dist + 文档 → artifacts/qingshi-<version>.tar.gz 与 sha256。
// 不发布 npm，GitHub Release 直接挂这个 tarball。
// 用法：npm run build && npm run pack
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const artifacts = path.join(root, 'artifacts')
const name = `qingshi-${version}`
const stage = path.join(artifacts, name)
const archive = path.join(artifacts, `${name}.tar.gz`)

if (!fs.existsSync(path.join(root, 'dist', 'mcp-server', 'bin', 'qingshi-mcp.mjs'))) {
  process.stderr.write('pack: 先运行 npm run build\n')
  process.exit(1)
}

fs.rmSync(stage, { recursive: true, force: true })
fs.rmSync(archive, { force: true })
fs.mkdirSync(stage, { recursive: true })

for (const entry of ['dist', 'docs']) {
  fs.cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true })
}
for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
  const from = path.join(root, file)
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(stage, file))
}

// 顶层再放两个启动器，解压后不改 PATH 也能用
fs.writeFileSync(path.join(stage, 'qingshi.cmd'), '@echo off\r\nnode "%~dp0dist\\cli\\bin\\qingshi.mjs" %*\r\n')
fs.writeFileSync(
  path.join(stage, 'qingshi'),
  '#!/bin/sh\nexec node "$(dirname "$0")/dist/cli/bin/qingshi.mjs" "$@"\n',
  { mode: 0o755 },
)

execFileSync('tar', ['-czf', archive, '-C', artifacts, name], { stdio: 'inherit' })
const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`)
fs.rmSync(stage, { recursive: true, force: true })
process.stdout.write(`pack ok: artifacts/${path.basename(archive)}\nsha256: ${digest}\n`)
