/**
 * 插件入口（辅助半边）。
 *
 * 本插件的本体是 cordis.patch.yml 里那两条 MCP 行（playwright-mcp / peekaboo-mcp）——
 * 它们不依赖这个文件就能生效。这里只挂三样东西：
 *   1. 模型可见的工具（check / test / setup）
 *   2. 人类可用的斜杠命令 `/browser-computer`
 *   3. 设置页用的同源 HTTP 路由
 *
 * 依赖一律用 ctx.get 惰性取：cordis 把每个 inject 条目都当作**硬依赖**，写进去会让
 * 缺少该行的 profile 整个装不上（headless 之类没有 webServer 的场景）。
 */
import { Config, normalizeConfig } from './config.mjs'
import { createDoctor } from './doctor.mjs'
import { createHandler, HTTP_PREFIX } from './http.mjs'
import { registerCommand, registerTools } from './tools.mjs'

export const name = 'dsh-browser-computer'
export const inject = ['tools', 'subprocess']
export { Config }

export async function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  const doctor = createDoctor({ ctx, settings })

  ctx.effect(() => registerTools(ctx, doctor), 'browser-computer: tools')

  // commands 与 webServer 都是**可选**服务，统一用 ctx.inject 声明：
  //   - apply 阶段 ctx.get('webServer') / ctx.get('commands') 拿不到服务（实测返回 undefined），
  //     会**静默**不注册（装的时候一切正常，点按钮才 404、斜杠命令根本不存在）
  //   - 直接写进 inject 又会让缺少这些行的 profile 整个装不上
  // 服务齐全时回调才会跑；服务消失时回调注册的东西一并释放。
  ctx.inject(['commands'], (commandCtx) => {
    // 注入后的 ctx.commands 是服务对象本身，直接调它的 register。
    commandCtx.effect(
      () => registerCommand(commandCtx.commands, doctor),
      'browser-computer: command',
    )
  })

  ctx.inject(['webServer'], (httpCtx) => {
    const admit = (req) => {
      // connection 在**请求时**取即可：这时上下文已完全组装好（scout / butler 同款写法）。
      const connection = httpCtx.get?.('connection')
      return typeof connection?.admit === 'function' ? connection.admit(req) : undefined
    }
    httpCtx.effect(
      () => httpCtx.webServer.register({ kind: 'prefix', path: HTTP_PREFIX, handler: createHandler({ doctor, admit }) }),
      'browser-computer: http',
    )
  })

  // 装上就自动补齐：查环境 → 装缺的依赖 → 查授权 → 需要授权就打开系统设置面板。
  // 幂等（已缓存的包不重拉、授权齐全时不动系统设置），且**绝不打断激活**：
  // 整段是后台任务，失败只记一行日志。
  if (settings.autoRepairOnStart) {
    ctx.effect(() => {
      const controller = new AbortController()
      void doctor
        .repair({ openSettings: true, verify: false, signal: controller.signal })
        .then((report) => {
          const failed = report.steps.filter((step) => !step.ok)
          const line = failed.length
            ? failed.map((step) => `${step.step}=${step.detail ?? '未通过'}`).join('；')
            : '依赖与授权均无需处理'
          ctx.logger?.[failed.length ? 'warn' : 'info']?.(`[browser-computer] 自动自检：${line}`)
        })
        .catch((error) => {
          ctx.logger?.warn?.(`[browser-computer] 自动自检失败：${error instanceof Error ? error.message : String(error)}`)
        })
      return () => controller.abort()
    }, 'browser-computer: auto repair')
  }
}
