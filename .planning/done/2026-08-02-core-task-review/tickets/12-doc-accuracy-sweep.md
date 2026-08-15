---
type: task
status: closed
blocked by:
findings: H6, M12, L13
resolved: 2026-08-12 — shipped in #1067 — doc sweep (`above-editor`→`belowEditor`; CONTEXT `/loop`,`/list` coverage)
---

# 12 — Doc accuracy sweep (above→below ×10 + CONTEXT `/loop`,`/list`,widget inventory)

## Problem

Two doc-health issues: (H6) "above-editor" prose in **10 sites** while code registers `placement:"belowEditor"`; (M12) the `/loop` and `/list` subsystems ship with full code+tests but **zero** CONTEXT.md coverage, the composite-widget description lists only 2 of 4 sections, and the "plan-coordinator=3" widget slot is aspirational (never registered). Plus (L13) the goal↔plan-coordinator asymmetry is healthy but undocumented.

## Evidence

- H6 — "above-editor" at: `CONTEXT.md:14`, `extensions/core-task.ts:8` + `:68`, `package.json:5`, `shared/status-widget.ts:2,7,15`, `todo/overlay.ts:6`, `goal/overlay.ts:6`, `goal/format.ts:157`. Code: `status-widget.ts:99` `{ placement: "belowEditor" }`.
- M12 — `grep loop|/list CONTEXT.md` → 0. `/loop` = `src/loop/*` (6 files, command + widget section order:0, mutually exclusive with goal). `/list` registered (`goal.ts:538`, `src/goal/list.ts`, pervasive in reviewer). CONTEXT.md:14 says only "goal + todo". `status-widget.ts:49-51` lists "plan-coordinator=3" but grep `addSection({id:"plan"})` → 0 (dead).
- L13 — goal self-consumes the plan coordinator directly; `__piPlan*` published only for wayfind (`goal.ts:24,1395-1400`).

## Approach

1. **Global `s/above-editor/below-editor/`** across all 10 sites (code is correct; only prose stale).
2. **CONTEXT.md** — add `## Language — /loop` (LoopState, the goal⊕loop order:0 mutual-exclusion invariant, `__piKickHeartbeat`) and `/list` (queue layer). Rewrite the composite-widget term to "goal **or** loop (order 0, mutually exclusive) + todo (1) + wayfind (2); plan-coordinator=3 is unimplemented".
3. Note the goal↔plan-coordinator asymmetry (L13) + list all four published `__piPlan*` seams (`__piGoalActive`, `__piPlanPhases`, `__piPlanIncomplete`, `__piPlanSummary`).

## Acceptance

- [ ] `grep -rn "above-editor" bun-apps/pi-agent-ext-core-task/` → 0.
- [ ] CONTEXT.md documents `/loop`, `/list`, the full widget section inventory, and marks plan-coordinator=3 unimplemented.
- [ ] No prose claims a nonexistent "yielding plan coordinator" (coordinate with ticket 01's doc corrections).
