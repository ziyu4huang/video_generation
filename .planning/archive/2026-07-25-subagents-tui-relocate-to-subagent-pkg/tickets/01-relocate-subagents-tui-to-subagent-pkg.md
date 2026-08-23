---
type: task
blocked by: []
status: closed
resolved: 2026-07-25 (PR #821)
---

# 01 — Relocate `/subagents` TUI into `pi-agent-ext-subagent` (self-contained)

## Goal

Move ALL subagent presentation out of `pi-agent-ext-workflow` into `pi-agent-ext-subagent` so the latter is self-contained:

- `src/subagent-viewer.ts`, `src/subagents-command.ts`, `src/subagent-progress-widget.ts` (+ their tests)
- the shared agent-row display helpers (extracted from workflow's `display.ts`)
- the `/subagents` command registration + the progress-widget install (from `workflow.ts` → `extensions/subagent.ts`)

After this, `grep -rn "subagent-" bun-apps/pi-agent-ext-workflow/{src,extensions,tests}` returns nothing, and both packages build + test green. (PR #819 — the flicker fix — already merged `2026-07-25` as `a9105464`; unblocked.)

## Decisions applied (grilled 2026-07-25)

- **Helpers → subagent-ext**: extract `ActivityRow`/`activityGlyph`/`renderActivityRow`/`shortModel`/`fmtCost`/`fmtTokensShort`/`shorten`/`preview`/`ThemeLike` into `pi-agent-ext-subagent/src/agent-row-display.ts`, re-export from its index. `workflow/src/display.ts` re-imports them from `@repo/pi-agent-ext-subagent`; keeps the `WorkflowMeta`-dependent symbols in place.
- **Registry ownership — already correct**: `getSubagentInFlightRegistry` is DEFINED in subagent-ext; `extensions/subagent.ts` already does `const inFlight = getSubagentInFlightRegistry()`. The moved command + widget use this LOCAL `inFlight`. No new wiring, no second registry.
- **Module-identity quirk disappears**: workflow currently imports the registry via the `@repo/pi-agent-ext-subagent/src/index.ts` (literal `.ts`) SRC-subpath to share one module instance. Once the command lives in subagent-ext, it uses local `inFlight` — that cross-package SRC-subpath import is no longer needed for this.

## Steps

1. **Extract helpers** → `pi-agent-ext-subagent/src/agent-row-display.ts`; re-export from `src/index.ts`. Signatures identical (drop-in).
2. **Re-import in workflow** `src/display.ts`: replace local helper defs with `import { ... } from "@repo/pi-agent-ext-subagent"`; KEEP `WorkflowSnapshot`/`renderWorkflowLines`/`statusIcon`/`create*WorkflowDisplay`/`WorkflowAgentStatus`/`WorkflowAgentSnapshot`/`WorkflowDisplay*` (depend on `WorkflowMeta`).
3. **Move 3 TUI files** → `pi-agent-ext-subagent/src/`: `subagent-viewer.ts`, `subagents-command.ts`, `subagent-progress-widget.ts`. Fix imports (helpers now local; `Theme` from pi-coding-agent; `Key`/`matchesKey`/`truncateToWidth` from pi-tui).
4. **Move `/subagents` registration + widget install** from `extensions/workflow.ts` → `extensions/subagent.ts`: add `pi.registerCommand("subagents", createSubagentsCommand({ subagentInFlight: inFlight }))` and `installSubagentProgressWidget(ctx.ui, { registry: inFlight })` inside subagent-ext's `session_start`. Remove both from `workflow.ts`.
5. **Clean up workflow**: drop moved symbols from barrel exports (`src/index.ts`) + the `import { createSubagentsCommand }`/`installSubagentProgressWidget` lines in `workflow.ts`.
6. **Move the tests** → `pi-agent-ext-subagent/tests/`: `subagents-command.test.ts`, `subagent-viewer.test.ts`, `subagent-progress-widget.test.ts`. Keep the fake-context harness working.
7. **Build + lint both packages**: `bun run build` + `bunx biome check` in `pi-agent-ext-workflow` and `pi-agent-ext-subagent`.

## Verification

- `bun run build` (tsc) in BOTH packages.
- `bun test` green in both (subagent tests move with the code; workflow's remaining suite stays green).
- `grep -rn "subagent-viewer\|subagents-command\|subagent-progress-widget\|installSubagentProgressWidget\|createSubagentsCommand" bun-apps/pi-agent-ext-workflow/` → no references remain (doc comments excepted).
- Manual: `/subagents` opens/lists/follows/esc (no regression; flicker fix #819 still holds); the below-editor progress line still appears for a running subagent.

## Pitfalls

- `display.ts` is imported by ~9 workflow files — extracted helpers must keep IDENTICAL signatures so the re-import is a drop-in (no workflow-UI behaviour change).
- **Don't forget the widget install call** — easy to move the file but leave `installSubagentProgressWidget(...)` in `workflow.ts` session_start (then the below-editor line vanishes silently). Step 4 moves BOTH the registration AND the install.
- The moved `SubagentViewer` class: tests in the SAME package can use a normal relative import — but if the TS "two distinct class declarations" (src `.ts` vs dist `.d.ts`) trap resurfaces, fall back to the SRC-subpath import convention.

## Resolution (2026-07-25, PR #821)

Executed as planned. 13 files changed across both packages: 3 TUI files + 4 tests moved into `pi-agent-ext-subagent`; generic helpers extracted to the new `src/agent-row-display.ts` (self-contained `ActivityStatus` union — workflow's `WorkflowAgentStatus` is a subset, assignable); `/subagents` command registration + progress-widget install moved into `extensions/subagent.ts` using the local `inFlight` singleton.

- **Strategy A chosen** (display.ts as single re-import/re-export point): only `display.ts` + `workflow.ts` changed in workflow's non-moving code — all other workflow consumers (task-panel, workflow-ui, workflow-manager, index) untouched.
- **Verification**: tsc green both packages; tests `pi-agent-ext-subagent` 252/252 + `pi-agent-ext-workflow` 1043/1043, 0 fail; `bun run check` exits 0.
- **Note**: 8 biome warnings moved with the files (pre-existing — workflow's count dropped 41→33); left as-is to keep the move reviewable.
- **Caught during execution**: a 4th test (`install-subagent-progress-widget.test.ts`) and `activityGlyph` (dropped from display.ts's initial re-export list) — both fixed.
