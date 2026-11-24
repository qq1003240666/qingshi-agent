import { spawn } from 'node:child_process'

/** 启动 MCP server 并做一次 JSON-RPC 往返，用于 doctor / where */
export function startServer(serverPath, { timeoutMs = 15000 } = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, QINGSHI_CLIENT_NAME: process.env.QINGSHI_CLIENT_NAME || 'qingshi-cli' },
  })
  let buffer = ''
  let stderr = ''
  let nextId = 1
  const pending = new Map()

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index === -1) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id != null && pending.has(message.id)) {
        const entry = pending.get(message.id)
        pending.delete(message.id)
        entry.resolve(message)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  function send(message) {
    child.stdin.write(JSON.stringify(message) + '\n')
  }

  function request(method, params = {}) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`等待 ${method} 响应超时（${timeoutMs}ms）`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          if (message.error) reject(new Error(`${method} 失败：${message.error.message}`))
          else resolve(message.result)
        },
      })
      send({ jsonrpc: '2.0', id, method, params })
    })
  }

  async function initialize(clientName = 'qingshi-cli') {
    const result = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: clientName, version: '0.0.0' },
    })
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return result
  }

  function close() {
    try {
      child.stdin.end()
      child.kill()
    } catch {
      // 进程可能已经退出
    }
  }

  return {
    child,
    request,
    initialize,
    close,
    stderr: () => stderr,
  }
}
