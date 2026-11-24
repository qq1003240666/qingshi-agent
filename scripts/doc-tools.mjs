// 工具文档的唯一渲染逻辑：gen-docs 写入，check-docs 比对。
import { TOOL_MANIFEST } from '../packages/core/lib/tool-manifest.js'

export const START = '<!-- TOOLS:START -->'
export const END = '<!-- TOOLS:END -->'

function kind(item) {
  if (item.destructive) return '危险写'
  if (item.readOnly) return '只读'
  if (item.localOnly) return '本地窗口'
  return '写入'
}

export function renderTable() {
  const lines = [
    '| 工具 | 标题 | 类型 |',
    '| --- | --- | --- |',
    ...TOOL_MANIFEST.map((item) => `| \`${item.name}\` | ${item.title} | ${kind(item)} |`),
  ]
  return lines.join('\n')
}

export function renderPage() {
  return [
    '# 工具清单',
    '',
    `共 ${TOOL_MANIFEST.length} 个工具。这份文件由 \`npm run gen-docs\` 生成，请勿手改。`,
    '',
    renderTable(),
    '',
  ].join('\n')
}

/** 把表格塞进 README 的标记块之间 */
export function applyToReadme(text) {
  const start = text.indexOf(START)
  const end = text.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`README 缺少 ${START} / ${END} 标记`)
  }
  const block = `${START}\n${renderTable()}\n${END}`
  return text.slice(0, start) + block + text.slice(end + END.length)
}
