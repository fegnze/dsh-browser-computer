/**
 * Client 半边：在**本插件自己的详情页**里给出一段状态说明 + 一个「一键修复」。
 *
 * 形态照官方 templates/decoration/client.js：手写包信封 + 同步 require('react')，
 * 不用打包器、不 require 任何 Harness Client 包（官方 practices 明令禁止）。
 * 信封的 id 必须等于包名。
 *
 * 与 Host 通信走同源 fetch（第三方插件加不了自己的 ctx.remote 命名空间），
 * 请求带自定义意图头，Host 侧再过 connection.admit。
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser-computer',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PKG = 'dsh-browser-computer'
    // Keep existing HTTP, component and stylesheet identifiers stable across package renames.
    const LEGACY_ID = 'myspace-dsh-browser-computer'
    const INTENT = { 'x-myspace-browser-computer': '1' }
    const PERMISSION_LABEL = { screenRecording: '屏幕录制', accessibility: '辅助功能', eventSynthesizing: '合成输入' }
    const MARK = { granted: '✓', denied: '✗', unknown: '?' }
    const STEP_LABEL = {
      environment: '环境', dependencies: '依赖', permissions: '授权',
      authorization: '授权引导', connection: '连接',
    }

    const CSS = [
      '.bcx{display:flex;flex-direction:column;gap:12px;max-width:720px;color:var(--dsw-alias-label-primary)}',
      '.bcx__title{margin:0;font-size:14px;font-weight:600;line-height:22px}',
      '.bcx__head{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.bcx__head--ok{color:var(--dsw-alias-state-success-primary)}',
      '.bcx__head--warn{color:var(--dsw-alias-state-warn-primary)}',
      '.bcx__head--bad{color:var(--dsw-alias-state-error-primary)}',
      '.bcx__stage{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.bcx__actions{display:flex;gap:8px}',
      '.bcx__btn{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,6px);height:32px;padding:0 14px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);cursor:pointer}',
      '.bcx__btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.bcx__btn:disabled{opacity:.55;cursor:default}',
      '.bcx__btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-state-business-primary);outline-offset:1px}',
      '.bcx__card{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));padding:10px 14px;display:flex;flex-direction:column;gap:2px}',
      '.bcx__cardTitle{margin:0 0 4px;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.bcx__row{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:13px;line-height:20px;padding:2px 0}',
      '.bcx__rowLabel{color:var(--dsw-alias-label-secondary);flex:none}',
      '.bcx__rowValue{text-align:right;overflow-wrap:anywhere}',
      '.bcx__rowValue--ok{color:var(--dsw-alias-state-success-primary)}',
      '.bcx__rowValue--bad{color:var(--dsw-alias-state-error-primary)}',
      '.bcx__rowValue--warn{color:var(--dsw-alias-state-warn-primary)}',
      '.bcx__hint{margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.bcx__error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:18px;overflow-wrap:anywhere}',
      '.bcx__action{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.bcx__action--block{color:var(--dsw-alias-state-error-primary)}',
      '.bcx__action--warn{color:var(--dsw-alias-state-warn-primary)}',
      '.bcx__action--ok{color:var(--dsw-alias-state-success-primary)}',
    ].join('')

    async function call(path, body) {
      const response = await fetch(`/${LEGACY_ID}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: body === undefined ? INTENT : { ...INTENT, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
      if (!response.ok || !payload || payload.ok === false) {
        const detail = payload?.error?.message ?? `HTTP ${response.status}`
        // Host 半边有进程内模块缓存：改了路由但没完整重启 App，打过来就是旧处理器的 404。
        // 这种情况必须直接说清怎么修，否则界面上只会冒出一行看不懂的东西。
        if (response.status === 404) {
          throw new Error(`接口 ${path} 未就绪（${detail}）。若刚更新过本插件，请完整退出并重开 DSH App 让 Host 重新加载。`)
        }
        throw new Error(detail)
      }
      return payload.value
    }

    function row(label, value, tone) {
      return h('div', { className: 'bcx__row', key: label },
        h('span', { className: 'bcx__rowLabel' }, label),
        h('span', { className: `bcx__rowValue bcx__rowValue--${tone || 'plain'}` }, value))
    }

    /** 一句话说清现在能不能用。先给结论，细节在下面。 */
    function headline(report) {
      if (report.environment?.blockers?.length) return { tone: 'bad', text: report.environment.blockers[0] }
      if (report.installed?.some((item) => !item.ok)) return { tone: 'bad', text: '有依赖没装上，详见下面' }
      const permissions = report.permissions
      if (permissions?.supported && permissions.missing?.length) {
        return { tone: 'bad', text: `还差系统授权：${permissions.missing.map((key) => PERMISSION_LABEL[key]).join('、')}` }
      }
      if (report.connections?.some((item) => !item.ok)) return { tone: 'warn', text: 'MCP 连接未通过，详见下面' }
      if (report.stage === 'check') return { tone: 'plain', text: '当前状态如下；点「一键修复」补齐依赖与授权' }
      return { tone: 'ok', text: '已就绪：依赖、系统授权、MCP 连接都正常' }
    }

    function statusCard(report) {
      const env = report.environment
      const perms = report.permissions
      const rows = []
      if (env) {
        const browser = env.browsers?.any
          ? `${env.browsers.found.length} 个`
          : env.playwrightCache?.any ? '仅 Playwright 缓存' : '未找到'
        const warmed = [env.npxCache?.cached?.playwright ? 'playwright' : null, env.npxCache?.cached?.peekaboo ? 'peekaboo' : null]
          .filter(Boolean).join('、')
        rows.push(row('环境', `${env.platform} · node ${env.node?.version ?? '?'} · npx ${env.npx?.path ? '✓' : '✗'}`, env.npx?.path ? 'ok' : 'bad'))
        rows.push(row('浏览器', browser, env.browsers?.any ? 'ok' : env.playwrightCache?.any ? 'warn' : 'bad'))
        rows.push(row('依赖包缓存', warmed || '无（修复时会下载）', warmed ? 'ok' : 'warn'))
      }
      if (perms?.supported) {
        for (const key of Object.keys(PERMISSION_LABEL)) {
          const state = perms.states?.[key]
          rows.push(row(PERMISSION_LABEL[key], MARK[state] ?? '?', state === 'granted' ? 'ok' : state === 'denied' ? 'bad' : 'warn'))
        }
      } else if (perms) {
        rows.push(row('系统权限', perms.reason ?? '不适用', 'warn'))
      }
      const connections = report.connections
      if (connections?.length) {
        for (const item of connections) {
          rows.push(row(item.label, item.ok ? `${item.serverVersion ?? '已连接'} · ${item.toolCount} 个工具` : `未通过：${item.error ?? item.phase}`, item.ok ? 'ok' : 'bad'))
        }
      }
      return h('div', { className: 'bcx__card', key: 'status' },
        h('h4', { className: 'bcx__cardTitle' }, '状态'),
        rows,
        perms?.supported && perms.missing?.length
          ? h('p', { className: 'bcx__hint' }, '授权对象是 DSH App（不是终端）。改动授权后需完整重启 App 才会生效。')
          : null,
        perms?.supported && !perms.missing?.length && perms.unknown?.length
          ? h('p', { className: 'bcx__hint' }, '? 表示读不到状态，不代表未授予。')
          : null)
    }

    function stepsCard(report) {
      if (!report.steps?.length) return null
      return h('div', { className: 'bcx__card', key: 'steps' },
        h('h4', { className: 'bcx__cardTitle' }, '修复步骤'),
        report.steps.map((item) => row(
          STEP_LABEL[item.step] ?? item.step,
          `${item.ok ? '✓' : '✗'} ${item.detail ?? ''}`.trim(),
          item.ok ? 'ok' : 'bad',
        )))
    }

    function actionsCard(report) {
      const actions = report.actions ?? []
      if (!actions.length) return null
      return h('div', { className: 'bcx__card', key: 'actions' },
        h('h4', { className: 'bcx__cardTitle' }, '还需要'),
        actions.map((action, index) => h('p', { key: index, className: `bcx__action bcx__action--${action.level}` },
          `${action.what}${action.how ? ` —— ${action.how}` : ''}`)))
    }

    const SUBJECT_NAME = (subject) =>
      (subject && (subject.kind === 'bundle' || subject.kind === 'row') ? subject.pkg?.name : undefined)

    function Section({ subject }) {
      // 这是插件**自己**的体检，所以只在本插件的详情页渲染；别人的详情页返回 null。
      const isMine = SUBJECT_NAME(subject) === PKG

      // 注意：所有 hook 必须在下面的提前 return 之前无条件调用。
      const [busy, setBusy] = React.useState(false)
      const [report, setReport] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [autoRan, setAutoRan] = React.useState(false)

      const load = React.useCallback(async () => {
        setError(null)
        try {
          setReport(await call('/api/status'))
        } catch (caught) {
          setError(String(caught && caught.message ? caught.message : caught))
        }
      }, [])

      const repair = React.useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          setReport(await call('/api/repair', { verify: true }))
        } catch (caught) {
          setError(String(caught && caught.message ? caught.message : caught))
        } finally {
          setBusy(false)
        }
      }, [])

      // 打开详情页就先报状态（只读、不联网）。依赖与授权的修复由 Host 在插件激活时自动做。
      React.useEffect(() => {
        if (!isMine || autoRan) return
        setAutoRan(true)
        void load()
      }, [isMine, autoRan, load])

      if (!isMine) return null

      const head = report ? headline(report) : null
      return h('section', { className: 'bcx' },
        h('h3', { className: 'bcx__title' }, '环境检查与授权'),
        head
          ? h('p', { className: `bcx__head bcx__head--${head.tone}` }, head.text)
          : h('p', { className: 'bcx__stage' }, '正在检查…'),
        error ? h('p', { className: 'bcx__error', role: 'alert' }, error) : null,
        h('div', { className: 'bcx__actions' },
          h('button', {
            type: 'button',
            className: 'bcx__btn',
            disabled: busy,
            onClick: () => { void repair() },
          }, busy ? '修复中…' : '一键修复')),
        report ? statusCard(report) : null,
        report ? stepsCard(report) : null,
        report ? actionsCard(report) : null)
    }

    function installStyle() {
      const tag = document.createElement('style')
      // dataset 必须在插入 DOM 之前写好，否则会被下一个物化的模块认领并在卸载时删掉。
      tag.dataset.plugin = PKG
      tag.dataset.pluginCss = `${LEGACY_ID}/style`
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(installStyle, 'browser-computer: stylesheet')
        // 挂在**插件自己的详情页**（官方为插件预留的扩展槽），不是宿主设置页。
        ctx.effect(
          () => ctx.slots.inject('plugins.detail.section', () => ctx.slots.register(
            { name: 'plugins.detail.section', id: `${LEGACY_ID}/section`, order: 40, label: () => '环境检查与授权' },
            Section,
          )),
          'browser-computer: detail section',
        )
      },
    }
  },
})
