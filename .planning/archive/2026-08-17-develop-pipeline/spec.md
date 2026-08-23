# Spec — develop-pipeline (PRD)

Synthesized from `.planning/2026-08-17-develop-pipeline/map.md` (frozen 2026-08-17;
grill resolved Q1–Q5 into D5–D9). Diagrams of record (stage spine + execute loop)
live in the map; CONTEXT-MAP.md points there (D9). This spec covers the remaining
build surface only.

## Problem Statement

The repo runs a multi-extension agent pipeline (wayfind decides, superpowers
designs/plans/orchestrates, subagents execute bounded missions) whose rules live
partly in skill prose and partly in session habit. Consequences: every new session
re-derives when a stage may start (handoffs are implicit), whether a write child
was independently verified (verification is per-plan convention, not a rule), and
what a dispatched child cost or where its work landed when it died at budget (no
ledger). Concrete failure on record: the archify relocation shipped ~15 strict-mode
type errors because a plan's gates ran package tests but not the repo-wide
extension-entry typecheck — a verify child following a codified protocol would
have caught it pre-push.

## Solution

Codify the pipeline's edges into the skills that own them:
- Stage entry-criteria blocks in the three boundary skills (D5) so no stage starts
  on an unfrozen upstream artifact.
- The verify-child protocol as a section of superpowers:dispatching-parallel-agents
  (D6) so every write child is followed by a read-only gate re-run — including the
  repo-wide gates, not just package-local ones.
- A one-line-per-child budget/outcome ledger convention for the SDD progress.md (D8)
  so budget-death is recoverable and dispatch costs are analyzable across efforts.
- The task-cockpit (/goal + todo) documented as an in-session tool footnote, not a
  pipeline stage (D7 — already reflected in the map diagram; no build).

## User Stories

1. As an orchestrator, I want an explicit entry-criteria block in to-spec, so I
   never synthesize a spec from a map that still has open questions.
2. As an orchestrator, I want an explicit entry-criteria block in writing-plans,
   so I never plan against an unsettled spec.
3. As an orchestrator, I want an explicit entry-criteria block in executing-plans,
   so I never execute a plan containing tasks without Run:/Expected: gates.
4. As an orchestrator, I want the verify-child protocol in
   dispatching-parallel-agents, so verification of write children is inherited by
   every plan instead of re-decided per plan.
5. As a verify child, I want the protocol to name exactly what I re-run (the
   task's gates plus repo-wide gates like typecheck:ext and sanity greps), so my
   verification is mechanical, not judgment.
6. As a verify child, I want a defined red path (redispatch a janitor child or
   escalate to systematic-debugging), so I never paper over a failure.
7. As a dispatched write child, I want my budget, turn cap, outcome, and commit
   SHA recorded in the SDD ledger, so my work survives my death and the effort's
   cost history is analyzable.
8. As a plan author, I want the ledger line format fixed, so every effort's
   dispatches are comparable against the 2026-08-16 baseline (150–260k tokens,
   6–14 turns).
9. As any session, I want the task-cockpit noted as an in-session tool, so I
   remember /goal for long single-objective pushes without mistaking it for a
   pipeline stage.
10. As a future upstream re-sync, I want skill edits to follow the
    rebalance-upstream-skills fidelity protocol, so byte-pinned fixtures stay
    meaningful.

## Implementation Decisions

- M1 wayfind:to-spec SKILL.md — add a named "Entry criteria" block: map frozen
  (Not-yet-specified empty). Promotes the existing chain-wiring sentence into an
  explicit block.
- M2 superpowers:writing-plans SKILL.md — add "Entry criteria": spec settled
  (spec.md exists; zero open decisions).
- M3 superpowers:executing-plans SKILL.md — add "Entry criteria": every task in
  the plan carries Run:/Expected:.
- M4 superpowers:dispatching-parallel-agents SKILL.md — add "Verify-child
  protocol" section: after every write child, dispatch a read-only verify child
  (tools: read-only) that re-runs the task's gates AND repo-wide gates
  (typecheck:ext; sanity greps); on red, redispatch a janitor child (status →
  gate → check boxes → commit green work) or escalate to systematic-debugging.
- M5 ledger convention — in executing-plans (or the SDD skill, whichever owns
  progress.md prose today) document the one-line-per-child format:
  `[<task>] child(<tokenBudget>k/<maxTurns>t) → done|died|janitored @<commit-sha>`
  with the 2026-08-16 baseline numbers cited.
- No new packages, no tool-gate linter (D5 defers until drift proves need), no
  diagram copies (D9 rejected triple-copy drift).
- Superpowers skill edits MUST follow ADR-superpowers-0004: edit →
  `bun scripts/rebalance-upstream-skills.ts` → `bun test` (byte-pinned
  fixtures); record divergence in UPSTREAM.ref LOCAL-DIVERGENCES only if content
  re-merges upstream methodology (entry-criteria/protocol sections are repo-local
  additions — note them there).

## Testing Decisions

- superpowers: the 132 byte-pinned fixture tests are the gate; every SKILL.md
  edit is followed by rebalance + full test run. Fixture diffs encode the new
  sections — external behavior (skill content) is exactly what is pinned.
- wayfind: `bun run check && bun run typecheck && bun test` (513 baseline) after
  the to-spec edit.
- Repo-wide: scripts/ci-local.sh --gates 17/17 before merge; pre-push hook
  re-verifies.
- No new test files; the fidelity fixtures are the test surface for prose changes.

## Out of Scope

- Skills restructuring beyond the named blocks/sections (closed by
  2026-08-16-solution-extension-simplification).
- Tool-gate linter automation (D5: only if drift proves we need one).
- Remote CI enablement (permanently disabled by design).
- The MLX movie pipeline (a different pipeline).
- Diagram copies into package READMEs (D9: map.md is the single record).

## Further Notes

- D1–D4 are already satisfied by landed state (artifact home, routing, devops
  chain, merged guardrails); D7/D9 landed with the grill PR (#1578). The build
  surface is exactly M1–M5.
- Chain wiring per to-spec: next = /wayfind tickets (to-tickets) → seed →
  executing-plans / subagent-driven-development, gated by this spec being settled.
