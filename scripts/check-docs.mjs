// 文档漂移检查：README 工具表 / docs/TOOLS.md / 客户端文档必须与源码一致。
// 用法：npm run check-docs（CI 里在 build 之后跑）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderPage, applyToReadme } from './doc-tools.mjs'
import { clientIds } from '../packages/cli/src/config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

const toolsFile = path.join(root, 'docs', 'TOOLS.md')
const toolsText = read(toolsFile)
if (toolsText === null) problems.push('缺少 docs/TOOLS.md，运行 npm run gen-docs')
else if (toolsText !== renderPage()) problems.push('docs/TOOLS.md 与源码不一致，运行 npm run gen-docs')

const readmeFile = path.join(root, 'README.md')
const readme = read(readmeFile)
if (readme === null) {
  problems.push('缺少 README.md')
} else {
  try {
    if (applyToReadme(readme) !== readme) problems.push('README.md 的工具表已过期，运行 npm run gen-docs')
  } catch (error) {
    problems.push(error.message)
  }
}

for (const id of clientIds()) {
  const file = path.join(root, 'docs', 'clients', `${id}.md`)
  if (!fs.existsSync(file)) problems.push(`缺少客户端文档 docs/clients/${id}.md`)
}

if (problems.length) {
  for (const line of problems) process.stderr.write(`check-docs FAIL  ${line}\n`)
  process.exit(1)
}
process.stdout.write('check-docs ok\n')
