// 生成 docs/TOOLS.md，并刷新 README 里的工具表。
// 用法：npm run gen-docs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderPage, applyToReadme } from './doc-tools.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const toolsFile = path.join(root, 'docs', 'TOOLS.md')
const readmeFile = path.join(root, 'README.md')

fs.mkdirSync(path.dirname(toolsFile), { recursive: true })
fs.writeFileSync(toolsFile, renderPage())

const readme = fs.readFileSync(readmeFile, 'utf8')
fs.writeFileSync(readmeFile, applyToReadme(readme))
process.stdout.write('gen-docs ok: docs/TOOLS.md + README\n')
