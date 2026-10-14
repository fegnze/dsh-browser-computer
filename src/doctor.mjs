/**
 * 编排层：把三项探测和两个能力包拼成一次可读的体检报告。
 *
 * 三个阶段严格分工，副作用逐级递增：
 *   check —— 只读：本地环境 + macOS 权限 + 配置接线冲突。不联网。
 *   test  —— 只读（可能联网拉包）：对每个能力包做真实 MCP 握手并清点工具。
 *   fix   —— 有副作用：预热/安装依赖包；可选打开系统设置面板。**不写 profile 配置。**
 *
 * 依赖（subprocess、文件系统、环境）全部可注入，测试里不需要真跑 npx。
 */
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { homedir, platform as osPlatform } from 'node:os'
import path from 'node:path'

import { createProc } from './proc.mjs'
import { buildArgv, MAC_PERMISSIONS, packsForPlatform, settingsUrl } from './packs.mjs'
import { probeEnvironment, probePermissions, probeWiring } from './probes.mjs'
import { probeMcpServer } from './mcp-probe.mjs'

const DEFAULT_DEPS = { exists: existsSync, readdir, readFile }

function resolveEnv(env) {
  const platform = env.platform ?? osPlatform()
  const home = env.home ?? homedir()
  const dshHome = env.dshHome ?? process.env.DSH_HOME ?? path.join(home, '.dsh')
  return {
    platform,
    home,
    dshHome,
    profile: env.profile ?? process.env.DSH_PROFILE,
    cwd: env.cwd ?? dshHome,
    npxSibling: platform === 'win32'
      ? path.join(path.dirname(process.execPath), 'npx.cmd')
      : path.join(path.dirname(process.execPath), 'npx'),
  }
}

