/**
 * 最小 MCP stdio 客户端 + 连接探测。
 *
 * 只实现握手要用到的部分：initialize / notifications/initialized / tools/list。
 * 传输是换行分隔的 JSON-RPC（MCP stdio transport），不依赖任何 MCP SDK —— Host
 * 半边保持零运行时依赖。
 *
 * 形态对齐工作区内已验证的实现（butler-plugin 的 mcp-stdio），不另立第二套语义。
 */

const MAX_BUFFER_BYTES = 16 * 1024 * 1024
const STDERR_TAIL_LINES = 8
const MAX_REPORTED_TOOLS = 60

export class McpRpcError extends Error {
  constructor(message, code, data) {
    super(message)
    this.name = 'McpRpcError'
    this.code = code
    this.data = data
  }
}

export class McpStdioClient {
  #nextId = 1
  #buffer = ''
  #pending = new Map()
  #closedError
  #stderrTail = []

  constructor(child, { clientName = 'dsh-browser-computer' } = {}) {
    this.child = child
    this.clientName = clientName
    this.serverInfo = undefined

    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => this.#feed(String(chunk)))
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) this.#stderrTail.push(line.trim().slice(0, 400))
      }
      while (this.#stderrTail.length > STDERR_TAIL_LINES) this.#stderrTail.shift()
    })
    child.stdin?.on?.('error', () => undefined)
    void child.done.then(
      (outcome) => {
        const why = outcome?.error?.message
          ?? `退出码 ${outcome?.exitCode ?? '-'}${outcome?.signal ? ` / ${outcome.signal}` : ''}`
        this.#fail(new Error(`MCP 进程已结束（${why}）`))
      },
      (error) => this.#fail(error instanceof Error ? error : new Error(String(error))),
    )
  }

  get stderrTail() {
    return [...this.#stderrTail]
  }

  get closed() {
    return this.#closedError !== undefined
  }

  async initialize(timeoutMs) {
    const result = await this.#request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: this.clientName, version: '1' },
    }, timeoutMs)
    this.serverInfo = result?.serverInfo
    this.#notify('notifications/initialized')
    return result
  }

  async listTools(timeoutMs) {
    const tools = []
    let cursor
    for (let page = 0; page < 50; page += 1) {
      const result = await this.#request('tools/list', cursor ? { cursor } : {}, timeoutMs)
      for (const tool of result?.tools ?? []) {
        if (tool && typeof tool.name === 'string') tools.push(tool)
      }
      cursor = result?.nextCursor
      if (!cursor) break
    }
    return tools
  }

  close() {
    this.#fail(new Error('MCP 连接已关闭'))
    try {
      void this.child.terminate?.()
    } catch {
      /* 已经回收 */
    }
  }

  #request(method, params, timeoutMs) {
    if (this.#closedError) return Promise.reject(this.#closedError)
    const id = this.#nextId
    this.#nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`MCP ${method} 超时（${Math.round(timeoutMs / 1000)}s）`))
      }, timeoutMs)
      // 故意不 unref：超时本身就是防止挂死的安全机制，必须能真正触发。
      this.#pending.set(id, { resolve, reject, timer })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  #notify(method, params) {
    if (this.#closedError) return
    this.#write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  #write(message) {
    try {
      const stdin = this.child.stdin
      if (!stdin) throw new Error('MCP 进程没有 stdin')
      stdin.write(`${JSON.stringify(message)}\n`)
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  #feed(chunk) {
    this.#buffer += chunk
    if (this.#buffer.length > MAX_BUFFER_BYTES) {
      this.#fail(new Error('MCP stdout 单行过大'))
      return
    }
    let index
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue // stdout 上混入的日志行直接忽略
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message) {
    if (typeof message?.method === 'string') {
      if (message.id !== undefined) {
        // 服务端反向请求：本客户端不声明任何能力，ping 之外一律如实拒绝。
        const reply = message.method === 'ping'
          ? { jsonrpc: '2.0', id: message.id, result: {} }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'browser-computer 不提供客户端能力' } }
        this.#write(reply)
      }
      return
    }
    const id = typeof message?.id === 'number' ? message.id : Number(message?.id)
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    const error = message.error
    if (error) pending.reject(new McpRpcError(error.message ?? 'MCP 错误', error.code ?? -32603, error.data))
    else pending.resolve(message.result)
  }

  #fail(error) {
    if (this.#closedError) return
    this.#closedError = error
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.#pending.delete(id)
    }
  }
}

/**
 * 对一个 MCP server 做真实握手并清点工具。
 * 结果里只有计数、名称清单与诊断尾部，不回灌 schema 正文。
 */
export async function probeMcpServer({ proc, argv, cwd, env, timeoutMs = 90000 }) {
  const startedAt = Date.now()
  const spawned = proc.spawnPipe({ argv, cwd, env })
  if (spawned.error) {
    return { ok: false, phase: 'spawn', error: spawned.error, argv, elapsedMs: Date.now() - startedAt }
  }

  const client = new McpStdioClient(spawned.handle)
  try {
    const init = await client.initialize(timeoutMs)
    const tools = await client.listTools(timeoutMs)
    const names = tools.map((tool) => tool.name)
    return {
      ok: true,
      phase: 'ready',
      argv,
      elapsedMs: Date.now() - startedAt,
      serverName: init?.serverInfo?.name,
      serverVersion: init?.serverInfo?.version,
      protocolVersion: init?.protocolVersion,
      toolCount: names.length,
      tools: names.slice(0, MAX_REPORTED_TOOLS),
      toolsTruncated: names.length > MAX_REPORTED_TOOLS,
      stderrTail: client.stderrTail,
    }
  } catch (error) {
    return {
      ok: false,
      phase: error instanceof McpRpcError ? 'rpc' : 'handshake',
      error: error instanceof Error ? error.message : String(error),
      argv,
      elapsedMs: Date.now() - startedAt,
      stderrTail: client.stderrTail,
    }
  } finally {
    client.close()
    try {
      await spawned.handle.waitForExit?.()
    } catch {
      /* 回收失败不影响探测结论 */
    }
  }
}
