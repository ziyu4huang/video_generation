# Spec — subagent-tool.ts full split

- **Effort**: `2026-08-10-subagent-tool-split`
- **Date**: 2026-08-10
- **Status**: Done (shipped #1207)
- **Package**: `bun-apps/pi-agent-ext-subagent`
- **Related**: `2026-08-10-simplify-recent-code` (sibling; Phase 2 targets `pi-agent-ext-workflow` — different package, zero collision)
- **Precedent**: [ADR-0002](../../bun-apps/pi-agent-ext-subagent/docs/adr/0002-relocate-viewer-command-to-subagent.md) (extract a pure helper to a sibling module to break a cycle)

## Context

A complementary, collision-free refactor to run alongside the parallel session's `simplify-recent-code` Phase 2 (which targets `pi-agent-ext-workflow/src/workflow.ts`). Three active parallel sessions own: `pi-agent-ext-workflow/*`, `pi-agent-ext-knowledge-card/*` (knowledge-pipeline Phase-2, branch `feat/kp-phase2-08-planning-card`), and `pi-agent-ext-hermes-memory/*` (hermes-deepening). The only large-file targets outside those zones are `pi-agent-ext-subagent/src/subagent-tool.ts` (1047) and `pi-agent-ext-core-task/src/goal/goal.ts` (1534).

Structural analysis + the deletion test chose `subagent-tool.ts`: it has a textbook seam (16 stateless render functions + a schema block cleanly separable from a 387-line `createSubagentTool` factory), direct unit coverage in a 1836-line test, and ADR-0002 precedent. `goal.ts` is already factored down to 18 sibling modules — further extraction **moves** complexity rather than **concentrating** it (diminishing returns, deferred).

## Goal

Split `subagent-tool.ts` (1047 lines) into an **orchestration-only** module + three focused siblings, behavior-preserving, mirroring the outcome Phase 2 targets for `workflow.ts`.

The file's length is **not** complex logic — it is near-duplicate object literals (two ~22-field `persistence.save` literals sharing ~12 fields + a 4× `requestedModel`/`fellBack` idiom; two ~12-field `details` literals) and one 48-line `spawn({...})` config with 3 inline closures. The split extracts pure builders that collapse those duplicates.

## Non-goals

- No behavior change (strict behavior-preserving; the DRY fold in 2b must be observationally identical).
- No public API change — `createSubagentTool`, `subagentToolSchema`, `SubagentToolDetails`, `SubagentToolOptions`, and the package's `index.ts` re-exports stay stable.
- No change to the `inFlight`/`persistence` singletons or the `src/` subpath module-identity contract (CONTEXT.md).
- Not touching `subagents-tool.ts` logic (the `/subagents` viewer) — only its import source paths.
- `goal.ts` and other deferred large files remain out of scope.

## Current state (verified 2026-08-10, `subagent-tool.ts` 1047 lines)

| Block | Lines | Notes |
|---|---|---|
| `interface SubagentToolDetails` | 37 | |
| `DEFAULT_TIMEOUT_MS` | 101 | |
| `export const subagentToolSchema` | 103 | TypeBox schema |
| `interface SubagentToolOptions` | 202 | the 11 dependency-injectable deps |
| `function isSchemaShaped` | 238 | schema guard |
| **Render cluster** (pure, args→string) | 243–658 | `taskPreview`, `workIntentPreview`, `describeLastActivity`, `firstNonEmptyLine`, `truncateEnd`, `latestMessageLine`, `formatSubagentProgress`, `formatHistoryLine`, `formatSubagentLive`, `formatSubagentTrace`, `renderSubagentCall`, `STREAMING_EXPANDED_TAIL`, `capTraceTail`, `renderSubagentResult`, `deriveSubagentStatus`, `formatSubagentResult` |
| `export function createSubagentTool` | 660–1047 | factory + `execute` (L698–1023) + `renderCall`/`renderResult` delegates |

`execute` internal phases (L698–1023): A preamble → B agentType resolution → C schema-shape guard → D worktree setup → E commit-scope baseline → F watchdog baseline → G model/display resolution → H abort-controller + `inFlight.start` → I spawn + streaming (try opens L825) → J abort detection → K scope-check → L result formatting → M watchdog review → N details assembly → O persistence → P normal return → Q finally teardown.

## Target architecture

| Module | ~Lines | Contents |
|---|---|---|
| `subagent-tool.ts` | ~250 | **Orchestration only**: `createSubagentTool` + thin `execute` (validation gates B/C, worktree setup D, try/finally lifecycle H–Q with the spawn call I + abort detection J, delegate to builders, teardown Q) + `renderCall`/`renderResult` delegates |
| `subagent-tool-schema.ts` | ~210 | `SubagentToolDetails`, `DEFAULT_TIMEOUT_MS`, `subagentToolSchema`, `SubagentToolOptions`, `isSchemaShaped` |
| `subagent-tool-render.ts` | ~420 | the 16 pure render/parse functions + `STREAMING_EXPANDED_TAIL` (current L243–658) |
| `subagent-tool-run.ts` | new | `RunContext`, `RunProgress` types + builders: `buildRunRecord`, `buildDetails`, `buildSpawnOptions`, `resolveDisplayModel`, `captureCommitBaseline`, `captureWatchdogBaseline`, `runScopeCheck`, `augmentOutputWithScopeViolation`, `runWatchdogReview` |

### State threading

- **`RunContext`** (immutable, built in the preamble): `{ t0, runCwd, spawnCwd, worktree?, toolCallId, params, agentDef?, modelCtx }` where `modelCtx = { requestedModel, tier, capability, mainModel, displayModelBeforeResolve }`.
- **`RunProgress`** (mutable box): `{ resolvedModel, fellBack, lastHistory, maxToolCallsSeen }`. Written **only** from the three spawn closures (`onModelResolved`/`onModelFallback`/`onHistory`), which stay inline in `execute`. Read in phases J/N/O.

### Builder responsibilities (the DRY fold)

- **`buildRunRecord(ctx, progress, delta)`** where `delta = { status, output, result, history?, scopeCheck?, watchdogResult? }` — unifies the aborted save literal (L897–914) and the normal save literal (L994–1017). The `requestedModel: fellBack ? (requestedModel ?? undefined) : undefined` / `fellBack: fellBack || undefined` idiom (currently 4×) lives here once.
- **`buildDetails(result, modelCtx, progress, { scopeCheck, watchdogResult, elapsedMs, startedAt })`** — phase N (L970–988). Pure.
- **`buildSpawnOptions(ctx, progress, callbacks, deps)`** — phase I's spawn config (L838–886). Returns the options object; the 3 closures are passed in (they mutate `progress`).
- **`resolveDisplayModel(requestedModel, capability, tier, mainModel)`** — phase G L792 derivation.
- **`captureCommitBaseline(scope, spawnCwd, runCwd, gitOps)`** + **`runScopeCheck(scope, spawnCwd, runCwd, baseCommit, gitOps)`** — phases E + K, preserving the swallow-to-`undefined` pattern.
- **`captureWatchdogBaseline(spawnCwd, watchdogParam)`** + **`runWatchdogReview(watchdogOpts, watchdogBaseline, spawnCwd, taskLabel)`** — phases F + M, preserving the swallow-to-`undefined` / swallow-to-output-line patterns.
- **`augmentOutputWithScopeViolation(output, scopeCheck)`** — phase L string append.

## Phasing

### 2a — clean moves (zero behavior change)
1. Create `subagent-tool-schema.ts`: move `SubagentToolDetails`, `DEFAULT_TIMEOUT_MS`, `subagentToolSchema`, `SubagentToolOptions`, `isSchemaShaped` (L37–241) verbatim.
2. Create `subagent-tool-render.ts`: move the 16 pure fns + `STREAMING_EXPANDED_TAIL` (L243–658) verbatim.
3. In `subagent-tool.ts`: replace the moved code with imports from the two new siblings; `createSubagentTool` and `execute` unchanged line-for-line.
4. Re-point the 3 cross-module consumers (see below).
5. Gate: `bun run test` green; the 1836-line `subagent-tool.test.ts` passes byte-identical (no test change).

### 2b — builder extraction + DRY fold (test-gated)
1. Create `subagent-tool-run.ts` with `RunContext`, `RunProgress`, and the builders.
2. Refactor `execute` to thread `RunContext`/`RunProgress` and call the builders, folding the two save literals through `buildRunRecord` and the two details literals through `buildDetails`. The spawn config moves behind `buildSpawnOptions`.
3. Add unit tests for each pure builder (`tests/subagent-tool-run.test.ts`): `buildRunRecord` (both status paths), `buildDetails`, `buildSpawnOptions`, `resolveDisplayModel`, the capture/scope/watchdog helpers.
4. Gate: `bun run test` green; existing tests unchanged in behavior; new builder tests pass.

### 2c — finalize
1. Confirm `execute` is orchestration-only (~250 lines), `subagent-tool.ts` total ~250.
2. Full gate: `bun run test`.

## Public API stability

`bun-apps/pi-agent-ext-subagent/src/index.ts` re-exports (L134–135) — the package's public surface for this tool, **must stay stable**:
```ts
export type { SubagentToolDetails, SubagentToolOptions } from "./subagent-tool.js";
export { createSubagentTool, formatHistoryLine } from "./subagent-tool.js";
```
After the split, `index.ts` re-points sources (same exported names, different source files):
```ts
export type { SubagentToolDetails, SubagentToolOptions } from "./subagent-tool-schema.js";
export { createSubagentTool } from "./subagent-tool.js";
export { formatHistoryLine } from "./subagent-tool-render.js";
```

## Consumer re-pointing (2a)

| Consumer | Symbols | Current source | After |
|---|---|---|---|
| `subagent-context-widget.ts` (L35) | `capTraceTail`, `formatSubagentTrace`, `latestMessageLine`, `renderSubagentCall`, `STREAMING_EXPANDED_TAIL` | `./subagent-tool.js` | `./subagent-tool-render.js` |
| `subagents-tool.ts` (L21) | `DEFAULT_TIMEOUT_MS` | `./subagent-tool.js` | `./subagent-tool-schema.js` |
| `subagents-tool.ts` (L21) | `deriveSubagentStatus`, `taskPreview`, `workIntentPreview` | `./subagent-tool.js` | `./subagent-tool-render.js` |
| `index.ts` (L134–135) | as above | `./subagent-tool.js` | split across schema/render/orchestrator |

## Hard invariants (preserve exactly)

- **L754 ordering**: worktree setup runs **before** the try (L825) — a throw there exits `execute` with no `inFlight.end` and no teardown (correct, since `inFlight.start` hasn't run and `worktree` is `undefined`).
- **try/finally L825→1022**: phase H (`inFlight.start`) and phase Q (`inFlight.end` + `teardownWorktree`) stay coupled, bracketing I–P.
- **Four swallow patterns**: `headCommit` (E), `computeBaseline` (F), `computeScopeCheck` (K) swallow to `undefined`; `runWatchdog` (M) swallows to a `watchdog-error:` output line with `watchdogResult` staying `undefined`; the `onHistory` body (I) swallows silently so a TUI re-render throw never fails the run.
- **Abort predicate**: `childAc.signal.aborted && !signal?.aborted` (L893) — distinguishes child abort (timeout) from parent abort (Esc).
- **Four early returns**: unknown agentType (L734), invalid schema (L745), aborted (L915–928), normal completion (L1018).
- **Module identity**: the render/schema/run siblings carry no singletons; the `inFlight`/`persistence` singletons and the `src/` subpath contract (CONTEXT.md) are untouched.

## Verification gates

Per-change (in `bun-apps/pi-agent-ext-subagent`):
- Fast: `bun run typecheck` (`tsc --noEmit`)
- Comprehensive: `bun run test` = `biome check .` + `tsc` (build) + `bun test`

Note: this package's `check` script is `biome check .` (lint+format), **not** `tsc` — use `typecheck`/`build` for type validation. The 1836-line `tests/subagent-tool.test.ts` exercises the full `execute` lifecycle via injected fakes (`spawn:`/`createWorktree:`/`agentRegistry:`/`inFlight:`/`persistence:`/`gitOps:`) — it is the primary behavior-preservation oracle and must pass unchanged in 2a.

Repo-wide: after merge, confirm no downstream package broke (the public re-exports are stable, so `pi-agent`/`pi-agent-cli` consumers should be unaffected — verify with their `typecheck`).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| 2b DRY fold changes observable save/details output | `buildRunRecord`/`buildDetails` tested on **both** status paths; byte-compare the produced literals against the originals before deleting them |
| Threading `RunProgress` mutably across module boundary reads awkwardly | Keep the 3 spawn closures **inline** in `execute` (sole mutation site); `RunProgress` is a plain object passed by reference, not a state machine |
| Phase H/Q coupling broken by extraction | H and Q stay in the orchestrator; only the pure/IO phases (E/F/K/M + builders) move out |
| Consumer import path drift | 2a re-points all 3 consumers in the same change; the `bun run build` gate catches any miss |
| Collision with simplify Phase 1 (deferred `describeLastActivity`/`formatHistoryLine` merge) | Phase 1 is deferred, not active; the functions move to `subagent-tool-render.ts` and any future merge happens there — no conflict |

## Out of scope (deferred)

- `describeLastActivity`/`formatHistoryLine` merge (simplify Phase 1) — compatible, deferred.
- `goal.ts`, `memory-store.ts`, `ingest.ts`, `knowledge-card.ts` splits — other packages, other efforts.
- `createWorktree`/`removeWorktree` signature changes.
- Any behavior change, perf optimization, or public API change.
---