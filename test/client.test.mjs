import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { HTTP_PREFIX, INTENT_HEADER } from '../src/http.mjs'

const PKG = 'dsh-browser-computer'
const LEGACY_ID = 'myspace-dsh-browser-computer'

/**
 * 不引入打包器，直接把 Client 半边当普通脚本在受控全局里跑一遍。
 * 这一步能抓到：包信封写错、导出形状不对、槽位注册写错、样式标签没打归属标记、
 * 偷偷 require 了别的 Harness Client 包、以及分区没有按 subject 屏蔽别的插件。
 */
async function loadClient({ fetchImpl } = {}) {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')

  const sink = { effects: [], sets: [] }
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, (value) => { sink.sets.push(value) }],
    useCallback: (fn) => fn,
    useEffect: (fn) => { sink.effects.push(fn) },
  }
  const required = []
  const requireImpl = (id) => {
    required.push(id)
    if (id === 'react') return react
    throw new Error(`unexpected require: ${id}`)
  }

  const styles = []
  const documentStub = {
    createElement: () => ({ dataset: {}, textContent: '', removed: false, remove() { this.removed = true } }),
    head: { appendChild: (tag) => styles.push(tag) },
  }

  let loaded
  const windowStub = { __ModuleLoader__: { load: (entry) => { loaded = entry } } }

  // eslint-disable-next-line no-new-func
  new Function('window', 'require', 'document', 'fetch', source)(
    windowStub, requireImpl, documentStub, fetchImpl ?? (() => { throw new Error('测试未提供 fetch') }),
  )

  assert.ok(loaded, 'client 脚本没有调用 window.__ModuleLoader__.load')
  return { loaded, mod: loaded.factory(requireImpl), required, styles, sink }
}

function mount({ mod, styles, sink }) {
  const effects = []
  const injections = []
  const ctx = {
    effect: (fn, label) => {
      effects.push(label)
      return fn()
    },
    slots: {
      inject: (owner, install) => {
        injections.push({ owner, entry: install() })
        return () => undefined
      },
      register: (options, Component) => ({ options, Component }),
    },
  }
  mod.apply(ctx)
  return { effects, injections, styles, sink }
}

test('Client 信封：id 等于包名，只 require react', async () => {
  const { loaded, mod, required } = await loadClient()
  assert.equal(loaded.id, PKG)
  assert.deepEqual(required, ['react'])
  assert.deepEqual(mod.inject, ['slots'])
  assert.equal(typeof mod.apply, 'function')
})

test('挂到插件详情页槽位（不是宿主设置页），样式与注册都在 ctx.effect 里', async () => {
  const loaded = await loadClient()
  const { effects, injections, styles } = mount(loaded)

  assert.ok(effects.includes('browser-computer: stylesheet'))
  assert.ok(effects.includes('browser-computer: detail section'))

  const owners = injections.map((item) => item.owner)
  assert.deepEqual(owners, ['plugins.detail.section'], '不应再挂到 settings.section')

  assert.equal(styles.length, 1)
  assert.equal(styles[0].dataset.plugin, PKG)
  assert.equal(styles[0].dataset.pluginCss, `${LEGACY_ID}/style`)

  const section = injections[0]
  assert.equal(section.entry.options.name, 'plugins.detail.section')
  assert.equal(section.entry.options.id, `${LEGACY_ID}/section`)
  assert.equal(typeof section.entry.options.label, 'function')
  assert.equal(typeof section.entry.Component, 'function')
})

test('分区只在本插件详情页渲染：别人的 subject 返回 null', async () => {
  const loaded = await loadClient()
  const { injections } = mount(loaded)
  const Section = injections[0].entry.Component

  assert.equal(Section({ subject: { kind: 'bundle', pkg: { name: 'some-other-plugin' } } }), null)
  assert.equal(Section({ subject: { kind: 'row', pkg: { name: 'dsh-context' } } }), null)
  assert.equal(Section({ subject: undefined }), null)

  const own = Section({ subject: { kind: 'bundle', pkg: { name: PKG } } })
  assert.ok(own, '自己的详情页必须渲染出内容')
  assert.equal(own.type, 'section')
})

test('首次打开就自动跑一次只读检查（on-mount effect 已挂）', async () => {
  const loaded = await loadClient()
  const { injections, sink } = mount(loaded)
  const Section = injections[0].entry.Component

  Section({ subject: { kind: 'bundle', pkg: { name: PKG } } })
  assert.equal(sink.effects.length, 1, '组件应注册一个自动检查的 effect')
  assert.equal(typeof sink.effects[0], 'function')
})

test('Client 的接口路径与意图头跟 Host 路由一致', async () => {
  const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes(`'${INTENT_HEADER}'`), `client 没有发送意图头 ${INTENT_HEADER}`)
  for (const path of ['/api/status', '/api/repair']) {
    assert.ok(source.includes(path), `client 没有调用 ${path}`)
  }
})

test('Host 还没重载（路由 404）时，错误里要直接给出「完整重启 App」的指引', async () => {
  // 真跑一遍 call() 的错误映射：模拟旧 Host 处理器返回的 404。
  const fetchImpl = async (url) => {
    assert.equal(url, `${HTTP_PREFIX}/api/status`)
    return {
      ok: false,
      status: 404,
      json: async () => ({ ok: false, error: { code: 'not-found', message: '未知接口 /api/repair' } }),
    }
  }

  const loaded = await loadClient({ fetchImpl })
  const { injections, sink } = mount(loaded)
  const Section = injections[0].entry.Component

  Section({ subject: { kind: 'bundle', pkg: { name: PKG } } })
  assert.equal(sink.effects.length, 1, '应有自动读状态的 effect')

  await sink.effects[0]()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const messages = sink.sets.filter((value) => typeof value === 'string')
  assert.ok(
    messages.some((text) => /重开 DSH App/.test(text)),
    `404 的提示必须说清怎么修，实际收到：${JSON.stringify(messages)}`,
  )
  assert.ok(
    messages.some((text) => text.includes('/api/status')),
    '提示里应带上出问题的接口路径',
  )
})
