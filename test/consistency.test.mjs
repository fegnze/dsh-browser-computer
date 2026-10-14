import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { extname } from 'node:path'

import { DEFAULT_CONFIG, normalizeConfig } from '../src/config.mjs'
import { buildArgv, PACKS } from '../src/packs.mjs'

const patchUrl = new URL('../cordis.patch.yml', import.meta.url)
const packageUrl = new URL('../package.json', import.meta.url)

test('cordis.patch.yml 与能力包声明保持一致（防止两边漂移）', async () => {
  const patch = await readFile(patchUrl, 'utf8')
  const packages = normalizeConfig({}).packages

  for (const pack of PACKS) {
    const argv = buildArgv(pack, { npxPath: '/x/npx', packages })
    // 跳过 argv[0]（npx 由 !!js 动态解析）与 argv[1]（-y 的写法两边不同）
    for (const token of argv.slice(2)) {
      assert.ok(
        patch.includes(`'${token}'`) || patch.includes(`"${token}"`) || patch.includes(`- ${token}`),
        `能力包 ${pack.id} 的参数 ${token} 不在 cordis.patch.yml 里`,
      )
    }
    assert.ok(
      new RegExp(`serverName:\\s*${pack.serverName}\\b`).test(patch),
      `cordis.patch.yml 缺少 serverName: ${pack.serverName}`,
    )
  }
})

test('cordis.patch.yml 不写死任何本机绝对路径', async () => {
  const patch = await readFile(patchUrl, 'utf8')
  assert.doesNotMatch(patch, /\/Users\/[a-z]/i, 'patch 里出现了 /Users/... 硬编码路径')
  assert.doesNotMatch(patch, /\/home\/[a-z]/i, 'patch 里出现了 /home/... 硬编码路径')
  assert.match(patch, /!!js/, '绝对路径必须经 !!js 在加载时解析')
})

test('cordis.patch.yml 声明了插件本体与 playwright-mcp / peekaboo-mcp 两条行', async () => {
  const patch = await readFile(patchUrl, 'utf8')
  for (const id of ['browser-computer', 'playwright-mcp', 'peekaboo-mcp']) {
    assert.ok(patch.includes(`id: ${id}`), `缺少行 ${id}`)
  }
  assert.equal(patch.match(/name: '@deepseek-ai\/dsh-mcp-client'/g)?.length, 2)
})

test('package.json 的 dsh.bundle.patch 指向真实存在的 patch', async () => {
  const manifest = JSON.parse(await readFile(packageUrl, 'utf8'))
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(manifest.name, 'myspace-dsh-browser-computer')
  // 官方 mcp-bundle 模板：配置型 bundle 不需要 Host/Client 入口文件，也不认 dsh.files。
  assert.equal(manifest.dsh?.files, undefined, 'dsh.files 是死字段（官方解析器不读）')
  const patch = await readFile(patchUrl, 'utf8')
  assert.match(patch, new RegExp(manifest.name))
})

test('配置归一化：坏值退回默认，不抛错', () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG)

  const tooSmall = normalizeConfig({ probeTimeoutMs: 10 })
  assert.equal(tooSmall.probeTimeoutMs, DEFAULT_CONFIG.probeTimeoutMs)

  const ok = normalizeConfig({ probeTimeoutMs: 30000, allowOpenSettings: false })
  assert.equal(ok.probeTimeoutMs, 30000)
  assert.equal(ok.allowOpenSettings, false)

  const blankPackage = normalizeConfig({ packages: { playwright: '   ' } })
  assert.equal(blankPackage.packages.playwright, DEFAULT_CONFIG.packages.playwright)

  const notAnObject = normalizeConfig('nonsense')
  assert.deepEqual(notAnObject, DEFAULT_CONFIG)
})

test('配置校验：非法值返回 issues 而不是抛错', async () => {
  const { Config } = await import('../src/config.mjs')
  const validate = Config['~standard'].validate
  assert.deepEqual(validate(null), { value: {} })
  assert.ok(validate('nope').issues)
  assert.ok(validate({ probeTimeoutMs: 1 }).issues)
  assert.ok(validate({ packages: { peekaboo: '' } }).issues)
  assert.deepEqual(validate({ probeTimeoutMs: 20000 }), { value: { probeTimeoutMs: 20000 } })
})