export function createDoctor({ ctx, settings, proc, env = {}, deps = DEFAULT_DEPS, probe = probeMcpServer }) {
  const runtime = proc ?? createProc(ctx)
  const context = resolveEnv(env)
  let npxPathCache

  async function npxPath() {
    if (npxPathCache !== undefined) return npxPathCache
    let resolved
    try {
      resolved = await runtime.resolveExecutable?.('npx')
    } catch {
      resolved = undefined
    }
    npxPathCache = typeof resolved === 'string' && resolved
      ? resolved
      : context.npxSibling && deps.exists(context.npxSibling)
        ? context.npxSibling
        : undefined
    return npxPathCache
  }

  async function check() {
    const npx = await npxPath()
    const environment = await probeEnvironment({
      proc: runtime,
      packages: settings.packages,
      env: { ...context, npxPath: npx },
      deps,
    })
    const permissions = await probePermissions({
      proc: runtime,
      settings,
      env: { ...context, npxPath: npx },
    })
    const wiring = await probeWiring({ env: context, deps })
    const packs = packSummaries(permissions)

    return {
      stage: 'check',
      generatedAt: new Date().toISOString(),
      platform: context.platform,
      environment,
      permissions,
      wiring,
      packs,
      actions: buildActions({ environment, permissions, wiring, connections: undefined }),
    }
  }

  /** 每个能力包起一次真实 MCP 握手。test 与 repair 共用，避免两处各写一遍。 */
  async function probeConnections(npx) {
    const targets = packsForPlatform(context.platform)
    if (!npx) {
      return targets.map((pack) => ({
        id: pack.id, label: pack.label, ok: false, phase: 'preflight',
        error: '找不到 npx，无法拉起 MCP server',
      }))
    }
    const connections = []
    for (const pack of targets) {
      const argv = buildArgv(pack, { npxPath: npx, packages: settings.packages })
      const result = await probe({ proc: runtime, argv, cwd: context.cwd, timeoutMs: settings.probeTimeoutMs })
      connections.push({
        id: pack.id,
        label: pack.label,
        serverName: pack.serverName,
        ok: result.ok,
        phase: result.phase,
        error: result.error,
        serverVersion: result.serverVersion,
        protocolVersion: result.protocolVersion,
        toolCount: result.toolCount,
        tools: result.tools,
        toolsTruncated: result.toolsTruncated,
        elapsedMs: result.elapsedMs,
        stderrTail: result.stderrTail,
      })
    }
    return connections
  }

  /** 能力包摘要（未做连接测试时用）。 */
  function packSummaries(permissions) {
    return packsForPlatform(context.platform).map((pack) => ({
      id: pack.id,
      label: pack.label,
      serverName: pack.serverName,
      summary: pack.summary,
      supported: true,
      missingPermissions: permissions?.states
        ? pack.requiresPermissions.filter((key) => permissions.states[key] !== 'granted')
        : [],
    }))
  }

  async function test() {
    const base = await check()
    const connections = await probeConnections(await npxPath())

    return {
      ...base,
      stage: 'test',
      connections,
      actions: buildActions({ environment: base.environment, permissions: base.permissions, wiring: base.wiring, connections }),
    }
  }

  /**
   * 一键修复：查环境 → 只装缺的依赖 → 查授权 → 需要授权就打开对应面板 →（可选）验证连接。
   *
   * 幂等且克制：
   *   - 已缓存的依赖包不重复拉（除非 force）
   *   - 三项授权都 granted 时不动系统设置
   *   - 任何一步失败都如实记在 steps 里，绝不假装成功
   */
  async function repair({ openSettings = true, verify = false, force = false, signal } = {}) {
    const startedAt = Date.now()
    const steps = []
    const aborted = () => signal?.aborted === true

    const npx = await npxPath()
    const environment = await probeEnvironment({
      proc: runtime,
      packages: settings.packages,
      env: { ...context, npxPath: npx },
      deps,
    })
    steps.push({
      step: 'environment',
      ok: Boolean(npx) && environment.blockers.length === 0,
      detail: npx ? `npx ${npx}` : '找不到 npx',
    })

    // 依赖：只拉缺的
    const installed = []
    if (npx) {
      for (const pack of packsForPlatform(context.platform)) {
        if (aborted()) break
        const spec = settings.packages[pack.packageKey]
        const alreadyCached = environment.npxCache?.cached?.[pack.packageKey] === true
        if (alreadyCached && !force) {
          installed.push({ id: pack.id, label: pack.label, package: spec, ok: true, skipped: true })
          continue
        }
        const result = await runtime.run({
          argv: [npx, '-y', spec, '--version'],
          cwd: context.cwd,
          timeoutMs: settings.probeTimeoutMs,
        })
        installed.push({
          id: pack.id,
          label: pack.label,
          package: spec,
          ok: result.ok,
          skipped: false,
          version: result.ok ? result.stdout.trim().split('\n')[0] : undefined,
          timedOut: result.timedOut,
          error: result.ok
            ? undefined
            : result.timedOut
              ? '拉包超时（首次下载可能较慢，重试即可）'
              : result.spawnError ?? (runtime.stderrTail?.(result.stderr).join(' | ') || `退出码 ${result.exitCode}`),
        })
      }
    }
    steps.push({
      step: 'dependencies',
      ok: installed.length > 0 && installed.every((item) => item.ok),
      detail: installed.map((item) => `${item.label}${item.skipped ? '(已缓存)' : item.ok ? '(已就绪)' : '(失败)'}`).join('、'),
    })

    // 授权
    const permissions = await probePermissions({ proc: runtime, settings, env: { ...context, npxPath: npx } })
    steps.push({
      step: 'permissions',
      ok: (permissions.missing ?? []).length === 0,
      detail: permissions.missing?.length
        ? `未授予：${permissions.missing.join('、')}`
        : (permissions.unknown ?? []).length ? `读不到：${permissions.unknown.join('、')}` : '三项均已授予',
    })

    const settingsOpened = []
    const needPanels = [...new Set([...(permissions.missing ?? []), ...(permissions.unknown ?? [])])]
    if (openSettings && settings.allowOpenSettings && context.platform === 'darwin' && needPanels.length && !aborted()) {
      for (const key of needPanels) {
        const meta = MAC_PERMISSIONS[key]
        const url = permissions.panels?.[key]?.url ?? (meta ? settingsUrl(meta.panel) : undefined)
        if (!url) continue
        const result = await runtime.run({ argv: ['/usr/bin/open', url], cwd: context.cwd, timeoutMs: 15000 })
        settingsOpened.push({ key, label: permissions.panels?.[key]?.label ?? meta?.label ?? key, url, ok: result.ok })
      }
    }
    steps.push({
      step: 'authorization',
      ok: needPanels.length === 0,
      detail: needPanels.length
        ? (settingsOpened.length ? `已打开 ${settingsOpened.length} 个系统设置面板` : '需要在系统设置里授权')
        : '无需处理',
    })

    let connections
    if (verify && !aborted()) {
      connections = await probeConnections(npx)
      steps.push({
        step: 'connection',
        ok: connections.every((item) => item.ok),
        detail: connections.map((item) => `${item.label}${item.ok ? `(${item.toolCount} 个工具)` : '(未通过)'}`).join('、'),
      })
    }

    const wiring = await probeWiring({ env: context, deps })
    const ok = steps.every((item) => item.ok)

    return {
      stage: 'repair',
      ok,
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      steps,
      environment,
      permissions,
      wiring,
      packs: packSummaries(permissions),
      installed,
      settingsOpened,
      connections,
      actions: buildActions({ environment, permissions, wiring, connections }),
    }
  }

  async function fix({ openSettings = false, only } = {}) {
    const npx = await npxPath()
    if (!npx) {
      return { stage: 'fix', ok: false, error: '找不到 npx，无法预热依赖包', installed: [], settingsOpened: [] }
    }

    const targets = packsForPlatform(context.platform).filter((pack) => !only || pack.id === only)
    const installed = []
    for (const pack of targets) {
      // 预热 = 用 --version 触发一次 npx 解析/下载；不启动 MCP 会话。
      const argv = [npx, '-y', settings.packages[pack.packageKey], '--version']
      const result = await runtime.run({ argv, cwd: context.cwd, timeoutMs: settings.probeTimeoutMs })
      installed.push({
        id: pack.id,
        label: pack.label,
        package: settings.packages[pack.packageKey],
        ok: result.ok,
        version: result.ok ? result.stdout.trim().split('\n')[0] : undefined,
        timedOut: result.timedOut,
        error: result.ok
          ? undefined
          : result.timedOut
            ? '拉包超时（首次下载可能较慢，重试即可）'
            : result.spawnError ?? (runtime.stderrTail?.(result.stderr).join(' | ') || `退出码 ${result.exitCode}`),
      })
    }

    const settingsOpened = []
    if (openSettings && settings.allowOpenSettings && context.platform === 'darwin') {
      const permissions = await probePermissions({ proc: runtime, settings, env: { ...context, npxPath: npx } })
      for (const key of permissions.missing ?? []) {
        const url = permissions.panels?.[key]?.url
        if (!url) continue
        const opened = await runtime.run({ argv: ['/usr/bin/open', url], cwd: context.cwd, timeoutMs: 15000 })
        settingsOpened.push({ key, label: permissions.panels[key].label, url, ok: opened.ok })
      }
    }

    return {
      stage: 'fix',
      ok: installed.every((entry) => entry.ok),
      installed,
      settingsOpened,
      note: openSettings && !settings.allowOpenSettings
        ? '配置里 allowOpenSettings=false，未打开系统设置面板'
        : undefined,
    }
  }

  /**
   * 只做「引导」：打开需要确认的权限对应的系统设置面板，不装依赖、不改授权。
   * 目标是 missing（确定未授予）∪ unknown（读不到，交给你自己看），去重后逐个打开。
   */
  async function openSettingsPanels() {
    if (context.platform !== 'darwin') {
      return { opened: [], targets: [], note: `电脑操控仅支持 macOS（当前 ${context.platform}）` }
    }
    if (!settings.allowOpenSettings) {
      return { opened: [], targets: [], note: '配置里 allowOpenSettings=false，未打开任何面板' }
    }

    let targets = []
    let panels = {}
    let readFailed = false
    try {
      const permissions = await probePermissions({
        proc: runtime,
        settings,
        env: { ...context, npxPath: await npxPath() },
      })
      panels = permissions.panels ?? {}
      targets = [...new Set([...(permissions.missing ?? []), ...(permissions.unknown ?? [])])]
      readFailed = !permissions.ok
      if (readFailed) targets = Object.keys(MAC_PERMISSIONS)
    } catch {
      readFailed = true
      targets = Object.keys(MAC_PERMISSIONS)
    }
    if (!targets.length) {
      return { opened: [], targets: [], note: '三项授权均已就绪，无需打开系统设置' }
    }

    const opened = []
    for (const key of targets) {
      const meta = MAC_PERMISSIONS[key]
      const url = panels[key]?.url ?? (meta ? settingsUrl(meta.panel) : undefined)
      if (!url) continue
      const result = await runtime.run({ argv: ['/usr/bin/open', url], cwd: context.cwd, timeoutMs: 15000 })
      opened.push({ key, label: panels[key]?.label ?? meta?.label ?? key, url, ok: result.ok })
    }
    return {
      opened,
      targets,
      note: readFailed
        ? '读不到权限状态，已把相关面板都打开供你确认；改动授权后需完整重启 DSH App'
        : '已打开面板；授权后需完整重启 DSH App 才会生效',
    }
  }

  return {
    check,
    test,
    run: test,
    fix,
    repair,
    openSettingsPanels,
    resolveEnv: () => ({ ...context }),
  }
}

