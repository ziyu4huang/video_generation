## Question

When the active (list-sourced) goal completes (and passes its audit if `auditEnabled`), does the next queued item **auto-activate**, or must the user **explicitly** advance it (`/list next` / `list_activate`)?

## type: grilling

## blocked by: —

## claimed: agent (2026-07-25)
## status: closed (2026-07-25)

## Context

- **Reference history:** v0.2 *auto-advanced* on completion; **v0.10.0 reversed this** — aborts no longer auto-advance; `/list next` and `list_activate` pick explicitly. The reversal was a deliberate UX correction (auto-advance surprised users mid-thought).
- **core-task stance:** lightweight cockpit, opt-in. Surprise auto-continuation cuts against the "pilot decides" feel. But a queue you have to nudge every time loses the "loop" value.
- **Audit interaction:** if the active goal is audited and the audit *pauses* it (3× disapprove, per T04 D3), auto-advancing to the next would discard the paused goal's escalation — almost certainly wrong. So at minimum, a paused/failed goal must NOT auto-advance.

## Candidate answers

- **(a) Explicit only** — completing a list goal leaves the queue idle; user runs `/list next`. Safest; matches reference v0.10.0. Loses automation feel.
- **(b) Auto-advance on clean complete; freeze on pause/failure** — a completed+approved goal auto-promotes the next; a paused/failed goal does not (waits for user). Hybrid; closest to the "loop" intent without the footgun.
- **(c) Auto-advance always** — even past pause. Aggressive; rejected by the reference's own v0.10.0 reversal.

## Recommended

**(b) auto-advance on clean complete, freeze on pause/failure.** Gives the queue its momentum while respecting the auditor's escalation. Confirm with the user.

## Resolution

**Hybrid, single behavior (no opt-out knob).** Resolved across Q1 + Q2.

- **Clean complete → auto-promote the next list item to `activeGoal`.** "Clean" = (i) no audit enabled + `goal_complete`, OR (ii) audit enabled + `<approved/>`, OR (iii) audit `impossible` verdict → complete-with-note (per T04 D3). All three advance.
- **Pause / failure → queue freezes.** Triggers: user `/goal pause`, audit 3× disapprove (T04 D3 escalation), or any `paused`/`budget_limited` transition. The queue does NOT auto-advance; the user must intervene (`/list next` — see ticket 03 for skip-vs-block semantics).
- **No `--no-auto` knob.** Creating the `/list` is itself the opt-in; auto-advance on clean complete is the natural consequence, not a surprise. If a user later wants pure-explicit, add `--no-auto` then — not v1.
- **Consistency:** a paused goal that is resumed and then completes cleanly still auto-advances (same rule applies on re-completion).

**Deferred to ticket 03/04:** what `/list next` does to a *paused* goal (skip it / park it / block until resolved) — that's a command-surface + audit-interaction question, not an advance-trigger question.

**Closed:** 2026-07-25.
