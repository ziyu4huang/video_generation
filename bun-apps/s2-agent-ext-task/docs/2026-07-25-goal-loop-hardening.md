# Goal-loop hardening — design spec

- **Package**: `bun-apps/s2-agent-ext-task/`
- **Effort**: `.planning/2026-07-25-do-as-you-suggesnt-then-continue-develop/` (tickets 01 + 02)
- **Status**: DECIDED (D1 = medium, D2 = all-three) — pending implementation plan
- **Scope**: modularize `goal.ts` (T01) + harden the `agent_end` loop driver (T02).
- **Out of scope (this spec)**: the opt-in isolated auditor (T04, separate spec, blocked on this landing); `/list` + `/loop` variants; goal-state relocation (decided against — see map Notes).

Mentor: `../pi-goal-list-loop-audit/` (read-only; learn its pure-module discipline + ported predicates).

---

## 1. Problem

`src/goal/goal.ts` is a ~1485-line god-file. Two gaps, from the review:

- **(a) Untestable.** It mixes type defs, inlined `isContextOverflow`, **module-level mutable state** (`activeGoal`, `continuationPending`, `goalRecovery`, `staleGoalToolCallsBlocked`, `statusRefreshTimer`, …), the `goal_complete` tool, `/goal` command parsing, prompt templates, persistence, token tracking, and the `agent_end` recovery orchestrator. There is **no test-reset seam** (contrast `todo/state/store.ts` `__resetState()`), so the core loop path is barely covered.
- **(b) The loop driver lacks three safeguards** the reference proved matter: a hard backoff cap, a heartbeat self-watchdog, and anti-repetition / stuck-iteration detection. core-task relies on `agent_end` always firing and the agent always yielding — both fail silently (compaction-eaten turns, dropped messages, doorknob-polishing loops).

## 2. Design A — modularize `goal.ts` (T01)

**Target layout** (medium split — decision D1):

```
src/goal/
  state.ts         # ActiveGoal type + status machine + __resetGoalState() test seam
  overflow.ts      # inlined isContextOverflow + Usage/AssistantMessageLike + findFinalAssistantMessage  (pure)
  prompts.ts       # buildGoalPrompt / buildContinuePrompt / buildGoalSystemPrompt + persistence-rules text  (pure)
  persistence.ts   # persistGoal / loadGoalFromSession + legacy JSON  (fs; tested via temp dir)
  commands.ts      # parseCommand / tokenize / parseTokenBudget / validateObjective + arg completions  (pure)
  backoff.ts       # NEW (T02) — ported pure predicates
  repetition.ts    # NEW (T02) — ported classifier + rotating interventions
  goal.ts          # thin orchestrator: tool def + /goal registration + lifecycle hooks + agent_end loop
```

**Principles**

- Pure logic → its own module with **zero pi imports**, unit-testable under plain node. Mirrors `plan/coordinator.ts`, which already separates pure `computeIncomplete`/`computeSummary` from fs.
- The module-level `let`s → wrapped behind a small state object in `state.ts`, exposing `__resetGoalState()` for tests (mirrors `todo/state/store.ts`).
- `isGoalActive` + the `globalThis.__piGoalActive` publish **stay in `goal.ts`** — the coordination-seam contract is unchanged (peer extensions read it).
- Net effect: `goal.ts` shrinks to the orchestrator (~400–500 lines); pure logic gets the unit coverage the reference has (its 168-test suite is mostly these predicates).

## 3. Design B — harden the loop driver (T02)

Port the reference's **pure, dependency-free** predicates verbatim into `goal/backoff.ts` / `goal/repetition.ts` (decision D2 — all three):

- **Hard backoff cap** — `backoffMs(stuckCount)` + `shouldPauseAfterBackoff()`, constant `BACKOFF_HARD_CAP_MS = 5 * 60 * 1000`, schedule `[0, 30s, 60s, 2m, 4m, 5m]`. Hook: when the orchestrator is about to re-send a continuation but the goal has made no progress for N iterations, wait `backoffMs(N)`; if `shouldPauseAfterBackoff` → **pause + notify** (kills the "1-hour silent wait").
- **Heartbeat self-watchdog** — `shouldHeartbeatRefire()` + `accountTurnForNudges()`, constants 15 s tick / 60 s stall / 3-nudge cap. A `setInterval` (unref'd, active only while a goal is `active`) re-fires the continuation when `supervising && idle && nothing-scheduled && quiet > 60 s`; 3 consecutive zero-tool nudges → pause. Replaces reliance on `agent_end` always firing. Predicates live in `backoff.ts` (matching the reference); stall threshold is tunable — see D2.
- **Anti-repetition / stuck-iteration** — `repetition.ts` classifies each finished iteration (exact/near-duplicate, A-B-A-B alternation, same-tool-same-result ×3, narration-only streak); on a stuck iteration, swap the next continuation prompt for a **rotating intervention** (different approach → different subtask → write a PROGRESS note → fix one test failure → review your own diff). 3-stuck → hard reset (banned openings, tool-call-first); 5-stuck → stop with reason.
- **Wedge alert (keep)** — `shouldWedgeAlert()`, 30 min. Catches the one shape turn-based watchdogs are blind to: a single unbounded command (test suite / dev server) holding the session. Notification-only.

Every threshold is a **constant in a pure module** → each one is a unit test, not a guess.

## 4. Testing strategy

- **Pure modules** (`overflow`, `prompts`, `commands`, `backoff`, `repetition`): plain-node unit tests, no pi. Target parity with the reference's coverage on these predicates.
- **`state.ts`**: status-machine transitions + the reset seam.
- **`persistence.ts`**: temp-dir tests (pattern from `plan/coordinator.ts`).
- **Orchestrator (`goal.ts`)**: preserve existing lifecycle-hook behavior; add integration tests for backoff-pause, heartbeat-refire, and repetition-intervention, all driven through `__resetGoalState()`.

Gate: `( cd bun-apps/s2-agent-ext-task && bun test )` green; `bun run typecheck` clean.

## 5. Decisions (resolved 2026-07-25)

- **D1 — split depth = `medium`.** The 8-file layout in §2. Pure modules + `__resetGoalState()` test seam; orchestrator stays cohesive.
- **D2 — hardening scope = `all three`.** Backoff cap (5 min) + heartbeat + anti-repetition + wedge alert, ported verbatim. Heartbeat kept, gated to "goal active" only; stall threshold is a plan-time tuning detail (starting point 120 s — more generous than the reference's unattended-rig 60 s, since core-task's user is usually present).

## 6. Rollout

- **Incremental, behind the existing suite.** Modularization (Design A) is a pure refactor — zero behavior change, each extraction lands with its tests. Hardening (Design B) adds new branches, each gated by a pure predicate + test, so each lands independently and is individually revertible.
- **Legacy `~/.pi/agent/pi-goal-state.json`**: finish removing as part of extracting `persistence.ts` (the `clearLegacyPersistedGoal` path already exists) — but first grep the repo + any known rigs to confirm nothing still reads it.

## 7. Non-goals (this spec)

- Opt-in isolated auditor (T04) — separate spec; blocked on this landing (it wants the clean module base).
- `/list` (queue) + `/loop` (metric-driven) variants — fog; graduate only after this lands.
- Moving goal state to `.planning/` — decided against (see map Notes).
