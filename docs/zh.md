# 浏览器与电脑操控（`dsh-browser-computer`）

[English](https://github.com/fegnze/dsh-browser-computer/blob/main/README.md) | [中文](https://github.com/fegnze/dsh-browser-computer/blob/main/docs/zh.md)

把「让 DSH 直接操作浏览器和电脑」做成**装一次就生效的插件**。插件本体就是
`cordis.patch.yml` 里的两条 MCP 行 —— `playwright-mcp` 与 `peekaboo-mcp`。这是官方
`templates/mcp` + `references/mcp-bundle.md` 规定的「配置型 bundle」写法：**不需要 Host /
Client 入口文件**，装上即把两个 MCP server 接进 DSH。

装上后自动跑一遍「查环境 → 装缺的依赖 → 查授权 → 需要就打开授权面板」，界面只给状态说明和一个
「一键修复」。它**不写 profile 配置**（那是官方插件管理器的唯一职责），也**不修改任何系统授权**
（只打开对应面板让你自己点）。

## 它接什么

| 行 | 提供方 | 得到什么 |
| --- | --- | --- |
| `playwright-mcp` | `@playwright/mcp` | 无障碍快照 + 稳定 ref 驱动真实浏览器：导航、点击、填表、多标签、截图、网络请求、cookie/storage |
| `peekaboo-mcp` | `@steipete/peekaboo` | 读写 macOS 无障碍树、截图、真实鼠标与键盘操作（仅 macOS） |

`command` 用 `!!js` 在加载时解析成「与 node 同目录的 npx」绝对路径 —— 不写死任何本机路径，
也不依赖 Finder/Dock 启动时那个最小的 PATH（裸 `npx` 在那种环境里解析不到，会静默起不来）。

## 安装与生效

三种装法，任选其一：

```bash
# 1) 从 npm（推荐，版本确定、可复现）
dsh plugin --profile desktop add dsh-browser-computer

# 2) 直接从 GitHub
dsh plugin --profile desktop add github:fegnze/dsh-browser-computer

# 3) 本地开发（指向本仓库目录，改动即时可见）
dsh plugin --profile desktop add link:<本仓库绝对路径>
```

**装完必须完整退出并重开 DSH App。** 依据（均已实测）：

- 两条 MCP 行安装后立刻出现在配置层（`Config.listConfigs` 能看到 `playwright-mcp` /
  `peekaboo-mcp`），但**不会**在当前运行的会话里材料化成 `mcp__playwright__*` /
  `mcp__peekaboo__*` 工具，也不会拉起 MCP 子进程。
- 辅助半边的 Host 代码由模块缓存持有：改了源码不重启，激活仍按旧版本报错。
- 官方 mcp-bundle 配方本身也把「装上 → 调用 `mcp__<serverName>__<tool>` 验证」作为一步。

重开后验证：让模型调用 `browser_computer_repair`，或斜杠命令 `/browser-computer repair`，或直接
调一个 MCP 工具（例如 `mcp__playwright__browser_navigate`）。

Client 半边（插件详情页里的分区）还要**多一步刷新页面**：App 重启后才会把本插件的 client 条目编进
启动图，正在打开的页面需要刷新一次才会挂上。

## 装上之后会自己做什么

插件激活（装完/重启 App）就自动跑一遍 `repair`，不需要你先点任何东西：

1. **查环境** —— Node/npx/浏览器二进制/依赖包缓存
2. **装缺的依赖** —— `npx -y <包> --version` 预热 playwright-mcp 与 peekaboo-mcp；**已缓存的包不重拉**
3. **查授权** —— 屏幕录制 / 辅助功能（`--no-remote`，状态归属 DSH App 这条进程链）
4. **引导授权** —— 有未授予项就打开对应的「系统设置」面板（只打开面板，不改授权）

整个过程幂等、跑在后台，任何一步失败只记一行日志，**绝不影响插件激活**。
不想要这个行为就设 `autoRepairOnStart: false`。

## 界面：状态说明 + 一个按钮

界面挂在**本插件的详情页**（官方槽位 `plugins.detail.section`），**不进宿主设置页** ——
这是本插件自己的体检，不是宿主的一项设置。`Section` 在别人的详情页返回 `null`
（`subject.kind === 'bundle' && subject.pkg.name === 包名` 才渲染），所以不会串到其他插件页上。

只有两样东西：

- **一句话状态** + 一张状态卡（环境 / 三项授权 / MCP 连接），打开详情页就自动读一次（只读、不联网）
- **一个「一键修复」按钮** → `POST /api/repair`：装缺的依赖、打开需要授权的面板、最后验证连接

两个接口都过两道栅栏：自定义意图头（挡跨站简单请求）+ `connection.admit`（Host/Origin 栅栏与
浏览器认证）。UI 侧不 require 任何 Harness Client 包，控件与样式都是自带的，只引用
`--dsw-alias-*` 主题 token。

Client 改动实测**不需要重启 App**：改完 `src/client.js` 后图会重建，在线页面直接接上
（`plugins.detail.section` 的 occupants 立刻出现本插件的条目）。只有 Host 改动需要完整重启。

## 两个动作

| 命令 | 工具 | 副作用 | 做什么 |
| --- | --- | --- | --- |
| `/browser-computer check` | `browser_computer_check` | 无（不联网） | 本地依赖、macOS 授权状态、profile 接线冲突 |
| `/browser-computer repair` | `browser_computer_repair` | 装依赖 + 可开系统面板 | 装缺的依赖 → 查授权并引导 → 验证 MCP 连接（`verify: false` 可跳过） |

默认（不带参数）走 `repair`。工具面只保留这两个：工具 schema 是常驻上下文成本。

## macOS 权限：一个容易白找半天的坑

TCC（系统设置 → 隐私与安全性）里**没有** “Event Synthesizing” 这个开关。它是 Peekaboo
对自己派生能力的命名，实际挂在「辅助功能」下：

| 报告里的名字 | 系统设置里的位置 | 影响 |
| --- | --- | --- |
| 屏幕录制 | 隐私与安全性 → 屏幕录制 | 截图、窗口枚举 |
| 辅助功能 | 隐私与安全性 → 辅助功能 | 无障碍树读写、后台点击 |
| 合成输入（Event Synthesizing） | 同上，「辅助功能」授权后自动跟着开 | 合成键盘、前台指针操作 |

两个必须知道的点：

1. **授权对象是 DSH App**，不是终端。插件用 `--no-remote` 让 Peekaboo 在本机执行环境里
   报告权限，这样状态归属 DSH App 这条进程链；如果绕到 Peekaboo Bridge/daemon，那是另一套
   授权（而且会顺带起一个常驻进程）。
2. **授权后要重启 DSH App**。TCC 变更对已经在运行的进程不一定立即生效。

## 安全边界（装之前先读）

- 本插件的 `computer` 行带 `--allow-foreground`：**没有它就不能真正点击/打字**。只需要
  后台无障碍操作时，从 `cordis.patch.yml` 删掉这一个参数即可降权。
- Playwright MCP 自带 `browser_run_code_unsafe`，官方标注 “RCE-equivalent”。浏览器页面内容
  属于不可信输入，别一上来就挂你日常登录的浏览器 profile。
- 插件不碰权限，所以能力上限完全由你的 permission preset 决定。
- 上下文成本：两个能力包合计约 50 个工具 schema 常驻系统提示。觉得亏就在 `cordis.patch.yml`
  里整条删掉对应的行。

## 不要重复接线

如果你已经手动往 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加过同样 `serverName` 的
MCP 行，它和本插件声明的那条会撞成**两个 MCP 实例、工具重名**。体检的 `check` 阶段会点出
这类冲突（`wiring.conflicts`），但**不会替你改配置** —— 删手动那条的动作由你来做。

## 回滚

```bash
dsh plugin --profile desktop remove dsh-browser-computer
```

移除后两条 MCP 行随之失效。若想保留能力但去掉体检工具，只删 `browser-computer` 那条行即可。

## 开发

```bash
cd dsh-browser-computer
node --test test/*.test.mjs
```

测试不跑真实 npx：subprocess、文件系统、环境全部经依赖注入替换。值得留意的几组断言：

- `mcp-probe.test.mjs` —— 在内存流上跑真实的换行分隔 JSON-RPC，覆盖成功 / RPC 错误 / 超时 / 起不来
- `doctor.test.mjs` —— check / repair 的行为与「失败时不伪装成功」
- `http.test.mjs` —— 路由的两道栅栏（意图头 + admit）、404、坏 JSON、异常透传
- `client.test.mjs` —— **在受控全局里真跑一遍 Client 包信封**，能抓到信封 id 写错、导出形状错、
  槽位注册写错、样式标签没打归属标记、偷 require 别的 Harness Client 包
- `host.test.mjs` —— **`commands` / `webServer` 必须经 `ctx.inject` 声明**
- `consistency.test.mjs` —— patch 里声明的参数与 `src/packs.mjs` 的 argv 必须一致，
  patch 里不得出现硬编码本机路径，图标必须满足 dsh-app-boot 的四条规则

## 三个踩过的坑（别再踩）

1. **apply 阶段别用 `ctx.get('服务名')`。** 实测 `ctx.get('webServer')` 与 `ctx.get('commands')`
   在插件 apply 时都返回 `undefined`，`if (svc?.register)` 会**静默**跳过注册 —— 装的时候一切
   正常，点按钮才发现 404、斜杠命令根本不存在。可选服务统一用 `ctx.inject([...], (c) => …)`；
   只有在**请求处理时**（上下文已完全组装）才适合 `ctx.get`，比如取 `connection`。
2. **图标填不满卡片不是你的问题。** Host 的 `PackageArtwork` 固定按
   `CARD_ARTWORK_SIZE = 36`（组件行 `ROW_ARTWORK_SIZE = 30`）以 `<img width=size height=size>`
   渲染，外层卡片是 48×48，四周那圈留白由 Host 布局决定，改图标文件没用。
3. **权限状态是三种，不是两种。** Peekaboo 的 JSON 里权限名在 **value** 的 `name` 字段
   （`{ data: { permissions: [ { name, isRequired, isGranted } ] } }`），不是对象 key；按 key
   去找会永远匹配不到，三项全 `unknown`。而 `unknown` **绝不能**当成「未授予」上报——早期
   版本就是这么假报的。现在 `missing` 只收 `denied`，`unknown` 单独报「无法读取」。
   另外 `Event Synthesizing` 是派生能力（TCC 里没有独立开关，随「辅助功能」走），
   所以它只报状态、不进 `missing`，免得让人去系统设置里找一个不存在的开关。

## 图标资产

- `icon.png` —— 插件实际用的图标：**透明背景**，只保留箭头主体本身，裁紧到图形边界，
  256×256，47 KB（`dsh-app-boot` 的上限是 256 KiB）。
- `assets/icon-transparent.png` —— 768×768 的同款主图，备用/再导出（例如接入其他宿主时）。
- 两个文件都是 RGBA，四角像素 alpha 为 0，所以放在深色/浅色底上都不会出现白框。
  注意 Host 仍会把图片缩到 36×36 渲染，那圈留白是布局，不是图片里的白边。

## 已知限制

- `computer` 包仅 macOS；其他平台会在报告里标成不支持，而不是假装成功。
- `repair` 用 `npx -y` 现拉包，首次可能较慢；超时会明确标注并建议重试。
- 权限读取依赖 Peekaboo CLI 的输出；它换了输出格式时会退化成 `unknown`，报告不会猜。
- 体检只验证「MCP 连得上、工具在」，不验证「某个具体操作能不能成功」—— 后者取决于页面内容与
  当前前台窗口，属于运行期事实。