test('icon 符合 dsh-app-boot 的图标规则（相对路径 / 允许的格式 / ≤256 KiB）', async () => {
  const manifest = JSON.parse(await readFile(packageUrl, 'utf8'))
  const icon = manifest.icon
  assert.equal(typeof icon, 'string', '缺少 package.json#icon')
  assert.doesNotMatch(icon, /^[A-Za-z][A-Za-z\d+.-]*:/, 'icon 不能是绝对路径或 URL')
  assert.ok(!icon.startsWith('/'), 'icon 必须是相对路径')
  assert.ok(['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(extname(icon).toLowerCase()), 'icon 必须是 SVG/PNG/JPEG/WebP')
  const bytes = await readFile(new URL(`../${icon.replace(/^\.\//, '')}`, import.meta.url))
  assert.ok(bytes.length <= 256 * 1024, `icon 超过 256 KiB（${bytes.length} 字节）`)
})

test('Client 半边：信封 id 等于包名，注册进 plugins.detail.section，且不 require 其他 Harness Client 包', async () => {
  const manifest = JSON.parse(await readFile(packageUrl, 'utf8'))
  assert.equal(typeof manifest.dsh?.client?.platform, 'string', 'dsh.client.platform 必须是字符串')
  const clientPath = manifest.exports?.['./client']
  assert.ok(clientPath, '缺少 exports["./client"]')
  const text = await readFile(new URL(`..${clientPath.slice(1)}`, import.meta.url), 'utf8')
  assert.match(text, new RegExp(`id:\\s*'${manifest.name}'`), '包信封 id 必须等于包名')
  assert.match(text, /plugins\.detail\.section/, '应注册到 plugins.detail.section')
  assert.doesNotMatch(text, /require\('@deepseek-ai\/dsh-client-ui-/, '禁止 require 其他 Harness Client 包')
  assert.match(text, /dataset\.plugin/, '样式标签必须在插入 DOM 前打上归属标记')
})

/* ---------- 公开发布标准（对齐官方 references/host-plugin.md） ---------- */

test('发布必需字段齐全：可发布、带 dsh-plugin 关键词、有 license 与仓库信息', async () => {
  const manifest = JSON.parse(await readFile(packageUrl, 'utf8'))
  assert.notEqual(manifest.private, true, 'private: true 会导致 npm 拒发')
  assert.equal(manifest.license, 'MIT')
  assert.ok(Array.isArray(manifest.keywords) && manifest.keywords.includes('dsh-plugin'),
    'keywords 必须含 dsh-plugin —— npm 侧目录按它检索')
  assert.ok(manifest.repository?.url, '缺 repository，npm/GitHub 双向链接断掉')
  assert.ok(manifest.homepage && manifest.bugs?.url)
  await readFile(new URL('../LICENSE', import.meta.url), 'utf8')
})

test('dsh 清单：manifestVersion + bundle.patch + client.platform', async () => {
  const manifest = JSON.parse(await readFile(packageUrl, 'utf8'))
  assert.equal(manifest.dsh?.manifestVersion, 1)
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(typeof manifest.dsh?.client?.platform, 'string')
})

test('engines.dsh 必须是范围而不是精确版本', async () => {
  const manifest = JSON.parse(await readFile(packageUrl, 'utf8'))
  const range = manifest.engines?.dsh ?? ''
  assert.match(range, /[<>=^~]/, `engines.dsh 写成了精确版本 "${range}"，别的 patch 版本会被 peer 检查拒装`)
})

test('package.json#files 必须覆盖运行期真正需要的文件', async () => {
  const manifest = JSON.parse(await readFile(packageUrl, 'utf8'))
  const patterns = (manifest.files ?? []).map((p) => p.replace(/\/+$/, ''))
  const isCovered = (rel) => patterns.some((p) => rel === p || rel.startsWith(`${p}/`))

  const critical = ['cordis.patch.yml', manifest.icon.replace(/^\.\//, '')]
  for (const name of await readdir(new URL('../src', import.meta.url))) critical.push(`src/${name}`)
  for (const name of await readdir(new URL('../locale', import.meta.url))) critical.push(`locale/${name}`)

  for (const rel of critical) {
    assert.ok(isCovered(rel), `files 白名单漏了 ${rel}：装到的包会缺文件（图标退回默认 / bundle 起不来）`)
  }
})

test('展示元数据：locale/{en,zh}.json 形状为 {meta:{title,description}}', async () => {
  const manifest = JSON.parse(await readFile(packageUrl, 'utf8'))
  assert.ok(manifest.exports?.['./locale/*.json'], 'exports 必须暴露 ./locale/*.json')
  for (const lang of ['en', 'zh']) {
    const raw = await readFile(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8')
    const parsed = JSON.parse(raw)
    assert.equal(typeof parsed.meta?.title, 'string', `locale/${lang}.json 缺 meta.title`)
    assert.ok(parsed.meta.title.trim() && parsed.meta.description.trim(), `locale/${lang}.json 的 meta 不能为空`)
  }
})

test('文档布局：根目录只能有一个 readme 文件，否则 npm 会挑错渲染的那份', async () => {
  // 实测（2026-10-14）：根目录同时存在 README.md 与 README.zh.md 时，npm registry 把
  // README.zh.md 当成包的 README —— readme 字段 6090 字符，正好等于中文那份的 6089 字符
  // 加一个换行；英文那份是 12428 字符。所以这不是缓存延迟，是真的取错了。
  // 而且 npm-packlist 会把任何 /readme* 文件强制打进 tarball，files 白名单挡不住，
  // 因此中文文档必须用一个不带 readme 的文件名（现为 docs/zh.md）。
  const root = await readdir(new URL('..', import.meta.url))
  const readmes = root.filter((name) => /^readme/i.test(name))
  assert.deepEqual(readmes, ['README.md'],
    `根目录的 readme 类文件必须只有 README.md，实际：${readmes.join(', ')}`)
})

test('双语文档：英文主文档 + docs/zh.md，用绝对链接互相指向', async () => {
  const repo = 'https://github.com/fegnze/myspace-dsh-browser-computer/blob/main'
  const en = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const zh = await readFile(new URL('../docs/zh.md', import.meta.url), 'utf8')

  for (const [name, text] of [['README.md', en], ['docs/zh.md', zh]]) {
    assert.ok(text.includes(`[English](${repo}/README.md)`), `${name} 缺 English 绝对链接`)
    assert.ok(text.includes(`[中文](${repo}/docs/zh.md)`), `${name} 缺 中文 绝对链接`)
  }

  // 主 README 必须是英文：汉字只应出现在语言切换链接里。
  const han = (en.match(/[\u4e00-\u9fff]/g) ?? []).length
  assert.ok(han < 40, `README.md 应以英文为主，实际含 ${han} 个汉字（像是残留了中文正文）`)
})
