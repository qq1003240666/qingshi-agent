import fs from 'node:fs'
import { assertNode, nodeVersion, resolveServer } from './detect.mjs'
import { CLIENTS, resolveTarget } from './config.mjs'
import { startServer } from './rpc.mjs'

export async function doctor({ client, scope, cwd, serverMetaUrl }) {
  const lines = []
  const fail = []
  try {
    assertNode()
    lines.push(`Node ${nodeVersion()}  OK`)
  } catch (error) {
    fail.push(error.message)
  }

  let serverPath
  try {
    serverPath = resolveServer(serverMetaUrl)
    lines.push(`MCP server  ${serverPath}`)
  } catch (error) {
    fail.push(error.message)
  }

  if (client) {
    try {
      const target = resolveTarget(client, scope || CLIENTS[client]?.defaultScope, cwd)
      const exists = fs.existsSync(target.file)
      lines.push(`配置  ${target.file}${exists ? '' : '（尚未创建）'}`)
    } catch (error) {
      fail.push(error.message)
    }
  }

  if (serverPath) {
    const session = startServer(serverPath)
    try {
      const init = await session.initialize('qingshi-doctor')
      lines.push(`协议  ${init.protocolVersion}  server ${init.serverInfo?.name}@${init.serverInfo?.version}`)
      const list = await session.request('tools/list')
      lines.push(`工具  ${list.tools?.length || 0} 个`)
      if (!list.tools?.length) fail.push('tools/list 返回为空')
      if (init.instructions) lines.push('instructions 已注入')
    } catch (error) {
      fail.push(`握手失败：${error.message}`)
      const err = session.stderr()
      if (err) lines.push(`server stderr: ${err.trim().split('\n').slice(-3).join(' | ')}`)
    } finally {
      session.close()
    }
  }

  return { lines, fail }
}
