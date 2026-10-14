/**
 * 能力包定义 —— 「装什么」的唯一权威。
 *
 * 这里的 argv 必须与 cordis.patch.yml 里声明的 MCP 行保持一致：体检/连接测试
 * 测的就是配置真正会拉起的那条命令。test/ 里有一条一致性断言防止两边漂移。
 */

export const PACKS = Object.freeze([
  Object.freeze({
    id: 'browser',
    label: '浏览器操控',
    serverName: 'playwright',
    packageKey: 'playwright',
    platforms: Object.freeze(['darwin', 'win32', 'linux']),
    requiresPermissions: Object.freeze([]),
    summary: 'Playwright MCP：用无障碍快照 + 稳定 ref 驱动真实浏览器（导航/点击/填表/截图/网络）。',
    args: (packages) => ['-y', packages.playwright],
  }),
  Object.freeze({
    id: 'computer',
    label: '电脑操控',
    serverName: 'peekaboo',
    packageKey: 'peekaboo',
    platforms: Object.freeze(['darwin']),
    requiresPermissions: Object.freeze(['screenRecording', 'accessibility']),
    summary: 'Peekaboo MCP：读写 macOS 无障碍树、截图，并做真实鼠标与键盘操作。',
    args: (packages) => ['-y', packages.peekaboo, 'mcp', '--no-remote', '--allow-foreground'],
  }),
])

/**
 * macOS 隐私面板。
 * `label` 是给人看的中文名；`match` 是 Peekaboo CLI（英文）输出里的行首标签 ——
 * 两者必须分开，否则中文标签匹配不到英文输出。
 * TCC 里没有独立的 Event Synthesizing 开关，它随「辅助功能」派生。
 */
export const MAC_PERMISSIONS = Object.freeze({
  screenRecording: Object.freeze({ label: '屏幕录制', match: 'Screen Recording', panel: 'Privacy_ScreenCapture' }),
  accessibility: Object.freeze({ label: '辅助功能', match: 'Accessibility', panel: 'Privacy_Accessibility' }),
})

/** CLI 里这条不是面板项，只在报告里作为派生能力列出。 */
export const EVENT_SYNTHESIZING_MATCH = 'Event Synthesizing'

/** 「系统设置」对应面板的深链；只打开面板，不改变任何授权。 */
export function settingsUrl(panel) {
  return `x-apple.systempreferences:com.apple.preference.security?${panel}`
}

/** 组装某个能力包真正的启动 argv（npx 绝对路径 + 包规格 + 参数）。 */
export function buildArgv(pack, { npxPath, packages }) {
  return [npxPath, ...pack.args(packages)]
}

export function packById(id) {
  return PACKS.find((pack) => pack.id === id)
}

export function packsForPlatform(platform) {
  return PACKS.filter((pack) => pack.platforms.includes(platform))
}
