import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../src/config.mjs'
import { probePermissions } from '../src/probes.mjs'
import { buildActions } from '../src/doctor.mjs'

/** 2026-10-14 从 `peekaboo permissions status --json --no-remote` 抓到的真实形状。 */
const REAL_JSON = JSON.stringify({
  debug_logs: ['[2026-10-14T07:08:22.101Z] DEBUG: Runtime host: local (in-process)'],
  data: {
    permissions: [
      {
        name: 'Screen Recording',
        isRequired: true,
        isGranted: true,
        grantInstructions: 'System Settings > Privacy & Security > Screen Recording',
      },
      {
        name: 'Accessibility',
        isRequired: true,
        isGranted: true,
        grantInstructions: 'System Settings > Privacy & Security > Accessibility',
      },
      {
        name: 'Event Synthesizing',
        isRequired: false,
        isGranted: true,
        grantInstructions: 'System Settings > Privacy & Security > Accessibility',
      },
    ],
  },
})

const withJson = (payload) => JSON.stringify({
  data: {
    permissions: [
      { name: 'Screen Recording', isRequired: true, isGranted: true },
      { name: 'Accessibility', isRequired: true, isGranted: false },
      { name: 'Event Synthesizing', isRequired: false, isGranted: payload },
    ],
  },
})

const procReturning = (stdout) => ({
  run: async () => ({ ok: true, stdout, stderr: '', exitCode: 0, signal: null, truncated: false, timedOut: false }),
  stderrTail: () => [],
  resolveExecutable: async () => '/fake/npx',
})

const envFor = { platform: 'darwin', npxPath: '/fake/bin/npx', cwd: '/tmp' }
const settings = normalizeConfig({})

test('真实 JSON 形状：三项都能读出来（名字在 value 的 name 字段里，不是 key）', async () => {
  const result = await probePermissions({ proc: procReturning(REAL_JSON), settings, env: envFor })
  assert.equal(result.parsedAs, 'json')
  assert.equal(result.states.screenRecording, 'granted')
  assert.equal(result.states.accessibility, 'granted')
  assert.equal(result.states.eventSynthesizing, 'granted')
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.unknown, [])
})

test('明确未授予时报 denied，且进了 missing', async () => {
  const result = await probePermissions({ proc: procReturning(withJson(false)), settings, env: envFor })
  assert.equal(result.states.accessibility, 'denied')
  assert.deepEqual(result.missing, ['accessibility'])
  assert.deepEqual(result.unknown, [])
})

test('认不出的 JSON 形状退回文本解析，而不是当成「没有权限」', async () => {
  const text = [
    'Source: local runtime (selected)',
    'Screen Recording (Required): Granted',
    'Accessibility (Required): Granted',
    'Event Synthesizing (Optional): Granted',
  ].join('\n')
  const result = await probePermissions({ proc: procReturning(text), settings, env: envFor })
  assert.equal(result.parsedAs, 'text')
  assert.equal(result.states.screenRecording, 'granted')
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.unknown, [])
})

test('完全读不到时是 unknown，绝不能算成「未授予」', async () => {
  const result = await probePermissions({ proc: procReturning(''), settings, env: envFor })
  assert.deepEqual(result.missing, [], 'unknown 不能进 missing')
  assert.deepEqual(result.unknown.sort(), ['accessibility', 'eventSynthesizing', 'screenRecording'])
})

test('buildActions：unknown 报 warn 且措辞是「无法读取」，不是「未授予」', () => {
  const permissions = {
    supported: true,
    missing: [],
    unknown: ['screenRecording', 'accessibility'],
    panels: {
      screenRecording: { label: '屏幕录制', url: 'x-apple.systempreferences:?Privacy_ScreenCapture' },
      accessibility: { label: '辅助功能', url: 'x-apple.systempreferences:?Privacy_Accessibility' },
    },
  }
  const actions = buildActions({ environment: { blockers: [] }, permissions, wiring: { conflicts: [] }, connections: undefined })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].level, 'warn')
  assert.match(actions[0].what, /无法读取/)
  assert.doesNotMatch(actions[0].what, /未授予/)
})

test('buildActions：真正未授予时才报 block「未授予」', () => {
  const permissions = {
    supported: true,
    missing: ['accessibility'],
    unknown: [],
    panels: { accessibility: { label: '辅助功能', url: 'x-apple.systempreferences:?Privacy_Accessibility' } },
  }
  const actions = buildActions({ environment: { blockers: [] }, permissions, wiring: { conflicts: [] }, connections: undefined })
  assert.equal(actions[0].level, 'block')
  assert.match(actions[0].what, /未授予/)
})

test('npx 预热探测：带版本号的包规格也能匹配到缓存目录', async () => {
  const { probeEnvironment } = await import('../src/probes.mjs')
  const probed = []
  const deps = {
    exists: (target) => {
      probed.push(target)
      return target.endsWith('node_modules/@playwright/mcp') || target.endsWith('node_modules/@steipete/peekaboo')
    },
    readdir: async () => ['hash'],
    readFile: async () => { throw new Error('n/a') },
  }
  const env = await probeEnvironment({
    proc: { resolveExecutable: async () => '/fake/bin/npx' },
    packages: { playwright: '@playwright/mcp@latest', peekaboo: '@steipete/peekaboo' },
    env: { platform: 'darwin', home: '/home/x', npxSibling: '/fake/bin/npx' },
    deps,
  })
  assert.ok(probed.some((p) => p.endsWith('node_modules/@playwright/mcp')), '版本号必须被剥掉，否则路径拼不对')
  assert.equal(env.npxCache.cached.playwright, true)
  assert.equal(env.npxCache.cached.peekaboo, true)
})
