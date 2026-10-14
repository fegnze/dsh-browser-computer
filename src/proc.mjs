/**
 * DSH `subprocess` 接缝的薄适配层。
 *
 * 只做三件事：把 spec 摆成 provider 要的形状、带上限收集输出、把超时变成明确的
 * 结果而不是挂住的 Promise。**不使用 Node child_process** —— 子进程必须活在 DSH
 * 托管范围内，随 App 生命周期回收（工作区硬性约定）。
 */

const DEFAULT_MAX_BYTES = 256 * 1024
const STDERR_TAIL_LINES = 12

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export function createProc(ctx, { graceMs = 5000 } = {}) {
  if (!ctx?.subprocess?.spawn) throw new Error('browser-computer 需要 subprocess 服务')

  /** 裸名走 provider 的 PATH 解析；失败返回 undefined，由调用方决定降级。 */
  async function resolveExecutable(command) {
    try {
      const resolved = await ctx.subprocess.resolveExecutable(command)
      return typeof resolved === 'string' && resolved ? resolved : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 起一个双向子进程（stdio 全 pipe），供 MCP 握手这类需要持续读写 stdio 的场景使用。
   * spec 非法时 provider 会同步抛错，这里如实转成 { error }。
   */
  function spawnPipe({ argv, cwd, env }) {
    try {
      const handle = ctx.subprocess.spawn({
        argv,
        cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs,
        ...(env ? { env } : {}),
      })
      return { handle }
    } catch (error) {
      return { error: messageOf(error) }
    }
  }

  /**
   * 跑一条有限命令并收集输出。永远 resolve，用 ok / timedOut / spawnError 表达结果。
   * 输出超过 maxBytes 时记录 truncated，不把大段正文灌回上游。
   */
  function run({ argv, cwd, env, timeoutMs = 30000, maxBytes = DEFAULT_MAX_BYTES }) {
    return new Promise((resolve) => {
      let handle
      try {
        handle = ctx.subprocess.spawn({
          argv,
          cwd,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          graceMs,
          ...(env ? { env } : {}),
        })
      } catch (error) {
        resolve({ ok: false, spawnError: messageOf(error), stdout: '', stderr: '', exitCode: null, signal: null, truncated: false, timedOut: false })
        return
      }

      const out = []
      const err = []
      let outBytes = 0
      let errBytes = 0
      let truncated = false

      const pump = (stream, sink, add) => {
        if (!stream) return
        stream.setEncoding?.('utf8')
        stream.on('data', (chunk) => {
          const text = String(chunk)
          if (add(text.length)) {
            truncated = true
            return
          }
          sink.push(text)
        })
        stream.on('error', () => undefined)
      }
      pump(handle.stdout, out, (n) => ((outBytes += n), outBytes > maxBytes))
      pump(handle.stderr, err, (n) => ((errBytes += n), errBytes > maxBytes))

      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          stdout: out.join(''),
          stderr: err.join(''),
          truncated,
          timedOut: false,
          spawnError: undefined,
          ...result,
        })
      }

      const timer = setTimeout(async () => {
        if (settled) return
        try {
          handle.terminate()
          await handle.waitForExit?.()
        } catch {
          /* provider 已回收 */
        }
        finish({ ok: false, exitCode: null, signal: null, timedOut: true })
      }, timeoutMs)
      // 故意不 unref：子进程不退出时，这个定时器是唯一能把 run() 收尾的东西。

      handle.done.then(
        (outcome) => finish({ ok: outcome.exitCode === 0, exitCode: outcome.exitCode, signal: outcome.signal }),
        (error) => finish({ ok: false, exitCode: null, signal: null, spawnError: messageOf(error) }),
      )
    })
  }

  /** 只保留 stderr 末几行，用于诊断，不灌大段正文。 */
  function stderrTail(text, lines = STDERR_TAIL_LINES) {
    return String(text || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-lines)
  }

  return { run, spawnPipe, resolveExecutable, stderrTail }
}
