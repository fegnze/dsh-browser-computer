import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeConfig } from '../src/config.mjs'
import { createDoctor } from '../src/doctor.mjs'
import { summarize } from '../src/tools.mjs'
import { buildArgv, PACKS } from '../src/packs.mjs'

/**
 * Peekaboo 的真实输出形状（2026-10-14 抓取）：权限名在 value 的 `name` 字段里。
 * 早先这里用的是「按 key 索引」的假形状，正好掩盖了解析 bug —— 夹具必须跟真实输出一致。
 */
const permissionJson = ({ screenRecording = true, accessibility = true, eventSynthesizing = true } = {}) =>
  JSON.stringify({
    debug_logs: ['[DEBUG] Runtime host: local (in-process)'],
    data: {
      permissions: [
        { name: 'Screen Recording', isRequired: true, isGranted: screenRecording, grantInstructions: 'System Settings > Privacy & Security > Screen Recording' },
        { name: 'Accessibility', isRequired: true, isGranted: accessibility, grantInstructions: 'System Settings > Privacy & Security > Accessibility' },
        { name: 'Event Synthesizing', isRequired: false, isGranted: eventSynthesizing, grantInstructions: 'System Settings > Privacy & Security > Accessibility' },
      ],
    },
  })

const GRANTED = permissionJson()
const DENIED = permissionJson({ accessibility: false })

function fakeProc({ permissionStdout = GRANTED, runOk = true, npx = '/fake/bin/npx' } = {}) {
  const calls = []
  return {
    calls,
    resolveExecutable: async (name) => (npx && name === 'npx' ? npx : undefined),
    stderrTail: (text) => String(text || '').split('\n').filter(Boolean).slice(-4),
    run: async ({ argv }) => {
      calls.push(argv)
      if (argv.includes('permissions')) {
        return { ok: true, stdout: permissionStdout, stderr: '', exitCode: 0, signal: null, truncated: false, timedOut: false }
      }
      return {
        ok: runOk,
        stdout: runOk ? '4.9.2\n' : '',
        stderr: runOk ? '' : 'npx failed',
        exitCode: runOk ? 0 : 1,
        signal: null,
        truncated: false,
        timedOut: false,
      }
    },
    spawnPipe: () => {
      throw new Error('check/fix 阶段不应起长驻子进程')
    },
  }
}

const depsWith = ({ patchText, chrome = true } = {}) => ({
  exists: (target) => (chrome && String(target).includes('Google Chrome')) || target === '/fake/bin/npx',
  readdir: async (dir) => {
    if (String(dir).includes('ms-playwright')) return ['chromium-1248', 'ffmpeg-1013']
    if (String(dir).includes('_npx')) return []
    throw new Error('ENOENT')
  },
  readFile: async () => {
    if (patchText === undefined) throw new Error('ENOENT')
    return patchText
  },
})

const doctorFor = (options = {}) =>
  createDoctor({
    settings: normalizeConfig({}),
    proc: options.proc ?? fakeProc(options.procOptions),
    env: { platform: 'darwin', home: '/fake/home', dshHome: '/fake/.dsh', profile: 'desktop', ...options.env },
    deps: options.deps ?? depsWith(options.depsOptions),
    probe: options.probe,
  })

test('check：环境与权限都通过时给出可执行的下一步', async () => {
  const report = await doctorFor().check()
  assert.equal(report.stage, 'check')
  assert.deepEqual(report.environment.blockers, [])
  assert.equal(report.environment.npx.path, '/fake/bin/npx')
  assert.equal(report.environment.browsers.any, true)
  assert.equal(report.permissions.missing.length, 0)
  assert.equal(report.actions.length, 1)
  assert.equal(report.actions[0].level, 'ok')
  assert.match(report.actions[0].what, /尚未做连接测试/)
})