export function buildActions({ environment, permissions, wiring, connections }) {
  const actions = []

  for (const blocker of environment?.blockers ?? []) {
    actions.push({ level: 'block', what: blocker })
  }

  if (permissions?.supported && (permissions.missing ?? []).length) {
    const labels = permissions.missing
      .map((key) => permissions.panels?.[key]?.label ?? key)
      .join('、')
    actions.push({
      level: 'block',
      what: `macOS 权限未授予：${labels}`,
      how: '系统设置 → 隐私与安全性；授予后重启 DSH App（TCC 变更对已运行进程不一定立即生效）',
      panels: permissions.missing.map((key) => permissions.panels?.[key]).filter(Boolean),
    })
  } else if (permissions?.supported && (permissions.unknown ?? []).length) {
    // 读不到 ≠ 没授权。这里必须如实说「读不到」，不能替用户下结论。
    const labels = permissions.unknown
      .map((key) => permissions.panels?.[key]?.label ?? key)
      .join('、')
    actions.push({
      level: 'warn',
      what: `无法读取 macOS 权限状态：${labels}`,
      how: '这不代表未授予；可用「电脑授权引导」打开系统设置自行确认',
      panels: permissions.unknown.map((key) => permissions.panels?.[key]).filter(Boolean),
    })
  }

  for (const conflict of wiring?.conflicts ?? []) {
    actions.push({ level: 'warn', what: conflict.message })
  }

  for (const connection of connections ?? []) {
    if (connection.ok) continue
    actions.push({
      level: 'warn',
      what: `${connection.label} 连接未通过${connection.error ? `：${connection.error}` : ''}`,
      how: '先跑 fix 预热依赖包，再重跑 test；仍失败就看 stderrTail',
    })
  }

  if (!actions.length) {
    actions.push({
      level: 'ok',
      what: connections?.length
        ? '环境、权限、连接三项均通过，能力已可用'
        : '环境与权限检查通过；尚未做连接测试（跑 test 验证 MCP 真的能起来）',
    })
  }

  return actions
}
