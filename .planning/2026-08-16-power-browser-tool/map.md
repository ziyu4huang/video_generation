# power-browser-tool — effort map

## Goal

An in-process, headless-Chrome `browser` tool for power-tool. Primary consumer: webui
debugging (drive the Bun GUI, inspect rendered state) plus general code-first browsing.
Baseline: power-tool typecheck + test green on main.

**Status: done** — browser tool shipped on `feat/power-browser-tool`: headless-only
system Chrome, code-first `{code,note}`, BetterWright snapshot trio + barebrowse
pruneMode ported, D6 audit run-dirs, power_browser-gated; 191 pass / 0 fail + ci-local PASS.

## Decisions

- **D1 — headless-only, system Chrome.** `chromium.launch({ channel: "chrome", headless: true })`.
  User standing preference: browser automation MUST be headless — never steal focus or
  interrupt human windows. No headful mode, ever. If channel `chrome` is unavailable,
  return a helpful error; do NOT download browsers.
- **D2 — code-first single tool.** One `browser` tool with `{ code: string, note?: string }`
  params (mirrors BetterWright's tool-schemas philosophy), NOT a step vocabulary. Code runs
  against injected globals (`page`, `pages`, `context`, `openPage`, `closePage`,
  `snapshot`, `screenshot`).
- **D3 — port BetterWright's snapshot trio** (`filterInteractive`, `compressSnapshot`,
  `diffSnapshots`) as pure functions in `src/tools/snapshot-compress.ts`, adapted to repo
  style, MIT attribution in header. Source: /tmp/betterwright (MIT)
  https://github.com/BetterWright/betterwright
- **D4 — persistent in-process context, no daemon.** Lazy singleton browser + context,
  module-level {browser, context, pages, currentPage}; 120s idle timer closes the browser,
  next call recreates it.
- **D5 — OUT of scope:** captcha solving, stealth, vault/credentials, network proxy,
  evidence gate, browsers download, headful mode.
- **D6 — audit run-dir (webwright recon, MSR/MIT inspiration).** Every `browser` call
  carrying a `note` is recorded under `~/.pi/power-browser/runs/<sessionStamp>-<seq>/`:
  `steps.jsonl` gets one line per call `{ts, code, note, ok, resultSummary,
  screenshot?}` (lazy `mkdir -p`); default screenshots land as `shot-<n>.png` in the
  same dir. Audit = the directory itself; no daemon, no HTML report (v1).
- **D7 — `pruneMode: "act" | "read"` on snapshot()** (barebrowse recon, Apache-2.0 —
  idea attributed, own code). act = `filterInteractive`; read = keep
  paragraphs/headings/links (`filterReadable`). When act output collapses below ~5
  lines, append `hint: page looks content-heavy — try pruneMode:'read'`
  (`CONTENT_HEAVY_HINT` + `actModeHint()`).
- **D8 — gate, not core.** `power_browser` registered in `GATE_DEFS` at module load;
  the tool declares `gating: { gate: "power_browser" }` (keywords: browser, chrome,
  webui, drive the gui). Chosen over `core: true` because browsing is on-demand —
  `inspect_*` tools stay core since they are needed when things break.

## Tickets

| #   | Ticket                | Status | Result |
| --- | --------------------- | ------ | ------ |
| 01  | browser-tool          | closed | webui gates: power-tool 191/0; trio+pruneMode ported; audit dirs; MIT/Apache attributions |

## v2 ideas (deferred — do NOT build)

- **Task2UI → archify card translation** — report schema/renderer for browser
  sessions (webwright MSR, MIT audit/workspace-contract inspiration).
- **Craft library** — parameterized-tool mode for reusable browsing recipes.

## Notes

- `playwright-core@1.62.0-alpha-1783623505000` added as direct dep of
  pi-agent-ext-power-tool (pinned to `@playwright/cli@0.1.17`'s nested version; the
  nested copy does NOT resolve through the isolated linker — verified).
- Effort closed from interrupted-run `STATE.md` residue (folded as D6–D8, v2 ideas,
  and the ticket Result above); STATE.md deleted at closeout.
