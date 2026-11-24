// 生成 docs/TOOLS.md（给 AI agent 看的完整工具参数文档）。
// README 里的「工具清单」部分是手写的、按功能分组的，不在这里生成。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderPage } from './doc-tools.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const toolsFile = path.join(root, 'docs', 'TOOLS.md')

fs.mkdirSync(path.dirname(toolsFile), { recursive: true })
fs.writeFileSync(toolsFile, renderPage())
process.stdout.write('gen-docs ok: docs/TOOLS.md\n')
