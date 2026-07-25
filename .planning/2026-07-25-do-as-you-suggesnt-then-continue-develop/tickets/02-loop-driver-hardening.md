# 02 — loop-driver hardening scope + thresholds

type: grilling
blocked by: 01 — goal.ts modularization target (lands on the clean module base)

## Question

Which loop-driver hardening does core-task adopt, and at what thresholds?
core-task's `agent_end` continuation loop already exists (continuation markers,
cancel tracking, provider/compaction recovery) but lacks three things the
reference proved matter:

1. **Hard backoff cap** — core-task has *no* ceiling on consecutive
   stuck/backoff iterations; a wedged goal relies on the agent yielding. The
   reference caps at **5 min** then pauses + notifies
   (`BACKOFF_HARD_CAP_MS`, `backoffMs()`, `shouldPauseAfterBackoff()`).
2. **Heartbeat self-watchdog** — core-task relies on `agent_end` firing; if a
   turn is eaten by compaction or a message drops, the loop stalls silently.
   The reference's 15 s heartbeat re-fires the continuation when
   `supervising && idle && nothing-scheduled && quiet>60s`
   (`shouldHeartbeatRefire()`), with a 3-nudge cap → pause.
3. **Anti-repetition / stuck-iteration detection** — core-task only does
   `iteration++`. The reference classifies each iteration (exact/near-dup,
   A-B-A-B, same-tool-same-result ×3, narration-only streak) and swaps in a
   rotating intervention; 3-stuck → reset, 5-stuck → stop.

### Recommendation

Adopt **all three**, porting the reference's **pure** functions verbatim into
`goal/backoff.ts` (they are dep-free and already unit-tested upstream):

- `backoffMs`, `shouldPauseAfterBackoff` — cap **5 min** (reference default;
  matches the "1-hour-wait" complaint that motivated it).
- `shouldHeartbeatRefire`, `accountTurnForNudges` — **15 s** tick, **60 s**
  stall, **3** nudge cap (reference defaults).
- Anti-repetition: port the classifier + rotating-intervention set.
  Thresholds **3-stuck reset / 5-stuck stop** (reference defaults).

Keep the **wedge alert** (`shouldWedgeAlert`, 30 min) — it catches the one
failure shape the turn-based watchdogs are blind to (a single unbounded
command holding the session). All of this lands as pure modules imported by
the (post-T01) orchestrator, so every threshold is a unit test, not a guess.

### What this ticket resolves

Which of the three + the thresholds. The reference defaults are a strong
prior; the real decision is whether core-task's lighter role justifies
*dropping* any (e.g. is anti-repetition over-engineering for a cockpit that
isn't an unattended rig?). Once decided, closes → execution plan ports the
pure modules behind TDD.

### Open sub-question

Does the heartbeat belong in the *bundled* cockpit, or is it over-reach for a
default-loaded extension the user is usually sitting in front of? The
reference's justification is unattended rigs; core-task's users may not need
it. (Lean: include it but make the stall threshold generous, or gate it to
"goal active" only.)

## Resolution

Decided 2026-07-25 (spec review, bundled with 01 into the hardening spec):
**all three** (D2) — backoff cap (5 min) + heartbeat + anti-repetition +
wedge alert, ported verbatim from the reference's pure predicates into
`goal/backoff.ts` + `goal/repetition.ts`. Heartbeat kept, gated to "goal
active" only; stall threshold is a plan-time tuning detail (starting point
120 s — more generous than the reference's unattended-rig 60 s). Spec:
`docs/2026-07-25-goal-loop-hardening.md` §3. Handed to writing-plans.

status: closed
