import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'

import { probeMcpServer } from '../src/mcp-probe.mjs'

/** 假 MCP server：在内存流上跑真实的换行分隔 JSON-RPC。 */
function fakeServer({ mode = 'ok' } = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let settle
  const done = new Promise((resolve) => {
    settle = resolve
  })

  let buffer = ''
  stdin.setEncoding('utf8')
  stdin.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      const message = JSON.parse(line)
      if (message.method === 'initialize') {
        if (mode === 'rpc-error') {
          stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'boom' } })}\n`)
        } else if (mode !== 'silent') {
          stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fake-mcp', version: '9.9.9' } },
          })}\n`)
        }
      } else if (message.method === 'tools/list') {
        stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'alpha' }, { name: 'beta' }] } })}\n`)
      }
    }
  })

  return {
    stdin,
    stdout,
    stderr,
    done,
    terminate() {
      settle({ exitCode: 0, signal: null })
    },
    waitForExit: async () => true,
  }
}

const procFor = (child) => ({
  spawnPipe: () => ({ handle: child }),
  run: async () => ({ ok: true, stdout: '', stderr: '', exitCode: 0, signal: null, truncated: false, timedOut: false }),
  resolveExecutable: async () => '/fake/bin/npx',
  stderrTail: () => [],
})

test('握手成功时返回服务端信息与工具清单', async () => {
  const result = await probeMcpServer({
    proc: procFor(fakeServer()),
    argv: ['npx', '-y', 'fake'],
    cwd: '/tmp',
    timeoutMs: 2000,
  })
  assert.equal(result.ok, true)
  assert.equal(result.phase, 'ready')
  assert.equal(result.serverName, 'fake-mcp')
  assert.equal(result.serverVersion, '9.9.9')
  assert.equal(result.toolCount, 2)
  assert.deepEqual(result.tools, ['alpha', 'beta'])
  assert.equal(typeof result.elapsedMs, 'number')
})

test('RPC 错误被如实报成 rpc 阶段失败', async () => {
  const result = await probeMcpServer({
    proc: procFor(fakeServer({ mode: 'rpc-error' })),
    argv: ['npx', '-y', 'fake'],
    cwd: '/tmp',
    timeoutMs: 2000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.phase, 'rpc')
  assert.match(result.error, /boom/)
})

test('服务端不响应时按超时失败，不挂住', async () => {
  const started = Date.now()
  const result = await probeMcpServer({
    proc: procFor(fakeServer({ mode: 'silent' })),
    argv: ['npx', '-y', 'fake'],
    cwd: '/tmp',
    timeoutMs: 150,
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /超时/)
  assert.ok(Date.now() - started < 3000)
})

test('起不来子进程时按 spawn 阶段失败', async () => {
  const result = await probeMcpServer({
    proc: { spawnPipe: () => ({ error: 'ENOENT: npx' }), stderrTail: () => [] },
    argv: ['npx', '-y', 'fake'],
    cwd: '/tmp',
    timeoutMs: 2000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.phase, 'spawn')
  assert.match(result.error, /ENOENT/)
})
