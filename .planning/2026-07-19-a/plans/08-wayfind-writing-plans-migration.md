---
ticket: 08
status: done
merged: PR pending
depends on: [02, 03]
---

# 08 — wayfind migrates plan output to writing-plans format

**Goal:** wayfind's three plan-seed producers emit the canonical writing-plans format that core-task's `parsePlan` consumes, so wayfind-GENERATED plans feed the coordination loop (TB6 verified only hand-authored plans).

**Architecture:** Token migration, not restructuring. `### Phase N` → `### Task N`; drop `**Status:** pending` (parse.ts derives status from `- [ ]` step completion, never reads `**Status:**`); align H1 → `# Implementation Plan` + `**Goal:**` inline. The `[NN-slug]` ticket stem already matches `parse.ts`'s `TICKET_RE` (`/\[(\d{2}-[a-z0-9-]+)\]/g`) + `findTicketByRef`, so the close-loop round-trip survives unchanged. Keep `## Settled vocabulary` (lossless glossary; parse.ts ignores it).

**Contract authority:** `pi-agent-ext-core-task/src/plan/parse.ts` — `TASK_HEADER_RE = /^###\s+Task\s+(\d+)\s*[:—-]?\s*(.*)$/`, `STEP_RE = /^-\s+\[(x| )\]\s+/i`, `TICKET_RE = /\[(\d{2}-[a-z0-9-]+)\]/g`.

## Touchpoints (grep-verified)

**Source (2):** `src/grill.ts` (`buildPlanSeed`), `src/chain.ts` (`flattenTicketsToPlan`, `seedFromDecisions`, `seedPlan`'s `phaseCount` regex).
**Tests (4):** `tests/plan-seed-contract.test.ts` (re-pin), `tests/commands.test.ts`, `tests/chain.test.ts`, `tests/grill.test.ts`.
**Docs (1):** `README.md` (the `### Phase N — [03-foo]` example).

## Tasks

### Task 1: RED contract test → migrate `buildPlanSeed` (grill.ts)
- [ ] Re-pin `plan-seed-contract.test.ts`: `### Task` (not Phase), `# Implementation Plan`, `**Goal:**`, assert `**Status:**` ABSENT.
- [ ] Migrate `grill.ts:buildPlanSeed`: H1→`# Implementation Plan — seeded from grill`, `## Goal`→`**Goal:**`, drop `## Current Phase`/`## Phases`/`**Status:**`, `### Phase 1`→`### Task 1`.
- [ ] `bun test tests/plan-seed-contract.test.ts` GREEN.

### Task 2: Migrate `chain.ts` producers
- [ ] `flattenTicketsToPlan`: `### Phase N — [id-slug]` → `### Task N — [id-slug]`; drop `**Status:**`; H1 + Goal inline; drop `## Current Phase`/`## Phases`.
- [ ] `seedFromDecisions`: `### Phase N — title` → `### Task N — title`; drop `**Status:**`; H1 + Goal.
- [ ] `seedPlan` `phaseCount` regex: `/^### Phase\b/` → `/^### Task\b/`.

### Task 3: Fix the three assertion test files
- [ ] `commands.test.ts` (lines ~135,149,313,314): `### Phase` → `### Task`.
- [ ] `chain.test.ts` (~26-28,46,65,66,76,125): `### Phase` → `### Task`.
- [ ] `grill.test.ts` (~45,48,50): H1 + assert `**Status:**` absent + `### Task`.

### Task 4: e2e — wayfind-generated plan feeds the loop
- [ ] In `chain.test.ts`: `flattenTicketsToPlan([{id:"03",slug:"foo",title:"Foo",acceptance:["do x","do y"]}])` → `parsePlan(result, src)` → assert `phases[0]` = `{id:"task-1", ticketIds:["03-foo"], status:"pending", stepCount:2, completedSteps:0}`; then check both steps in the string → re-parse → `status:"completed"` (round-trip close-loop proof).

### Task 5: README
- [ ] `README.md:58` `### Phase N — [03-foo]` → `### Task N — [03-foo]`.

### Task 6: Verify
- [ ] `bun test` (full wayfind suite) green; `bun run check` (biome — wayfind HAS the gate) green; `bun run typecheck` exit 0.
