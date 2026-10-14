import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, inject as declaredInject, name } from '../src/host.mjs'
import { HTTP_PREFIX } from '../src/http.mjs'

/**
 * 这里盯的是一个真踩过的坑：apply 阶段 `ctx.get('webServer')` / `ctx.get('commands')`
 * 拿不到服务，注册会**静默**跳过 —— 装的时候一切正常，点按钮才 404、斜杠命令根本不存在。
 * 可选服务只能用 ctx.inject。
 */
function stubCtx({ available = ['commands', 'webServer'] } = {}) {
  const state = { tools: [], commands: [], effects: [], routes: [], injected: [], logs: [] }

  const makeChild = (serviceName) => {
    const child = {
      effect: (fn, label) => {
        state.effects.push(label)
        return fn()
      },
      get: () => undefined,
    }
    if (serviceName === 'commands') {
      child.commands = { register: (definition) => { state.commands.push(definition); return () => undefined } }
    }
    if (serviceName === 'webServer') {
      child.webServer = { register: (route) => { state.routes.push(route); return () => undefined } }
    }
    return child
  }

  const ctx = {
    logger: {
      info: (line) => state.logs.push(line),
      warn: (line) => state.logs.push(line),
    },
    subprocess: {
      spawn: () => { throw new Error('本测试不启动子进程') },
      resolveExecutable: async () => undefined,
    },
    tools: {
      register: (definition) => {
        state.tools.push(definition)
        return () => undefined
      },
    },
    effect: (fn, label) => {
      state.effects.push(label)
      return fn()
    },
    inject: (deps, callback) => {
      state.injected.push(deps)
      const serviceName = deps[0]
      if (!available.includes(serviceName)) return () => undefined
      callback(makeChild(serviceName))
      return () => undefined
    },
  }
  return { ctx, state }
}

// 绝大多数用例关掉自动修复：它是后台任务，会拿真实文件系统做探测。
const applyIdle = (ctx) => apply(ctx, { autoRepairOnStart: false })

test('入口名与包名一致，且硬依赖只保留 tools / subprocess', () => {
  assert.equal(name, 'myspace-dsh-browser-computer')
  assert.deepEqual(declaredInject, ['tools', 'subprocess'])
})

test('工具面只有两个：check 与 repair', async () => {
  const { ctx, state } = stubCtx()
  await applyIdle(ctx)
  assert.deepEqual(state.tools.map((tool) => tool.name).sort(), [
    'browser_computer_check', 'browser_computer_repair',
  ])
})

test('commands 与 webServer 都走 ctx.inject（不是 ctx.get）', async () => {
  const { ctx, state } = stubCtx()
  await applyIdle(ctx)
  assert.deepEqual(state.injected, [['commands'], ['webServer']])
})

test('斜杠命令与 HTTP 路由都真的挂上了', async () => {
  const { ctx, state } = stubCtx()
  await applyIdle(ctx)
  assert.equal(state.commands.length, 1)
  assert.equal(state.commands[0].name, 'browser-computer')
  assert.equal(state.routes.length, 1)
  assert.equal(state.routes[0].path, HTTP_PREFIX)
  assert.equal(state.routes[0].kind, 'prefix')
})

test('两个可选服务都不在的 profile：不注册它们，也不抛错，工具照常', async () => {
  const { ctx, state } = stubCtx({ available: [] })
  await applyIdle(ctx)
  assert.deepEqual(state.commands, [])
  assert.deepEqual(state.routes, [])
  assert.equal(state.tools.length, 2)
})

test('autoRepairOnStart 缺省即开启，显式关掉才不注册', async () => {
  const on = stubCtx()
  await apply(on.ctx, { autoRepairOnStart: true })
  assert.ok(on.state.effects.includes('browser-computer: auto repair'))

  const dflt = stubCtx()
  await apply(dflt.ctx, {})
  assert.ok(dflt.state.effects.includes('browser-computer: auto repair'), '缺省即开启')

  const off = stubCtx()
  await apply(off.ctx, { autoRepairOnStart: false })
  assert.ok(!off.state.effects.includes('browser-computer: auto repair'), '关掉后不应注册')
})

test('工具永远返回可解析的 JSON 文本，不把异常抛给模型层', async () => {
  const { ctx, state } = stubCtx()
  await applyIdle(ctx)
  const check = state.tools.find((tool) => tool.name === 'browser_computer_check')

  const raw = await check.execute({}, {})
  assert.equal(typeof raw, 'string')
  const parsed = JSON.parse(raw)
  assert.ok(parsed.stage === 'check' || parsed.ok === false)

  const rendered = check.output.render({}, raw)
  assert.equal(rendered[0].type, 'text')
  assert.equal(rendered[0].text, raw)
})

test('斜杠命令带未知参数时如实报错，不静默走默认分支', async () => {
  const { ctx, state } = stubCtx()
  await applyIdle(ctx)
  const result = await state.commands[0].handler({ rawInput: 'nonsense' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /未知参数/)
})