test('check：权限缺失时给出 block 项与系统设置深链', async () => {
  const report = await doctorFor({ procOptions: { permissionStdout: DENIED } }).check()
  assert.deepEqual(report.permissions.missing.sort(), ['accessibility'])
  const blocked = report.actions.find((action) => action.level === 'block')
  assert.ok(blocked, '应有 block 级动作')
  assert.match(blocked.what, /辅助功能/)
  assert.equal(blocked.panels[0].url, 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
})

test('check：profile patch 里重复的 MCP 行会被点出来', async () => {
  const report = await doctorFor({
    depsOptions: { patchText: ['- insert:', '    - id: playwright-mcp', "      config:", "        serverName: playwright"].join('\n') },
  }).check()
  assert.equal(report.wiring.checked, true)
  assert.equal(report.wiring.conflicts.length, 1)
  assert.equal(report.wiring.conflicts[0].serverName, 'playwright')
  assert.ok(report.actions.some((action) => action.level === 'warn' && /重复/.test(action.what)))
})

test('check：确定性的文本权限输出也能解析', async () => {
  const text = [
    'Source: local runtime (selected)',
    'Screen Recording (Required): Granted',
    'Accessibility (Required): Not Granted',
    'Event Synthesizing (Optional): Not Granted',
  ].join('\n')
  const report = await doctorFor({ procOptions: { permissionStdout: text } }).check()
  assert.equal(report.permissions.parsedAs, 'text')
  assert.equal(report.permissions.states.screenRecording, 'granted')
  assert.equal(report.permissions.states.accessibility, 'denied')
  assert.deepEqual(report.permissions.missing, ['accessibility'])
})

test('test：连接探测逐个能力包执行并汇总', async () => {
  const seen = []
  const report = await doctorFor({
    probe: async ({ argv }) => {
      seen.push(argv)
      return { ok: true, phase: 'ready', serverName: 'x', serverVersion: '1.2.3', toolCount: 7, tools: ['a'], elapsedMs: 12 }
    },
  }).test()
  assert.equal(report.stage, 'test')
  assert.equal(seen.length, PACKS.length)
  assert.equal(report.connections.length, PACKS.length)
  assert.ok(report.connections.every((item) => item.ok && item.toolCount === 7))
  assert.equal(report.actions[0].level, 'ok')
})

test('test：找不到 npx 时不做无意义的握手', async () => {
  let probeCalled = false
  const report = await doctorFor({
    // 用 null 而不是 undefined：解构默认值对 undefined 生效，会让假 proc 又"有" npx。
    procOptions: { npx: null },
    probe: async () => {
      probeCalled = true
      return { ok: true }
    },
  }).test()
  assert.equal(probeCalled, false)
  assert.ok(report.connections.every((item) => item.ok === false && item.phase === 'preflight'))
  assert.ok(report.actions.some((action) => action.level === 'block'))
})

test('test：连接失败时给出修复顺序而不是只报错', async () => {
  const report = await doctorFor({
    probe: async () => ({ ok: false, phase: 'handshake', error: 'npx 拉包失败', elapsedMs: 5 }),
  }).test()
  const warn = report.actions.find((action) => action.level === 'warn' && /连接未通过/.test(action.what))
  assert.ok(warn)
  assert.match(warn.how, /fix/)
})

test('fix：预热依赖走 --version，且默认不动系统设置', async () => {
  const proc = fakeProc()
  const report = await doctorFor({ proc }).fix()
  assert.equal(report.ok, true)
  assert.equal(report.installed.length, PACKS.length)
  assert.ok(report.installed.every((item) => item.ok && item.version === '4.9.2'))
  assert.deepEqual(report.settingsOpened, [])
  const versionCalls = proc.calls.filter((argv) => argv.includes('--version'))
  assert.equal(versionCalls.length, PACKS.length)
  assert.ok(versionCalls.every((argv) => argv[2] && !argv.includes('mcp')))
})

test('fix：显式 openSettings 时只打开缺失权限对应的面板', async () => {
  const proc = fakeProc({ permissionStdout: DENIED })
  const report = await doctorFor({ proc }).fix({ openSettings: true })
  assert.equal(report.settingsOpened.length, 1)
  assert.equal(report.settingsOpened[0].key, 'accessibility')
  assert.ok(proc.calls.some((argv) => argv[0] === '/usr/bin/open'))
})

test('fix：allowOpenSettings=false 时不开面板并说明原因', async () => {
  const proc = fakeProc({ permissionStdout: DENIED })
  const doctor = createDoctor({
    settings: normalizeConfig({ allowOpenSettings: false }),
    proc,
    env: { platform: 'darwin', home: '/fake/home', dshHome: '/fake/.dsh', profile: 'desktop' },
    deps: depsWith(),
  })
  const report = await doctor.fix({ openSettings: true })
  assert.deepEqual(report.settingsOpened, [])
  assert.match(report.note, /allowOpenSettings=false/)
})

test('fix：拉包失败时如实标注错误，不伪装成功', async () => {
  const report = await doctorFor({ procOptions: { runOk: false } }).fix()
  assert.equal(report.ok, false)
  assert.ok(report.installed.every((item) => item.ok === false))
  assert.match(report.installed[0].error, /npx failed/)
})

test('argv 组装与能力包声明一致', () => {
  const packages = normalizeConfig({}).packages
  const browser = buildArgv(PACKS[0], { npxPath: '/fake/bin/npx', packages })
  const computer = buildArgv(PACKS[1], { npxPath: '/fake/bin/npx', packages })
  assert.deepEqual(browser, ['/fake/bin/npx', '-y', '@playwright/mcp@latest'])
  assert.deepEqual(computer, [
    '/fake/bin/npx', '-y', '@steipete/peekaboo', 'mcp', '--no-remote', '--allow-foreground',
  ])
})

test('summarize 输出人可读摘要且不含 JSON 噪声', async () => {
  const report = await doctorFor({
    probe: async () => ({ ok: true, serverName: 'x', serverVersion: '1.0.0', toolCount: 25, tools: [], elapsedMs: 900 }),
  }).test()
  const text = summarize(report)
  assert.match(text, /浏览器与电脑操控/)
  assert.match(text, /✓ 浏览器操控/)
  assert.match(text, /25 个工具/)
  assert.doesNotMatch(text, /"stage"/)
})
