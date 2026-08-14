# Task 5 Report — webui local channel redeclaration + bus helpers

**Status:** Complete
**Package:** `bun-apps/pi-agent-ext-webui`
**Branch:** `feat/btw-panel-in-webui`

## What was done

Implemented per the brief, verbatim TDD order:

1. **Step 1** — Wrote `tests/btw-channels.test.ts` (5 tests) exactly as specified in the brief.
2. **Step 2** — Confirmed the failing run: `Cannot find module '../src/btw-channels'` (1 fail, 0 pass).
3. **Step 3** — Wrote `src/btw-channels.ts` exactly as specified in the brief:
   - `BTW_COMMAND_CHANNEL = "webui:btw-command"`, `BTW_EVENT_CHANNEL = "btw:event"`
   - Payload types: `BtwThreadMode`, `BtwModelRef`, `BtwThinkingLevel`, `BtwCommand` (8 kinds), `BtwMessageStatus`, `BtwMessageSnapshot`, `BtwThreadState`, `BtwEvent`
   - Helpers: `isBtwEvent` (type guard), `btwCommandFromFrame` (validated frame → command, null on inconsistency), `emitBtwCommand` (webui → btw), `onBtwEvent` (btw → webui, guarded, returns disposer)
4. **Step 4** — Focused test passes: 5 pass / 0 fail.
5. **Step 5** — Full package suite: **295 pass / 0 fail** (`bun run test`, 22 files).
6. Appended `Task 5: implemented (commit pending review)` to `sdd/progress.md`.

## Architecture constraint held

**No import from `@repo/pi-agent-ext-btw` anywhere in the webui package.** The channel constants and payload shapes are deliberately redeclared locally in `src/btw-channels.ts`, mirroring the seam style used by `webui:render` / `webui:present` in `webui-wiring.ts` (string-literal channels over a minimal structural bus interface `{ emit }` / `{ on }`, no shared types package). String values will be pinned against the btw side by Task 11's contract test.

## Self-review vs brief checklist

- [x] Step 1: test file matches brief verbatim
- [x] Step 2: verified fail-first
- [x] Step 3: implementation matches brief verbatim
- [x] Step 4: focused test passes (5/5)
- [x] Step 5: commit + planning artifacts staged (`task-5-brief.md`, `task-5-report.md`, `progress.md`)
- [x] No `.agents/memory/MEMORY.md`, `history.txt`, `.planning/zk-spawn/`, or `sdd/review-*.diff` staged

## Concerns

None. The local redeclaration is intentional per the brief; drift risk is covered by Task 11's cross-package contract test.
