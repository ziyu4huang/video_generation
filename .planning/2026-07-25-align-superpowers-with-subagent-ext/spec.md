# Align superpowers instructional layer with the extracted subagent ext

> **Status:** approved 2026-07-25 · **Owner:** agent · **Follows:** `.planning/2026-07-24-extract-subagent-package/` (subagent ext extraction)

## Problem

The subagent subsystem was extracted from `pi-agent-ext-workflow` into the new
standalone package `pi-agent-ext-subagent` (subagent ADR-0001, Design B — the new
package registers the `subagent`/`subagent_runs` tools itself; workflow stopped
registering them and only reads the singletons for its `/subagents` viewer). The
extraction itself is sound — verified correct: singleton `src/`-subpath import,
load order (`pi-agent-ext-subagent` before `pi-agent-ext-workflow` in both
`pi-agent/src/static-extensions.ts` and `manifest.json staticExtensions[]`),
workflow's `extensions/workflow.ts` no longer constructs the subagent tool, and
`spawnSubagent` is re-exported from workflow root for back-compat.

But `pi-agent-ext-superpowers` (and, trivially, `pi-agent-ext-wayfind`) still
tell the agent to use the subagent capability via the **old** package. Neither
extension imports `spawnSubagent` in code (confirmed: only subagent/workflow
itself import it), so the coupling is entirely **instructional** — text that
tells the agent how to call the `subagent` tool. That text is now wrong and
under-documented:

1. **Stale attribution.** `src/superpowers.ts` `piToolMapping()` (auto-injected
   every session) says the `subagent` tool is "provided by
   `pi-agent-ext-workflow`". `skills/using-superpowers/references/pi-tools.md`
   (on-demand) says so in two places. `tests/bootstrap.test.ts:141` asserts
   `toContain("pi-agent-ext-workflow")` — the test **locks the bug in**.
2. **Two drifted sources.** The always-injected `piToolMapping()` and the
   on-demand `references/pi-tools.md` overlap but have diverged: the reference
   carries parallel-fan-out / auto-SDD-status / auto-persistence notes the
   bootstrap omits. Two sources of truth ⇒ drift.
3. **Missing `tier`.** The tool now has `tier: 'small'|'medium'|'big'`
   (resolves via `~/.pi/workflows/model-tiers.json`, `/workflows-models`) and its
   schema says "prefer `tier` over raw `model`". The byte-identical SDD skill
   still insists on an explicit raw `model:`; our Pi guidance never mentions
   `tier`. Raw model ids are non-portable across users.
4. **Under-documented param surface.** The bootstrap lists
   `task, model, tools, excludeTools, cwd, commitScope, tokenBudget, spendBudget`
   — omitting `tier`, `schema`, `schemaRepairAttempts`, `retryOnTransient`,
   `timeoutMs`, `agentType`. `schema` (structured subagent output) and
   `agentType` (named agent profiles) are the high-value omissions.

Today this is "lies but doesn't break" (both packages always co-load in this
repo). It becomes an active lie in a subagent-only host — which is Design B's
entire premise — and it contradicts the subagent ext's own README/ADR.

## Scope

`pi-agent-ext-superpowers` only. **No upstream skill-body edits** (ADR-0004);
all divergence stays at the injection layer (our `src` + `references/`).
`pi-agent-ext-wayfind` needs no change — `wayfinder/SKILL.md`'s "`workflow`
subagent" research reference is still correct post-extraction (`parallel()`/
`agent()` remain in workflow).

## Design

### Fix 1 — Stale attribution → correct package

- `src/superpowers.ts` `piToolMapping()`: `pi-agent-ext-workflow` →
  `pi-agent-ext-subagent`.
- `references/pi-tools.md`: both occurrences → `pi-agent-ext-subagent`.
- `tests/bootstrap.test.ts`: assert `pi-agent-ext-subagent`; drop "workflow"
  from the test name.

### Fix 2 — Collapse the two sources (terse bootstrap + canonical reference)

