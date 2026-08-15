# 01 — goal.ts modularization target

type: grilling
blocked by: —
claimed: spec-author (2026-07-25) — resolving into the hardening spec (covers 01 + 02)

## Question

How deep should `src/goal/goal.ts` (≈1485 lines) be split? It is currently a
god-file mixing: type defs, inlined `isContextOverflow`, **module-level
mutable state** (`activeGoal`, `continuationPending`, `goalRecovery`,
`staleGoalToolCallsBlocked`, `statusRefreshTimer`, …), the `goal_complete`
tool, `/goal` command parsing, prompt templates, persistence (`appendEntry` +
legacy JSON), token tracking, and the `agent_end` recovery orchestrator. It
has **no test-reset seam** (contrast `todo/state/store.ts` `__resetState()`),
so the core loop path is barely tested.

The reference splits its equivalent into 5 pure, dep-free modules
(`goal-loop-core`, `-shield`, `-backoff`, `-display`, `-forever`) precisely so
the logic is unit-testable without pi. But the reference has **3 loop
variants** sharing one state machine — core-task has **1** goal loop, so a
5-way split may be over-engineered.

### Recommendation

**Medium split** — extract the already-pure-ish pieces into modules and add a
test seam, but keep the `agent_end` orchestrator cohesive (do not split merely
to mirror the reference's 5 files):

- `goal/state.ts` — the `ActiveGoal` type + status machine + a
  `__resetGoalState()` test seam wrapping the module-level `let`s behind a
  small state object.
- `goal/overflow.ts` — the inlined `isContextOverflow` + `Usage` /
  `AssistantMessageLike` + `findFinalAssistantMessage` (pure, directly
  testable).
- `goal/prompts.ts` — `buildGoalPrompt` / `buildContinuePrompt` /
  `buildGoalSystemPrompt` / persistence-rules text (pure).
- `goal/persistence.ts` — `persistGoal` / `loadGoalFromSession` / legacy JSON
  (fs-coupled; test via temp dir like `plan/coordinator.ts`).
- `goal/commands.ts` — `parseCommand` / `tokenize` / `parseTokenBudget` /
  `validateObjective` / arg completions (pure — several already exported for
  tests).
- `goal/goal.ts` — the thin orchestrator: tool def + `/goal` registration +
  lifecycle hooks + the `agent_end` loop. Imports the modules above.

Keep `isGoalActive` + the `globalThis.__piGoalActive` publish exactly where
they are (the seam contract). Goal: `goal.ts` shrinks to the orchestrator;
pure logic gets the test coverage the reference has.

### What this ticket resolves

The split *shape* (medium vs full-5 vs minimal-extract-only). Once decided,
this ticket closes and a `writing-plans` execution plan does the refactor
behind TDD.

### Prototype (optional, to react to)

If the medium-split shape is hard to visualize, the resolution can include a
one-page module-layout sketch (file tree + one-line responsibility each) as
the artifact to react to before committing.

## Resolution

Decided 2026-07-25 (spec review): **medium split** (D1). The 8-file layout in
`bun-apps/pi-agent-ext-core-task/docs/2026-07-25-goal-loop-hardening.md` §2 —
`state / overflow / prompts / persistence / commands` (pure) + `backoff /
repetition` (T02) + `goal.ts` orchestrator. Test seam `__resetGoalState()`
mirrors `todo/state/store.ts`. `isGoalActive` + `globalThis.__piGoalActive`
stay in `goal.ts` (seam contract unchanged). Handed to writing-plans for the
refactor behind TDD.

status: closed
