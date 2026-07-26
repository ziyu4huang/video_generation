# Wayfinder map: 2026-07-25-subagents-tui-relocate-to-subagent-pkg

## Destination

Make `pi-agent-ext-subagent` **self-contained** for all subagent presentation: own the `/subagents` viewer + command + the below-editor progress widget + their tests + the `/subagents` command registration, plus the shared agent-row display helpers. After this, `pi-agent-ext-workflow` has **zero** subagent-presentation code and no longer reaches across packages for subagent data. Ends when the relocation PR merges and both packages build + test green.

## Notes

- **Why move**: the viewer/command currently reach ACROSS packages to import all their data from `@repo/pi-agent-ext-subagent`. GUI + data co-locate; the dependency was backwards.
- **Reverse coupling is already zero** (verified 2026-07-25): `pi-agent-ext-subagent` has NO code import from `pi-agent-ext-workflow` (only doc comments mention it). The move won't drag workflow in.
- **`display.ts` is mixed but cleanly splittable** (verified): generic helpers (`ActivityRow`, `activityGlyph`, `renderActivityRow`, `shortModel`, `fmtCost`, `fmtTokensShort`, `shorten`, `preview`, `ThemeLike`) depend only on `ThemeLike` + primitives — NOT on `WorkflowMeta`. The workflow-specific types (`WorkflowSnapshot`/`renderWorkflowLines`/`statusIcon`/`createWidgetWorkflowDisplay`…) depend on `WorkflowMeta` and STAY.
- **Blast radius** (verified): exactly 3 subagent-TUI files in workflow (`subagent-viewer.ts`, `subagents-command.ts`, `subagent-progress-widget.ts`) + 2 tests + the `workflow.ts` registration/install calls. Nothing else in workflow depends on them.
- **Target is ready**: `pi-agent-ext-subagent/extensions/subagent.ts` already constructs `inFlight = getSubagentInFlightRegistry()` and has `session_start` + `before_agent_start` hooks with `ctx.ui` — drop-in home for the command + progress widget.
- **Skills every session should consult**: `writing-plans` (this is now plan-sized, not foggy) + `test-driven-development` for the move.
- **Convention**: project decisions live here in `.planning/` (wayfinder), not the `memory` tool.
- Conversational language: 繁體中文; all written artifacts: English.

## Decisions so far

- **Ship fix in-place, relocate separately** — PR #819 (flicker fix) **merged 2026-07-25** (squash, `a9105464`) as its own PR; this relocation is the dedicated follow-up.
- **Q1 — shared helpers → `pi-agent-ext-subagent`** (grilled 2026-07-25): the generic display helpers move INTO subagent-ext (new module, re-exported from its index); `pi-agent-ext-workflow/src/display.ts` replaces local defs with re-imports from `@repo/pi-agent-ext-subagent`. Direction is already workflow→subagent (workflow already imports `AgentHistoryEntry`/`WorkflowErrorCode` from it), so no new dependency. Rejected: a new neutral `pi-agent-ext-ui-shared` package (overkill for ~9 small helpers) and inline duplication (DRY break).
- **Q2 — progress widget moves too** (grilled 2026-07-25): `subagent-progress-widget.ts` (+ test) relocates with the viewer/command for TRUE self-containment. `workflow.ts`'s `session_start` loses its `installSubagentProgressWidget(...)` call; `subagent-ext`'s `session_start` gains it (using the local `inFlight`).
- **Fog cleared → execution-ready**: with Q1 + Q2 resolved, the remaining work is mechanical (move files, extract helpers, re-wire imports/registration, move tests, build+test both packages). This is now **plan-sized**, not a foggy map — [01](tickets/01-relocate-subagents-tui-to-subagent-pkg.md) is the execution ticket.
- **01 executed → PR #821** (2026-07-25): relocation complete. 13 files across both packages; strategy A (display.ts as the single re-import/re-export point) kept workflow's other consumers untouched. tsc + 1295 tests green (252 + 1043); biome exits 0 (8 pre-existing warnings moved with the files). **Map complete — frontier clear.**

## Out of scope

- **New neutral `pi-agent-ext-ui-shared` package** — ruled out by Q1; the helpers aren't worth a dedicated package yet. Re-opens only if a 3rd consumer appears or the helpers grow substantially.
