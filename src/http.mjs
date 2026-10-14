/**
 * 同源 HTTP 路由：插件详情页的两个动作走这里调 Host 能力。
 *
 * 为什么不走 Remote/Typert：`ctx.remote.*` 的命名空间在构建期固定，第三方插件加不了
 * 自己的名字空间（`@deepseek-ai/dsh-api-remotes` 明确说明）。官方 practices 也要求
 * 「不要把页面塞进 iframe」，同源 fetch 是第三方可用的正规路径。
 *
 * 每一条路由都过两道栅栏：自定义意图头（挡掉跨站简单请求）+ `connection.admit`
 * （Host/Origin 栅栏与浏览器认证）。
 */
export const HTTP_PREFIX = '/myspace-dsh-browser-computer'
export const INTENT_HEADER = 'x-myspace-browser-computer'

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req, limitBytes = 64 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

export function createHandler({ doctor, admit }) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(HTTP_PREFIX.length) || '/'

    if (req.headers[INTENT_HEADER] !== '1') {
      return send(res, 403, { ok: false, error: { code: 'forbidden', message: '缺少意图头' } })
    }
    const admission = admit(req)
    if (!admission || admission.rejection !== undefined || !admission.peer) {
      return send(res, admission?.rejection ?? 403, {
        ok: false,
        error: { code: 'forbidden', message: 'DSH 认证失败，请重新打开应用' },
      })
    }

    try {
      if (req.method === 'GET' && (path === '/' || path === '/api/status')) {
        return send(res, 200, { ok: true, value: await doctor.check() })
      }
      if (req.method === 'POST' && path === '/api/repair') {
        const body = await readJson(req)
        return send(res, 200, {
          ok: true,
          value: await doctor.repair({
            openSettings: body.openSettings !== false,
            verify: body.verify !== false,
            force: body.force === true,
          }),
        })
      }
      return send(res, 404, { ok: false, error: { code: 'not-found', message: `未知接口 ${path}` } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return send(res, error?.status ?? 500, { ok: false, error: { code: 'error', message } })
    }
  }
}
