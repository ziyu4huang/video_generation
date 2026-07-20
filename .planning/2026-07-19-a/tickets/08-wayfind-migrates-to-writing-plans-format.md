---
type: task
status: closed
closed: 2026-07-20 (#724)
blocked by: 03
---

# 08 — wayfind migrates plan output to writing-plans format

## Question

Migrate wayfind's plan artifacts from the `task_plan.md` phase-spine format to the canonical **writing-plans format** (`# [Feature] Implementation Plan`, `**Goal:**`, `### Task N — [NN-slug]`, `- [ ] **Step N:**`), per [02](02-unified-coordination-layer.md)'s convergence decision? Concretely: `/wayfind seed` + `buildPlanSeed` / `seedPlan` (`src/grill.ts`, `src/chain.ts`) emit writing-plans-format plans where **Task ≡ phase** and each Task header carries the `[NN-slug]` ticket reference (so `/wayfind sync`'s close loop survives); rewrite `tests/plan-seed-contract.test.ts` to pin the writing-plans tokens instead of `### Phase` / `**Status:**`.

### Context

- [02](02-unified-coordination-layer.md) settled: writing-plans format canonical; wayfind adjusts; Task≡phase preserves the `__piPlanPhases` reader model.
- `plan-seed-contract.test.ts` currently pins `### Phase` / `**Status:** pending` / `# Task Plan` — these BREAK and must be re-pinned to `### Task` / `- [ ]` / `# [Feature] Implementation Plan`.
- wayfind is repo-owned → free to adjust (no invariant constraint, unlike superpowers).
- The wayfind↔ticket close loop (`/wayfind sync` reads `__piPlanPhases` `ticketIds`) needs each Task header to carry `[NN-slug]`.
- `chain.ts`'s `findTicketByPhaseHeader` (accepts bare id `03` or stem) → adapts to find-by-Task-header.

## Resolution — DONE (2026-07-20, #724)

wayfind's three producers (`flattenTicketsToPlan`, `seedFromDecisions`, `buildPlanSeed`) now emit canonical writing-plans format: `### Task N — [NN-slug]` + `- [ ]` steps, `# Implementation Plan` + `**Goal:**` inline. **Dropped `**Status:** pending`** — `parse.ts` derives status from step completion, never reads it. The `[NN-slug]` stem already matched `parse.ts`'s `TICKET_RE` + `findTicketByRef`, so the close-loop round-trip survived unchanged (the ticket's `findTicketByPhaseHeader` note was a misnomer — the real resolver `findTicketByRef` operates on the `ticketIds` parsePlan captures from the Task header, so it needed no change).

Re-pinned `plan-seed-contract.test.ts` + fixed `commands/chain/grill` assertion tests + README. New e2e (`chain.test.ts`): `flattenTicketsToPlan` output → `parsePlan` → ticketIds + status — proves **wayfind-generated** plans feed the loop (TB6 verified only hand-authored). 145 pass, biome clean, tsc exit 0.

**Frontier now: 04 (yield/timing design — TB5b) + 05 (multi-plan, deferred).**
