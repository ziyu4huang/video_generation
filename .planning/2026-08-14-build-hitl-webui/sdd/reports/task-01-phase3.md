# Task 1 Report — HITL-webui Phase 3: Declarative-Controls Toolbar (zk-spawn)

**Branch:** `hitl-webui-phase3` (from `origin/main`)
**BASE:** `c392bf28dc86d92b9b9b33cdb4947d5520539f9c`
**HEAD:** `820a84b6f5bc8709f10608548989bf68fadb2c1f`

## Committed paths (2 modified + 1 deleted, verified via `diff --cached`)

- Modified: `bun-apps/pi-agent-ext-webui/src/render-shell.ts`
- Created: `bun-apps/pi-agent-ext-webui/tests/render-shell-controls.test.ts`
- Deleted: `bun-apps/pi-agent-ext-webui/tests/render-shell-feedback.test.ts`

Plan file `.planning/.../plan-phase3.md` skipped from `git add` per task instructions — already tracked+committed on `origin/main` (PR #1307), not dirty.

## Per-edit summary (steps 3a–3h)

- **3a** Module doc: appended presentId auto-focus + declarative-toolbar bullets (plan-verbatim).
- **3b** CSS: dropped dead `.webui-result` rules; added `:hover:not(:disabled)`, `:disabled`, `.webui-chosen`, `.webui-tweak` styles (plan-verbatim).
- **3c** Log header: `steer log` → `response log` (ids untouched).
- **3d** `renderView` tail: `attachFeedbackToolbars(contentEl)` removed; `renderControls(v);` rides after both branches.
- **3e** SSE handler: added non-active-view presentId probe via `/api/view/:id` → `activeId = data.viewId; location.hash = data.viewId`; payload shape `{viewId, updatedAt}` unchanged.
- **3f** Replaced the whole #03 prototype block (old WS const, `logSteer`, `sendSteer`, `basenameOf`, `attachFeedbackToolbars`) with `connectWs`/`scheduleWsRetry` (2s guarded backoff), `logResponse`, `sendAppexecResponse`, `respondedPresent`, `renderControls` (takesInput → tweak input, one-response-per-presentation disable+chosen marking).
- **3g** Exports: removed `STEER_FRAME`/`APPROVE_TEXT`/`REGENERATE_TEXT`; added `APPEXEC_FRAME` (omits `tweak` on undefined **and** empty string).
- **3h** IIFE tail (clear-link wiring) verified intact — the 3f deletion boundaries did not swallow it.

## Red/green evidence

- **Red:** `bun test tests/render-shell-controls.test.ts` → 1 fail (import error: `Export named 'APPEXEC_FRAME' not found`), as the plan predicted.
- **Green:** same command after edits → **13 pass, 0 fail**, 48 expect() calls.

## Gates

`( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun run test )`
→ `tsc --noEmit` exit 0; build exit 0; **273 pass / 0 fail** across 24 files (includes untouched `render-shell.test.ts` + `render-routes.test.ts` contract guards, plus wiring-live-smoke suite).

## Deviations

1. **Plan-verbatim defect fixed:** the plan's 3f paste block contains backticks (`` `extra` ``) in the inline comment `// frames (protocol.ts: AppExecCommandSchema keeps \`extra\` loose; ...)` — a backtick inside the `RENDER_SHELL_HTML` template literal breaks the TS string (build error `Expected ";" but found "extra"`). This directly violates the plan's own Global Constraint ("never a backtick or `${` inside the template literal"). Replaced with single quotes: `'extra'`. No semantic change; all other content is plan-verbatim.
2. Plan file omitted from `git add` — per task instruction (see above).

No other deviations. Preserved files (`?? .planning/zk-spawn/`, `?? history.txt`) untouched.
