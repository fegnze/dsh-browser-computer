/**
 * 三项只读探测：本地环境、macOS 权限、配置接线冲突。
 *
 * 全部只读：不装包、不改授权、不写 profile。需要联网或需要动手的步骤在 doctor 的
 * fix / test 阶段，与这里分开。
 *
 * 文件系统访问走可注入的 deps，测试里给假实现即可不碰真实磁盘。
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, platform as osPlatform, release as osRelease } from 'node:os'
import path from 'node:path'

import { EVENT_SYNTHESIZING_MATCH, MAC_PERMISSIONS, PACKS, settingsUrl } from './packs.mjs'

const BROWSER_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
}

const defaultDeps = { exists: existsSync, readdir, readFile }

/** npx 解析：先问 provider，再退回「与 node 同目录」。 */
async function resolveNpx(proc, npxSibling, deps) {
  try {
    const resolved = await proc.resolveExecutable?.('npx')
    if (typeof resolved === 'string' && resolved) {
      return { path: resolved, via: 'subprocess.resolveExecutable' }
    }
  } catch {
    /* provider 解析失败，继续退回 */
  }
  if (npxSibling && deps.exists(npxSibling)) return { path: npxSibling, via: 'node-sibling' }
  return { path: undefined, via: undefined }
}

/** 浏览器二进制：只看存在性，不启动、不联网。 */
function probeBrowsers(platform, deps) {
  const candidates = BROWSER_CANDIDATES[platform] ?? []
  const found = candidates.filter((candidate) => deps.exists(candidate))
  return { candidates: candidates.length, found, any: found.length > 0 }
}

/** Playwright 自己的浏览器缓存（Chrome 之外的第二条路）。 */
async function probePlaywrightCache(home, deps) {
  const directories = [
    path.join(home, 'Library', 'Caches', 'ms-playwright'),
    path.join(home, '.cache', 'ms-playwright'),
  ]
  for (const directory of directories) {
    try {
      const entries = await deps.readdir(directory)
      if (entries.length) {
        return { dir: directory, chromium: entries.filter((entry) => entry.startsWith('chromium')), any: true }
      }
    } catch {
      /* 该平台没有这个目录 */
    }
  }
  return { dir: undefined, chromium: [], any: false }
}

/** npx 缓存里是否已有某个包 —— 只说明「拉过」，不说明「能用」。 */
async function probeNpxCache(home, packages, deps) {
  const root = path.join(home, '.npm', '_npx')
  const wanted = {
    playwright: stripVersion(packages.playwright),
    peekaboo: stripVersion(packages.peekaboo),
  }
  const cached = { playwright: false, peekaboo: false }
  let entries = []
  try {
    entries = await deps.readdir(root)
  } catch {
    return { root, cached, scanned: 0 }
  }
  for (const entry of entries) {
    for (const [key, pkg] of Object.entries(wanted)) {
      if (cached[key] || !pkg) continue
      if (deps.exists(path.join(root, entry, 'node_modules', ...pkg.split('/')))) cached[key] = true
    }
  }
  return { root, cached, scanned: entries.length }
}

/** `@scope/name@latest` → `@scope/name`；`name@1.2.3` → `name`。 */
/** `@scope/name@latest` → `@scope/name`；`name@1.2.3` → `name`；无版本则原样返回。
 *  注意是连版本一起删掉：早先写成 `/@(?=…)/` 只删了 `@`，`@playwright/mcp@latest`
 *  会变成 `@playwright/mcplatest`，导致预热状态永远漏报。 */
function stripVersion(spec) {
  return String(spec ?? '').replace(/@[^@/]*$/, '')
}