- `piToolMapping()` becomes a **terse, accurate summary** carrying only the
  directives the agent must act on every dispatch, plus an explicit deferral:
  - the `subagent` tool is provided by `pi-agent-ext-subagent`;
  - SDD implementer/fix → pass `commitScope` (the `git add -A` sweep guard);
  - **prefer `tier` over raw `model`** (portable + user-tunable; SDD roles:
    implementer `medium`, research `small`, synthesis `big`);
  - concurrent fan-out (`dispatching-parallel-agents`) → the `workflow` tool's
    `parallel()`, **not** multiple `subagent` calls in one turn (the tool is
    `executionMode: sequential` → they serialize);
  - the tool auto-parses the SDD `**Status:**` block → `details.report` and
    auto-persists each run to `~/.pi/subagents/runs/`;
  - closes with: full param surface + rationale live in `references/pi-tools.md`.
- `references/pi-tools.md` is the **single canonical full doc**: fix the package
  name and add the sections below. The bootstrap defers to it for detail.

### Fix 3 — Teach `tier` / `schema` / `agentType` (in the reference)

- **Model selection:** prefer `tier` over raw `model`; document override
  priority `model > tier > session model`; give the SDD role→tier table.
- **`schema`:** pass a JSON Schema → the child returns via `structured_output`;
  the tool result is the serialized JSON object. Use case: an SDD reviewer
  returning structured findings, or any dispatch whose result is branched on by
  field.
- **`agentType`:** named agent definition (`.pi/agents/<name>.md` /
  `~/.pi/agents/<name>.md`) binding tools/model/prompt/worktree-isolation;
  explicit `model`/`tools`/`excludeTools` on the call override the binding.
- Complete the remaining params (`commitScope`, `tokenBudget`/`spendBudget`,
  `timeoutMs`, `retryOnTransient`) — some already documented; ensure parity with
  `subagentToolSchema`.

### Fix 4 — ADR-0006: the superpowers ↔ subagent cooperation contract

New `pi-agent-ext-superpowers/docs/adr/0006-superpowers-subagent-cooperation.md`:

1. **Consumption model.** superpowers consumes the subagent capability **purely
   via the LLM tool path** — zero code import (verified: `spawnSubagent` is
   imported only by subagent/workflow). The SDD flow is agent-driven tool calls,
   not programmatic dispatch. If a future superpowers feature needs programmatic
   dispatch, import values/types from `@repo/pi-agent-ext-subagent` root; only
   the two singletons demand the `src/` subpath (N/A to superpowers today).
2. **Composable without forking.** The byte-identical SDD implementer-prompt's
   `**Status:** DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED` block is
   auto-parsed by the `subagent` tool into `details.report`. superpowers keeps
   the prompt byte-identical; the tool owns parsing. No coordination call
   needed — the parser reads the prompt's OUTPUT, never the template.
3. **Single source of truth for detail.** `references/pi-tools.md` is canonical
   for subagent usage detail; `piToolMapping()` is a terse always-present
   summary that defers to it. Both name the correct package.
4. **Divergence lives at the injection layer.** tier-over-model,
   parallel-via-workflow, and commitScope are Pi-side overrides applied in our
   `src` / `references` only — ADR-0004 (don't fork verbatim bodies) and
   ADR-0005 (parallel-coexistence boundary) compliant.
5. **Decision:** SDD dispatches prefer `tier` over raw `model` — portability,
   user-tunability, and alignment with the tool's own schema guidance.

## Verification

- `tests/bootstrap.test.ts`: assert the correct package, the `tier` directive,
  the `references/pi-tools.md` deferral pointer, and the parallel-via-`workflow`
  note; keep the existing `commitScope`/`tokenBudget`/`spendBudget` asserts.
- `( cd bun-apps/pi-agent-ext-superpowers && bun test )` — all green.
- `( cd bun-apps/pi-agent-ext-superpowers && bun run check )` — biome clean.
- `grep -rn "pi-agent-ext-workflow" bun-apps/pi-agent-ext-superpowers/{src,skills/using-superpowers/references}` —
  no subagent-related hits (only ADR-0005's historical mention remains).
- `grep -rn "pi-agent-ext-subagent" bun-apps/pi-agent-ext-superpowers/{src,skills/using-superpowers/references,tests}` —
  the new correct attribution present in all three.

## Non-goals

- No change to `pi-agent-ext-wayfind` (its single `workflow`-subagent reference
  is correct).
- No change to the subagent ext or workflow ext (extraction is sound).
- No new programmatic subagent dispatch from superpowers code (the LLM tool path
  stays the only consumption model).
- No forking of any upstream skill body (ADR-0004).
