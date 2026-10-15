# Browser & Computer Control (`dsh-browser-computer`)

[English](README.md) | [中文](README.zh.md)

Turns "let DSH drive a browser and a computer" into a plugin wired through a single installation.
The MCP capabilities are declared by two rows in `cordis.patch.yml` — `playwright-mcp`
and `peekaboo-mcp`. That part follows the official "configuration-only bundle" recipe
(`templates/mcp` + `references/mcp-bundle.md`): MCP wiring alone requires no Host or Client
entry file. This package additionally provides Host and Client entries for health checks,
repair, and the status UI. See the activation steps below.

Once activated it automatically runs "check environment → install missing dependencies →
check permissions → open the permission panels that need attention", and the UI is just a
status line plus one **Repair** button. It **never writes profile config** (that is the
official plugin manager's exclusive job) and **never changes system permissions** (it only
opens the relevant System Settings panel for you to click).

## What it wires

| Row | Provider | What you get |
| --- | --- | --- |
| `playwright-mcp` | `@playwright/mcp` | Real-browser control driven by accessibility snapshots and stable refs: navigate, click, fill, tabs, screenshots, network, cookies/storage |
| `peekaboo-mcp` | `@steipete/peekaboo` | Read/write the macOS accessibility tree, screenshots, real mouse and keyboard input (macOS only) |

`command` is resolved at load time via `!!js` to the absolute `npx` that sits next to `node` —
no machine-specific path is hard-coded, and it does not rely on the minimal `PATH` a
Finder/Dock-launched app receives (a bare `npx` cannot be resolved there, so the server dies
silently).

## Install and activation

Add any of these specs on DSH's official Plugins page. For profiles that allow CLI
management, use the commands below. If the Electron App exclusively owns the desktop
profile, use its plugin manager instead of trying to manage that profile from the CLI.

```bash
# 1) from npm (recommended; specify @version for reproducible installs)
dsh plugin --profile <profile> add dsh-browser-computer

# 2) straight from GitHub
dsh plugin --profile <profile> add github:fegnze/dsh-browser-computer

# 3) local development (points at this directory; refresh/restart requirements still apply)
dsh plugin --profile <profile> add link:<absolute path to this repo>
```

**After installing you must fully quit and reopen the DSH App.** Historical measurements:

- The two MCP rows appear in the config layer immediately after install (`Config.listConfigs`
  shows `playwright-mcp` / `peekaboo-mcp`), but they are **not** materialised into
  `mcp__playwright__*` / `mcp__peekaboo__*` tools in the running session, and no MCP child
  process is spawned.
- The Host half's JavaScript is held by the process module cache: without a restart,
  activation still reports errors from the previous revision.
- The official mcp-bundle recipe itself ends with "install, then call
  `mcp__<serverName>__<tool>` to verify".

After the restart, verify by asking the model to call `browser_computer_repair`, by running the
slash command `/browser-computer repair`, or by calling an MCP tool directly (for example
`mcp__playwright__browser_navigate`).

The Client half (the section on the plugin page) needs **one more step: refresh the page**.
Only after the App restarts does the boot graph include this plugin's client entry, so an
already-open page has to be refreshed once to pick it up.

## What it does on its own

Plugin activation (install, or App restart) runs `repair` once, without you clicking anything:

1. **Check environment** — Node / npx / browser binaries / dependency-package caches
2. **Install missing dependencies** — `npx -y <package> --version` warms playwright-mcp and
   peekaboo-mcp; **already-cached packages are never re-downloaded**
3. **Check permissions** — Screen Recording / Accessibility (`--no-remote`, so the state
   belongs to the DSH App's own process chain)
4. **Guide permissions** — if anything is not granted, open the matching System Settings panel
   (it only opens panels; it never grants anything)

The whole pass is idempotent and runs in the background; a failure in any step only writes one
log line and **never breaks activation**. Set `autoRepairOnStart: false` to turn it off.

## UI: a status line and one button

The UI lives on **this plugin's own detail page** (official slot `plugins.detail.section`), not
in the host Settings page — this is the plugin's own health check, not a host preference. The
`Section` component returns `null` for other plugins' subjects (it only renders when
`subject.kind === 'bundle' && subject.pkg.name === <package name>`), so it never leaks onto
other plugin pages.

