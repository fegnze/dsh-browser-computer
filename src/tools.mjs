/**
 * 模型可见的工具与人类可用的斜杠命令。
 *
 * 只留两个动作：`check`（只读）与 `repair`（一键修复）。够用就好 —— 工具 schema 是常驻
 * 上下文成本，每多一个都在每次请求里扣 token。
 */

const asText = (value) => [{ type: 'text', text: String(value) }]

function defineTool(spec, execute) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => asText(value) },
    timeoutMs: spec.timeoutMs ?? 300000,
    execute,
  }
}

const TOOL_SPECS = [
  {
    name: 'browser_computer_check',
    description:
      '浏览器与电脑操控 · 只读状态：本地依赖（Node/npx/浏览器/依赖包缓存）、macOS 屏幕录制与辅助功能授权状态、playwright-mcp 与 peekaboo-mcp 的接线冲突。不联网、不装包、不改配置。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 120000,
  },
  {
    name: 'browser_computer_repair',
    description:
      '浏览器与电脑操控 · 一键修复：装缺失的依赖包、检查 macOS 授权并打开需要授权的系统设置面板，最后验证 playwright-mcp 与 peekaboo-mcp 能否连上。幂等：已缓存的包不重复下载，授权齐全时不动系统设置。',
    parameters: {
      type: 'object',
      properties: {
        verify: {
          type: 'boolean',
          description: '是否在最后做一次真实 MCP 连接测试（会拉起两个 MCP server，默认 true）。',
        },
        force: {
          type: 'boolean',
          description: '即使依赖包已缓存也重新拉一次，用于怀疑缓存损坏时（默认 false）。',
        },
      },
      additionalProperties: false,
    },
    timeoutMs: 600000,
  },
]

export function registerTools(ctx, doctor) {
  const disposers = TOOL_SPECS.map((spec) =>
    ctx.tools.register(
      defineTool(spec, async (args) => {
        const raw = args && typeof args === 'object' ? args : {}
        try {
          const report = spec.name === 'browser_computer_check'
            ? await doctor.check()
            : await doctor.repair({ openSettings: true, verify: raw.verify !== false, force: raw.force === true })
          return JSON.stringify(report, null, 2)
        } catch (error) {
          return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      }),
    ),
  )
  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        /* 已卸载 */
      }
    }
  }
}

const MARK = { granted: '✓', denied: '✗', unknown: '?' }
const PERMISSION_LABEL = { screenRecording: '屏幕录制', accessibility: '辅助功能', eventSynthesizing: '合成输入' }
const LEVEL_LABEL = { ok: '通过', warn: '注意', block: '阻塞' }

/** 给人看的短摘要；斜杠命令与控制台共用。 */
export function summarize(report) {
  const lines = []
  const title = report.stage === 'repair'
    ? '一键修复'
    : report.stage === 'test' ? '体检 + 连接测试' : '只读体检'
  lines.push(`浏览器与电脑操控 · ${title}${report.elapsedMs ? `（${report.elapsedMs}ms）` : ''}`)

  const env = report.environment
  if (env) {
    const browser = env.browsers?.any
      ? `${env.browsers.found.length} 个`
      : env.playwrightCache?.any ? '仅 Playwright 缓存' : '未找到'
    lines.push(`环境：${env.platform} ${env.osRelease ?? ''} · node ${env.node?.version ?? '?'} · npx ${env.npx?.path ? '✓' : '✗'} · 浏览器 ${browser}`.trimEnd())
  }

  const perms = report.permissions
  if (perms?.supported) {
    const parts = Object.keys(PERMISSION_LABEL)
      .map((key) => `${PERMISSION_LABEL[key]} ${MARK[perms.states?.[key]] ?? '?'}`)
    lines.push(`权限：${parts.join(' / ')}${perms.source ? `（来源：${perms.source}）` : ''}`)
  } else if (perms) {
    lines.push(`权限：不适用（${perms.reason}）`)
  }

  if (report.steps?.length) {
    lines.push('步骤：')
    for (const item of report.steps) {
      lines.push(`  ${item.ok ? '✓' : '✗'} ${item.step}${item.detail ? ` —— ${item.detail}` : ''}`)
    }
  }

  if (report.connections?.length) {
    lines.push('连接：')
    for (const item of report.connections) {
      lines.push(item.ok
        ? `  ✓ ${item.label}：${item.serverVersion ?? '已连接'} · ${item.toolCount} 个工具 · ${item.elapsedMs}ms`
        : `  ✗ ${item.label}：${item.error ?? item.phase}`)
    }
  }

  const actions = report.actions ?? []
  if (actions.length) {
    lines.push('下一步：')
    for (const action of actions) {
      lines.push(`  [${LEVEL_LABEL[action.level] ?? action.level}] ${action.what}${action.how ? ` —— ${action.how}` : ''}`)
      for (const panel of action.panels ?? []) lines.push(`       ${panel.label}：${panel.url}`)
    }
  }

  if (report.settingsOpened?.length) {
    lines.push(`已打开系统设置：${report.settingsOpened.map((item) => `${item.label}${item.ok ? '' : '(打开失败)'}`).join('、')}`)
  }
  return lines.join('\n')
}

export function registerCommand(commands, doctor) {
  return commands.register({
    name: 'browser-computer',
    description: '浏览器与电脑操控：check（只读状态）/ repair（一键修复：装依赖、引导授权、验证连接）',
    input: { hint: 'check | repair' },
    handler: async (invocation) => {
      const arg = String(invocation?.rawInput ?? '').trim().toLowerCase() || 'repair'
      try {
        if (arg === 'check' || arg === 'status') return { kind: 'success', text: summarize(await doctor.check()) }
        if (arg === 'repair' || arg === 'fix' || arg === 'setup') {
          return { kind: 'success', text: summarize(await doctor.repair({ openSettings: true, verify: true })) }
        }
        return { kind: 'error', text: `未知参数：${arg}（可用 check | repair）` }
      } catch (error) {
        return { kind: 'error', text: `执行失败：${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
}
