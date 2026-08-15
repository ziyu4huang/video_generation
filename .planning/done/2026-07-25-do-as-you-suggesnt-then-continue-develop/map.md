> STATUS: DONE — archived 2026-08-15 (triage verdict: goal.ts modularization + auditor shipped (#814, #818))
# Map — harden core-task (learn from pi-goal-list-loop-audit)

Effort slug: `2026-07-25-do-as-you-suggesnt-then-continue-develop`
Charted: 2026-07-25 · Mode: chart-the-map.

## Destination

`pi-agent-ext-core-task` (the bundled, default-loaded task cockpit) adopts the
**engineering discipline** of `pi-goal-list-loop-audit` — modularize the
`goal.ts` god-file into tested pure modules and harden the `agent_end` loop
driver (backoff cap, heartbeat, anti-repetition) — while **staying the
lightweight cockpit**: it does NOT become a default-on supervisor. An isolated
auditor + regression_shield may be added as an **opt-in** capability (default
off), decided on its own. "Continue develop" past hardening = evaluate
`/list` + `/loop` variants once the base is clean; that tail is fog, not
promised.

## Notes

- **Domain**: pi extension (`bun-apps/pi-agent-ext-core-task/`). The reference
  is the sibling repo `../pi-goal-list-loop-audit/` — read-only mentor; do not
  couple at runtime.
- **Skills every session should consult**: `grilling`, `domain-modeling`
  (decisions); `systematic-debugging`, `test-driven-development`,
  `writing-plans` (execution); `verification-before-completion` before closing
  any ticket.
- **Standing preferences**:
  - Conversation in zh-TW; written artifacts in English.
  - **Stay lightweight** — core-task ships default-loaded; nothing that
    changes `/goal`'s contract or adds per-goal cost by default.
  - **Goal state stays in the session-store** (`appendEntry`), NOT under
    `.planning/`. core-task is default-loaded → most goals are ad-hoc (no
    effort dir) and session-scoped (one live goal per session; avoids
    worktree / parallel-session fights over one file). `.pi-gla/` is the
    *reference's* dir, unused here. Finish removing the legacy
    `~/.pi/agent/pi-goal-state.json`. (Decided 2026-07-25.)
  - **Refactor-first** — the map's `blocked by` edges assume `goal.ts` is
    modularized (T01) before new loop-driver behavior (T02) or the auditor
    (T04) land on it. Flip the edges if you'd rather go feature-first.
  - **globalThis seams** (`__piGoalActive`, `__piPlan*`, the
    `__piCoreTaskStatusWidget` widget singleton) are a reasoned trade-off for
    the jiti double-module-identity problem — preserve the pattern, don't
    "fix" it into a module singleton.
  - Inlined `isContextOverflow` + `AssistantMessageLike` in `goal.ts` are
    deliberate (Bun isolated linker; no `@earendil-works/pi-ai` dep) — keep
    inlined unless a shared module is clearly warranted.
- **Architecture mentor** (`../pi-goal-list-loop-audit/`): pure, dep-free
  modules for the testable logic (`goal-loop-shield.ts`, `goal-loop-backoff.ts`
  are directly portable); the heavy `createAgentSession` auditor lives in
  `goal-loop-auditor.ts`.

## Decisions so far

- [01 — goal.ts modularization target](tickets/01-goal-ts-modularization.md) — **medium split** (8-file layout); pure modules + `__resetGoalState()` test seam; orchestrator stays cohesive. Spec: `core-task/docs/2026-07-25-goal-loop-hardening.md` §2.
- [02 — loop-driver hardening scope + thresholds](tickets/02-loop-driver-hardening.md) — **all three** (backoff cap 5 min + heartbeat + anti-repetition + wedge alert), ported verbatim; heartbeat gated to goal-active. Spec §3.
- [03 — opt-in isolated auditor: feasibility](tickets/03-opt-in-auditor-feasibility.md) — feasible; shield/backoff/heartbeat port cleanly as pure functions; model-auth wall is real but mitigatable via parent-runtime + opt-in model override; cost is one extra session per *audited* goal (acceptable as opt-in).

## Not yet specified

- **`/list` + `/loop` variants** (the "continue develop" tail): a queue of
  goals and a metric-driven forever-loop. Can't be ticketed until the
  single-goal hardening lands and we see whether the modularized state
  machine generalizes to 3 policies (the reference's Decision-5 bet).
  Graduates after T01/T02 close.
- **Persistence robustness**: *location* decided (session-store, see Notes).
  Open sub-question only: is the session-store path robust enough through
  compaction, or do we want the reference's JSONL-deterministic-rebuild
  guarantee? Low priority; revisit if a compact-induced goal-state loss is
  ever observed in practice.
- **Drafting phase**: the reference grills + Confirm-dialog before activating
  a goal; core-task takes the objective directly. core-task already owns
  `ask_user_question`, so the building blocks exist. Low priority; revisit if
  vague-objective rubber-stamping becomes a real failure mode.

## Out of scope

- **Becoming a default-on supervisor** (auditor mandatory on every
  `goal_complete`). Ruled out by the destination — core-task is the
  lightweight default-loaded cockpit; the auditor is opt-in or nothing.
  Wanting full-supervisor parity is a *different* effort (redraw the
  destination), not this map.
- **Runtime interop with `../pi-goal-list-loop-audit/`'s `.pi-gla/` state** —
  different package, different role. core-task learns from its *code*, not
  its *state*.