There are exactly two things:

- **A one-line status** plus a status card (environment / the three permissions / MCP
  connection), read once automatically when the page opens (read-only, no network)
- **One "Repair" button** → `POST /api/repair`: installs missing dependencies, opens the panels
  that need authorisation, and finally verifies the connection

Both endpoints pass two fences: a custom intent header (which blocks cross-site simple
requests) and `connection.admit` (the Host/Origin fence plus browser authentication). The UI
does not `require` any Harness Client package; controls and styles are its own and reference
only `--dsw-alias-*` theme tokens.

In a previous development environment, a Client change did **not** need an App restart:
editing `src/client.js` rebuilt the graph and the live page picked it up (the plugin's entry
appeared in `plugins.detail.section`'s occupants). Refresh-free updates require an active
`pnpm run dev:web` watcher in the same checkout. Without verifying that watcher, rebuild the
affected Web artifacts and refresh the existing page; automatic updates are not promised.
Host changes require a full restart.

## The two actions

| Command | Tool | Side effects | What it does |
| --- | --- | --- | --- |
| `/browser-computer check` | `browser_computer_check` | none (no network) | local dependencies, macOS permission state, profile wiring conflicts |
| `/browser-computer repair` | `browser_computer_repair` | installs packages, may open panels | install missing dependencies → check and guide permissions → verify the MCP connection (`verify: false` skips that) |

With no argument it runs `repair`. The tool surface is deliberately just these two: tool
schemas are a permanent context cost.

## macOS permissions: the pitfall that wastes half an hour

TCC (System Settings → Privacy & Security) has **no** "Event Synthesizing" switch. That is
Peekaboo's name for a capability it derives; it actually hangs off Accessibility:

| Name in the report | Where in System Settings | What it affects |
| --- | --- | --- |
| Screen Recording | Privacy & Security → Screen Recording | screenshots, window enumeration |
| Accessibility | Privacy & Security → Accessibility | accessibility-tree reads/writes, background clicks |
| Event Synthesizing | same place; it opens automatically once Accessibility is granted | synthetic keyboard, foreground pointer actions |

Two things you must know:

1. **The grant target is the DSH App**, not your terminal. The plugin uses `--no-remote` so
   Peekaboo reports permissions from the local execution environment, which attributes the
   state to the DSH App's process chain. Going through a Peekaboo Bridge/daemon instead is a
   different grant *and* spawns a resident process.
2. **Restart the DSH App after granting.** A TCC change does not necessarily take effect for an
   already-running process.

## Security boundaries (read before installing)

- This plugin's `computer` row passes `--allow-foreground`: **without it, real clicking and
  typing are impossible**. If you only need background accessibility work, delete that single
  argument from `cordis.patch.yml` to reduce the privilege.
- Playwright MCP ships `browser_run_code_unsafe`, which the vendor labels "RCE-equivalent".
  Page content is untrusted input; do not point it at your daily-driver browser profile first.
- The plugin never touches permissions, so the ceiling is entirely your permission preset.
- Context cost: the two packs together contribute roughly 50 tool schemas to every system
  prompt. If that is not worth it, delete the corresponding row from `cordis.patch.yml`.

## Do not wire it twice

If you already added MCP rows with the same `serverName` to
`~/.dsh/profiles/<profile>/cordis.patch.yml` by hand, they collide with the rows this plugin
declares: **two MCP instances and duplicate tool names**. The `check` stage reports such
conflicts (`wiring.conflicts`) but **will not edit your config** — removing the manual row is
your call.

## Rollback

Remove the plugin on the official Plugins page, or for CLI-managed profiles:

```bash
dsh plugin --profile <profile> remove dsh-browser-computer
```

Removing it retires both MCP rows. To keep the capability but drop the health-check tools,
delete just the `browser-computer` row.

## Development

```bash
cd dsh-browser-computer
node --test test/*.test.mjs
```

The tests never run a real `npx`: subprocess, filesystem and environment are all injected.
Worth knowing:

- `mcp-probe.test.mjs` — runs real newline-delimited JSON-RPC over in-memory streams, covering
  success / RPC error / timeout / failure to spawn
- `doctor.test.mjs` — behaviour of `check` / `repair`, including "a failure is never dressed up
  as success"
- `http.test.mjs` — the route's two fences (intent header + admit), 404, bad JSON, error
  passthrough
- `client.test.mjs` — **actually executes the Client bundle envelope** in a controlled global,
  which catches a wrong envelope id, a wrong export shape, a wrong slot registration, a style
  tag that was not tagged with its owner before insertion, or a stray `require` of another
  Harness Client package
- `host.test.mjs` — **`commands` / `webServer` must be declared through `ctx.inject`**
- `consistency.test.mjs` — the arguments declared in the patch must match `src/packs.mjs`'s
  argv, the patch must contain no hard-coded local paths, and the icon must satisfy
  dsh-app-boot's four rules

## Three pitfalls we hit (so you do not)

1. **Never use `ctx.get('service')` during `apply`.** Measured: both `ctx.get('webServer')` and
   `ctx.get('commands')` return `undefined` while a plugin is applying, so an
   `if (svc?.register)` guard **silently** skips the registration — everything looks fine at
   install time and you only discover the 404 (or a slash command that does not exist) when you
   click. Declare optional services with `ctx.inject([...], (c) => …)`; `ctx.get` is only safe
   at **request-handling time**, when the context is fully assembled (for example reading
   `connection`).
2. **The icon not filling the card is not your problem.** The Host's `PackageArtwork` always
   renders `<img width=size height=size>` with `CARD_ARTWORK_SIZE = 36` (`ROW_ARTWORK_SIZE = 30`
   for component rows) inside a 48×48 card, so that ring of whitespace is Host layout. Editing
   the icon file cannot change it.
3. **Permission state has three values, not two.** In Peekaboo's JSON the permission name lives
   in the **value**'s `name` field
   (`{ data: { permissions: [ { name, isRequired, isGranted } ] } }`), not in an object key;
   looking it up by key never matches and reports all three as `unknown`. And `unknown` **must
   never** be reported as "not granted" — an early revision did exactly that. Now `missing`
   contains only `denied`, while `unknown` gets its own "cannot read" report. Also,
   `Event Synthesizing` is a derived capability (TCC has no switch for it; it follows
   Accessibility), so it only reports state and never enters `missing` — otherwise it sends
   people hunting for a switch that does not exist.

## Icon assets

- `icon.png` — the icon the plugin actually uses: **transparent background**, only the arrow
  subject itself, cropped tight to the artwork bounds, 256×256, 47 KB (`dsh-app-boot`'s ceiling
  is 256 KiB).
- `assets/icon-transparent.png` — a 768×768 master of the same artwork for reuse or re-export.
- Both are RGBA with alpha 0 in the corners, so they show no white box on dark or light
  backgrounds. Remember the Host still scales the image to 36×36; that ring is layout, not a
  white border inside the file.

## Known limitations

- The `computer` pack is macOS-only; on other platforms the report marks it unsupported rather
  than pretending it works.
- `repair` pulls packages with `npx -y`, so the first run can be slow; a timeout is reported
  explicitly with a "just retry" hint.
- Permission reading depends on the Peekaboo CLI's output. If that format changes, the state
  degrades to `unknown`; the report never guesses.
- The health check only verifies "the MCP server connects and its tools are there". It does not
  verify that a particular action succeeds — that depends on page content and the current
  foreground window, which are runtime facts.