export async function probeEnvironment({ proc, packages, env = {}, deps = defaultDeps }) {
  const platform = env.platform ?? osPlatform()
  const home = env.home ?? homedir()
  const npxSibling = env.npxSibling
    ?? (platform === 'win32'
      ? path.join(path.dirname(process.execPath), 'npx.cmd')
      : path.join(path.dirname(process.execPath), 'npx'))

  const npx = await resolveNpx(proc, npxSibling, deps)
  const browsers = probeBrowsers(platform, deps)
  const playwrightCache = await probePlaywrightCache(home, deps)
  const npxCache = await probeNpxCache(home, packages, deps)

  const blockers = []
  if (!npx.path) {
    blockers.push('找不到 npx：MCP 行无法启动（需要 Node 自带的 npx 在 PATH 或与 node 同目录）')
  }
  if (!browsers.any && !playwrightCache.any) {
    blockers.push('本机没有 Chrome/Edge/Chromium，也没有 Playwright 浏览器缓存：浏览器能力需要先下载浏览器')
  }

  return {
    platform,
    osRelease: osRelease(),
    node: { version: process.version, execPath: process.execPath },
    npx,
    browsers,
    playwrightCache,
    npxCache,
    blockers,
  }
}

const STATE_MAP = { granted: 'granted', 'not granted': 'denied', denied: 'denied', unknown: 'unknown' }

function parsePermissionText(text) {
  const read = (matchLabel) => {
    const match = new RegExp(`${matchLabel}[^:\\n]*:\\s*(Granted|Not Granted|Unknown|Denied)`, 'i').exec(text)
    return match ? STATE_MAP[match[1].toLowerCase()] ?? 'unknown' : 'unknown'
  }
  return {
    screenRecording: read(MAC_PERMISSIONS.screenRecording.match),
    accessibility: read(MAC_PERMISSIONS.accessibility.match),
    eventSynthesizing: read(EVENT_SYNTHESIZING_MATCH),
    source: /^Source:\s*(.+)$/m.exec(text)?.[1]?.trim(),
  }
}

/**
 * Peekaboo `permissions status --json` 的真实形状：
 *
 *   { "data": { "permissions": [
 *       { "name": "Screen Recording", "isRequired": true, "isGranted": true,
 *         "grantInstructions": "System Settings > …" }, … ] } }
 *
 * 关键：权限名在 **value** 的 `name` 字段里，不是对象 key。早先按「找名字像
 * screenRecording 的 key」来解析，永远匹配不到，于是三项全 unknown —— 而
 * unknown 又被当成「未授予」上报，直接假报。
 */
const normalizeName = (name) => String(name).toLowerCase().replace(/[^a-z]/g, '')

function parsePermissionJson(value) {
  const entries = []
  const collect = (node, depth) => {
    if (depth > 6 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) collect(item, depth + 1)
      return
    }
    if (typeof node.name === 'string' && (typeof node.isGranted === 'boolean' || typeof node.granted === 'boolean')) {
      entries.push({ name: node.name, granted: node.isGranted ?? node.granted })
    }
    for (const child of Object.values(node)) collect(child, depth + 1)
  }
  collect(value, 0)

  const read = (needle) => {
    const hit = entries.find((entry) => normalizeName(entry.name).includes(needle))
    if (!hit) return 'unknown'
    return hit.granted ? 'granted' : 'denied'
  }
  return {
    screenRecording: read('screenrecording'),
    accessibility: read('accessibility'),
    eventSynthesizing: read('eventsynthesizing'),
    source: typeof value?.data?.source === 'string' ? value.data.source : undefined,
  }
}

const PERMISSION_KEYS = ['screenRecording', 'accessibility', 'eventSynthesizing']
/**
 * 只有这两项是「去系统设置勾一下」就能解决的必要授权。
 * Event Synthesizing 是**派生能力**：TCC 里没有它的独立开关，随「辅助功能」走。
 * 把它算成一条待办会让人去系统设置里找一个不存在的东西，所以只报状态、不报待办。
 */
const REQUIRED_KEYS = ['screenRecording', 'accessibility']
const anyKnown = (states) => PERMISSION_KEYS.some((key) => states[key] !== 'unknown')

/**
 * macOS 权限读取。走 Peekaboo CLI 的 `--no-remote` 分支：状态归属于本机执行环境
 * （也就是 DSH App 这条进程链），而不是 Peekaboo Bridge —— 后者是另一套授权，
 * 而且会顺带起一个常驻进程。
 */
