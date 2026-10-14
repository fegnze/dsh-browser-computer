/**
 * 配置归一化与校验。
 *
 * Config 走 cordis 的 standard-schema 形状（与工作区内既有插件一致）：
 * 导出 `Config['~standard'].validate`，坏值返回 issues 而不是抛错。
 */

export const DEFAULT_CONFIG = Object.freeze({
  /** 单次子进程探测的上限，包含 npx 首次拉包。 */
  probeTimeoutMs: 90000,
  /** 体检时是否允许打开「系统设置」对应面板。只打开面板，不改变任何授权。 */
  allowOpenSettings: true,
  /** 插件激活时自动跑一遍「查环境 → 装缺的依赖 → 查授权 → 需要就打开授权面板」。幂等。 */
  autoRepairOnStart: true,
  packages: Object.freeze({
    playwright: '@playwright/mcp@latest',
    peekaboo: '@steipete/peekaboo',
  }),
})

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 解析原始 config；未知字段忽略，缺省项补齐。永不抛错。 */
export function normalizeConfig(raw) {
  const source = isRecord(raw) ? raw : {}
  const packages = isRecord(source.packages) ? source.packages : {}
  const timeout = Number(source.probeTimeoutMs)
  return {
    probeTimeoutMs:
      Number.isFinite(timeout) && timeout >= 5000 && timeout <= 600000
        ? Math.trunc(timeout)
        : DEFAULT_CONFIG.probeTimeoutMs,
    allowOpenSettings: source.allowOpenSettings !== false,
    autoRepairOnStart: source.autoRepairOnStart !== false,
    packages: {
      playwright:
        typeof packages.playwright === 'string' && packages.playwright.trim()
          ? packages.playwright.trim()
          : DEFAULT_CONFIG.packages.playwright,
      peekaboo:
        typeof packages.peekaboo === 'string' && packages.peekaboo.trim()
          ? packages.peekaboo.trim()
          : DEFAULT_CONFIG.packages.peekaboo,
    },
  }
}

function validate(value) {
  if (value === undefined || value === null) return { value: {} }
  if (!isRecord(value)) return { issues: [{ message: 'browser-computer config 必须是对象' }] }

  const issues = []
  if (value.probeTimeoutMs !== undefined) {
    const timeout = Number(value.probeTimeoutMs)
    if (!Number.isFinite(timeout) || timeout < 5000 || timeout > 600000) {
      issues.push({ message: 'probeTimeoutMs 需为 5000..600000 的数字', path: ['probeTimeoutMs'] })
    }
  }
  if (value.allowOpenSettings !== undefined && typeof value.allowOpenSettings !== 'boolean') {
    issues.push({ message: 'allowOpenSettings 需为布尔值', path: ['allowOpenSettings'] })
  }
  if (value.autoRepairOnStart !== undefined && typeof value.autoRepairOnStart !== 'boolean') {
    issues.push({ message: 'autoRepairOnStart 需为布尔值', path: ['autoRepairOnStart'] })
  }
  if (value.packages !== undefined) {
    if (!isRecord(value.packages)) {
      issues.push({ message: 'packages 需为对象', path: ['packages'] })
    } else {
      for (const key of ['playwright', 'peekaboo']) {
        const spec = value.packages[key]
        if (spec !== undefined && (typeof spec !== 'string' || !spec.trim())) {
          issues.push({ message: `packages.${key} 需为非空字符串`, path: ['packages', key] })
        }
      }
    }
  }
  return issues.length ? { issues } : { value }
}

export const Config = { '~standard': { version: 1, vendor: 'browser-computer', validate } }
