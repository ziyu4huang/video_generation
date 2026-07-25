## Question

How does the opt-in auditor (T04, shipped in #818) interact with a queued goal — per-item audit, and what happens to the queue when an audit disapproves / pauses?

## type: grilling

## blocked by: 02  ✅ (02 closed)

## claimed: agent (2026-07-25)
## status: closed (2026-07-25)

## Context

- T04 ships per-goal audit: `auditEnabled` on `ActiveGoal`; `goal_complete` runs the inline auditor; D3 routing (approve→complete, disapprove→bounded re-loop, 3×→pause, impossible→complete-with-note, error→no-complete).
- A `GoalListItem` (ticket 01) can carry `audit?: GoalAuditOptions`, so each queued item can independently opt into audit.
- Ticket 02's resolution (auto-advance on clean complete; freeze on pause/failure) already implies the audit outcome gates queue advancement.

## Sub-questions

1. **Per-item audit flag:** confirm each `GoalListItem` carries its own `audit` options (some queued goals audited, others not). Likely yes — natural from ticket 01's `GoalListItem` shape.
2. **Disapprove → queue stays put:** a disapproved (but not yet 3×) audit returns the finding with `terminate:false`; the agent self-corrects in-turn on the SAME goal. The queue does not advance. Confirm.
3. **3× pause:** the active goal pauses (escalates to user, per T04 D3). Does the queue also pause (no auto-advance — ticket 02's freeze), or does the next item activate leaving the failed one parked? Likely **queue freezes** — the escalation is the point.
4. **`impossible` on a list item:** the goal completes-with-note (T04 D3) and the queue advances (it's a clean-ish complete). Confirm this is desired (an impossible queued item shouldn't block the rest).

## Recommended

- Per-item `audit` options; disapprove → self-correct same goal, queue frozen; 3× pause → whole queue frozen for user; `impossible` → complete-with-note + advance. All consistent with T04's D3 + ticket 02's freeze rule. Confirm.

## Resolution

**Per-item audit flag; behavior fully governed by ticket 02's advance/freeze rules.** Resolved via Q1 + subsumption by 02/03.

- **Audit mechanism unchanged.** The auditor runs per-active-goal, inline in `goal_complete`, exactly as T04 (#818) shipped. The queue introduces **no new audit behavior** — it only observes audit outcomes to decide advance/freeze.
- **Per-item flag (Q1):** each `GoalListItem` carries `audit?: GoalAuditOptions` (incl. `auditorModel` override). When an item is promoted to `activeGoal`, its `audit` options flow into `createGoal(text, budget, baseline, audit)` — the same 4th param T04 added. So a queue can mix audited + non-audited goals, each with its own verifier/model.
- **Outcome → queue response (from ticket 02):**
  - `approved` / no-audit complete / `impossible`→complete-with-note → **auto-advance** (promote next).
  - `disapprove` (not yet 3×) → self-correct the **same** goal in-turn; queue frozen.
  - 3× pause → whole queue frozen; user runs `/list next` → parked-at-tail + promote next (ticket 03 lossless rule).

**No new code path beyond the per-item flag plumb-through.** This ticket was largely subsumed by 02; recorded here to make the per-item decision + the 02↔audit mapping explicit.

**Closed:** 2026-07-25.
