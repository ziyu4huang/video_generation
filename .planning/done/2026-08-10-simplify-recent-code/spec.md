# Simplify recent code — behavior-preserving cleanup (design spec)

**Date:** 2026-08-10
**Status:** Complete — Phase 1 (PR #1205) + Phase 2 (workflow.ts extraction, PR #1193); remaining items dropped with rationale (plan-phase1.md). Archived.
**Effort:** `.planning/2026-08-10-simplify-recent-code/`
**Scope:** behavior-preserving cleanup across `pi-agent-ext-{knowledge-card,core-task,wayfind,subagent,workflow}`. Phase 1 = dedup + dead-code; Phase 2 = `workflow.ts` extraction. No behavior change.

## Problem

Recent development (PRs ~#1154–#1180) landed substantial behavior across the subagent/workflow/wayfind/knowledge-card/core-task packages. A read-only audit surfaced 40+ behavior-preserving simplification opportunities: duplicated logic, dead code, and one standout complexity hotspot — `workflow.ts:runWorkflow()` is **520 lines** (audited as the most complex function in the repo), with the stdlib, script parser, and agent/parallel/pipeline closures all inlined.

This spec scopes a cleanup pass that reduces duplication, removes dead code, and shrinks `runWorkflow` — with **no behavior change**, behind the existing test suites.

## Goal

Two phases, each a separate PR:

- **Phase 1 (quick wins):** S-effort dedup + dead-code removal across 5 packages.
- **Phase 2 (workflow.ts extraction):** extract cohesive code out of `runWorkflow` into focused modules via clean moves + a factory pattern.

Behavior preserved throughout; every package's tests stay green.

## Phase 1 — quick wins (dedup + dead code)

### knowledge-card (`pi-agent-ext-knowledge-card`)
- `harvestTagsFromContent(content, baseTags)` — merges the 3× tag-harvest loops (ingest.ts ~318-330, 558-567, 681-686).
- `stripWikiLinkBrackets(content)` — merges the 3× `[[…]]`→plain stripping (ingest.ts ~336-344, 605-613, 687-692).
- Consolidate the 7 identical tool-allowlist constants (`DISTILL_TOOLS`, `ADD_TOOLS`, `FIND_TOOLS`, `UPDATE_TOOLS`, `REMOVE_TOOLS`, `CHECK_TOOLS`, `RAG_TOOLS` — all `["obsidian","obsidian_help"]`, knowledge-card.ts ~120-134) into one `BASE_OBSIDIAN_TOOLS`, keeping the old names as backward-compat aliases.

### core-task (`pi-agent-ext-core-task`)
- `setAndPersistGoal(goal, ctx)` — merges the ~12× repeated `update → persistGoal → updateStatus` trio in goal.ts (e.g. lines ~270, 282, 312, 331, 348, 628, 826, 849, 987, 1005, 1023, 1041, 1091, 1143).

### wayfind (`pi-agent-ext-wayfind`)
- Delete the orphaned `readWayfindGrill` export (coordination.ts ~67-70) — grep-confirmed unused.
- Merge the 5 render functions' error-first guard (effort-tool.ts ~191-280) into a `renderWithErrorCheck(result, builder)` helper.

### subagent (`pi-agent-ext-subagent`)
- Merge `describeLastActivity` + `formatHistoryLine` (subagent-tool.ts ~327-404) into one function with an `includeMarker` flag.
- Extract `pairToolCallsWithResults(history)` from the duplication between `formatSubagentLive` and `formatSubagentTrace` (subagent-tool.ts ~426-503).
- Drop the unused `Text` import (subagent-tool.ts ~251-252).

### workflow (`pi-agent-ext-workflow`)
- Extract a `progress()` callback helper from the 6× repeated onProgress/emit/updateInFlight pattern (workflow-manager.ts ~628-695).
- Drop dead params: the always-default `maxRounds` on `loopUntilDry` (workflow.ts ~773-811) and the always-passed `phase` param on `defaultAgentLabel` (workflow.ts ~170).

## Phase 2 — workflow.ts extraction (shrink runWorkflow)

`workflow.ts` is 1398 lines; `runWorkflow` alone is ~520. Split into focused modules.

### 2a — clean moves (low risk)
- **`workflow-script-parser.ts`** (~250 lines): `parseWorkflowScript`, `evaluateLiteral`, `propertyKey`, `validateMeta`, `describeLeadingStatement` (workflow.ts ~975-1195). Pure AST work, no closure deps → mechanical move.
- **`workflow-timeout.ts`** (~100 lines): `runAgentWithTimeout`, `createLimiter` (workflow.ts ~1315-1398). Self-contained → mechanical move.

### 2b — factory conversion (medium risk)
- The stdlib (`verify`, `judgePanel`, `loopUntilDry`, `completenessCheck`, `retry`, `gate`) and the `agent`/`parallel`/`pipeline` closures are defined inline inside `runWorkflow` and capture runtime state (`shared`, `state`, `options`, `agentRunner`). Convert them to a `createStdlib(deps)` / `createRuntime(deps)` factory that takes the captured state explicitly, so `runWorkflow` becomes orchestration-only.
- Also consolidate the parallel-pattern duplication: `verify`/`judgePanel` share a `parallelAgents(n, labelPrefix, promptBuilder)` helper; `retry`/`gate` share an `attemptLoop(maxAttempts, body)` helper (workflow.ts ~660-871).
- Target: workflow.ts 1398 → ~700.

## Testing & verification

- Per change: `( cd bun-apps/<pkg> && bun run typecheck && bun test )`. Behavior-preserving → **tests must stay green**; no snapshot regeneration without an explicit reason.
- Add unit tests for newly-isolated pure helpers where extraction newly enables testability: `harvestTagsFromContent`, `stripWikiLinkBrackets`, `pairToolCallsWithResults`, `createStdlib`.
- Phase 2 is guarded by the existing workflow test suite (~5,300 lines across workflow-manager / -runtime / -editor / -display tests).

## Error handling / risk

- Phase 1: low risk — pure extraction and dedup, fully covered by existing tests.
- Phase 2a: low risk — mechanical moves of self-contained code.
- Phase 2b: medium risk — closure→factory conversion changes how runtime state is threaded; mitigated by the extensive workflow tests and by landing it as isolated commits (stdlib factory, then runtime factory) with green tests between each.
- Any helper that cannot be cleanly extracted is left inline and noted in the plan; no new throw paths are introduced.

## Out of scope (deferred)

- The other 5 large-file splits: memory-store.ts (1951), goal.ts (1534), ingest.ts (1641), knowledge-card.ts (1503), subagent-tool.ts (1047).
- Giant-function breakdowns beyond runWorkflow: `goalCompleteTool.execute` (298), `executeRun` (280), `retrieveRecords` (220), `agent_end` handler (180).
- Any behavior change, performance optimization, or public API change.

## Open questions

None at design time. The implementation plan will sequence Phase 1 (per-package commits) and Phase 2 (2a then 2b), each behind green tests.

## Phase 1 execution status (post-investigation)

Phase 1 was re-scoped after a code re-investigation (Phase 2 had landed, moving/stale-locating several targets). Net: only `core-task` and `knowledge-card` have clean, zero-risk Phase-1 work; the `wayfind` and `workflow` items were already-satisfied, not-actually-dead, or unsafe-to-drop, and two `subagent` items were false premises (no duplication / import is used). See `plan-phase1.md` for the reduced plan and its "Dropped items" table documenting each deviation from this spec.