export async function probePermissions({ proc, settings, env = {} }) {
  const platform = env.platform ?? osPlatform()
  if (platform !== 'darwin') {
    return {
      supported: false,
      reason: `电脑操控能力仅支持 macOS（当前 ${platform}）`,
      states: {},
      missing: [],
      unknown: [],
      canOpenSettings: false,
    }
  }

  const npxPath = env.npxPath
    ?? (await resolveNpx(proc, path.join(path.dirname(process.execPath), 'npx'), defaultDeps)).path
  if (!npxPath) {
    return {
      supported: true,
      ok: false,
      reason: '找不到 npx，无法读取权限状态',
      states: {},
      missing: [],
      unknown: [...PERMISSION_KEYS],
      canOpenSettings: false,
    }
  }

  const argv = [npxPath, '-y', settings.packages.peekaboo, 'permissions', 'status', '--json', '--no-remote']
  const result = await proc.run({ argv, cwd: env.cwd, timeoutMs: settings.probeTimeoutMs })

  let states
  let parsedAs = 'text'
  try {
    const fromJson = parsePermissionJson(JSON.parse(result.stdout))
    // 形状不认得就退回文本解析，别把「没认出来」当成「没有权限」。
    if (!anyKnown(fromJson)) throw new Error('无法识别的 JSON 形状')
    states = fromJson
    parsedAs = 'json'
  } catch {
    states = parsePermissionText(result.stdout || result.stderr || '')
  }

  // 严格区分三种状态：granted / denied / unknown。
  // unknown 只说明读不到，**不能**当成未授予上报。
  const missing = REQUIRED_KEYS.filter((key) => states[key] === 'denied')
  const unknown = PERMISSION_KEYS.filter((key) => states[key] === 'unknown')
  return {
    supported: true,
    ok: !result.timedOut && !result.spawnError,
    parsedAs,
    reason: result.timedOut
      ? '读取权限超时'
      : result.spawnError
        ? `无法启动 Peekaboo：${result.spawnError}`
        : undefined,
    source: states.source,
    states,
    missing,
    unknown,
    // TCC 变更对已在运行的进程不一定立即生效；授予后需重启 App。
    needsAppRestart: missing.length > 0,
    panels: Object.fromEntries(
      Object.entries(MAC_PERMISSIONS).map(([key, meta]) => [key, { label: meta.label, url: settingsUrl(meta.panel) }]),
    ),
    canOpenSettings: settings.allowOpenSettings,
    stderrTail: proc.stderrTail?.(result.stderr) ?? [],
  }
}

/**
 * 接线冲突检测：如果 profile 的 patch 层里也有一条同 serverName 的 MCP 行，它会和
 * 插件声明的这条撞成两个实例（工具重名）。这里只报告，不自动改配置 —— profile
 * 配置的唯一写入者是官方插件管理器。
 */
export async function probeWiring({ env = {}, deps = defaultDeps } = {}) {
  const home = env.home ?? homedir()
  const dshHome = env.dshHome ?? process.env.DSH_HOME ?? path.join(home, '.dsh')
  const profile = env.profile ?? process.env.DSH_PROFILE
  if (!profile) {
    return { checked: false, reason: 'DSH_PROFILE 未设置，跳过 profile patch 检查', conflicts: [] }
  }
  const patchPath = path.join(dshHome, 'profiles', profile, 'cordis.patch.yml')
  let text
  try {
    text = await deps.readFile(patchPath, 'utf8')
  } catch (error) {
    return {
      checked: false,
      profile,
      patchPath,
      reason: `读不到 profile patch：${error instanceof Error ? error.message : String(error)}`,
      conflicts: [],
    }
  }

  const conflicts = []
  for (const pack of PACKS) {
    const pattern = new RegExp(`serverName:\\s*['"]?${pack.serverName}['"]?`)
    if (pattern.test(text)) {
      conflicts.push({
        pack: pack.id,
        serverName: pack.serverName,
        message: `profile patch 里还有一条 serverName: ${pack.serverName} 的 MCP 行，与本插件声明的那条重复，会产生两个 MCP 实例、工具重名。删掉手动那条。`,
      })
    }
  }
  return { checked: true, profile, patchPath, conflicts, ok: conflicts.length === 0 }
}
