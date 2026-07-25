type: grilling
claimed: pi-session-2026-07-25 (cold-set before [01])
status: closed (2026-07-25)

## Question

What is the bar for "the inspect-* surface is **sufficient** for extension
development" — i.e., when is the hook-observability gap (activity 5) severe
enough to graduate a new tool, vs. accepted as a known limitation?

Set this **cold** — before [01]'s feasibility lands — so the threshold isn't
rationalized to whatever the feasibility answer turns out to be. Mirror the
2026-07-24 tool-gate map's discipline (threshold set before measurement).

## Recommended take (to grill against)

- **GO ("sufficient — stop") iff** every *HIGH-impact* in-scope activity gap is
  either covered OR explicitly accepted-as-limitation with a documented
  workaround. Hook observability is the sole HIGH-impact candidate gap
  (activities 3/4/8 covered; 6/7 partial-but-available).
- **The pivot sub-question:** is hook observability *HIGH-impact* for extension
  development, or *medium*?
  - Case for **HIGH**: an extension author wiring `pi.on(...)` currently has
    **zero** signal that their handler registered or fired — every hook bug is
    invisible guesswork (arguably the single most common extension-dev failure
    mode, and the one no current inspect tool touches).
  - Case for **MEDIUM**: a `console.log` inside the handler is a crude-but-real
    workaround; the gap costs developer time, not correctness.
- Walk: (a) HIGH or MEDIUM? (b) if HIGH and [01] says feasible → **no-go**
  (graduate `inspect_hooks`); if HIGH and infeasible → **GO** with
  accepted-limitation; if MEDIUM → **GO** regardless (document as known
  limitation).

## Resolution shape

A one-paragraph threshold ruling: the bar, the impact classification of hook
observability (HIGH / MEDIUM), and the decision rule linking it to the [03]
verdict. Set cold — do not read [01]'s answer before deciding the classification.

## Resolution (2026-07-25, cold-set before [01])

**Bar:** GO ("sufficient — stop") iff every *HIGH-impact* in-scope activity gap
is covered OR explicitly accepted-as-limitation with a documented workaround.

**Impact classification: hook observability = HIGH.** Decisive argument: the
asymmetry (every other layer has an inspect tool; hooks have none) combined
with the workaround's *reactivity* — `console.log` requires already suspecting
the specific hook, but the failure mode's nature is that you do not know which
hook silently failed to fire. For the extension-dev persona (constantly wiring
`pi.on(...)`), an invisible-registration / no-fire bug is the highest-frequency
unguarded failure mode.

**Decision rule (now locked, feeds [03]):**
- HIGH + [01] says feasible without an SDK change → **NO-GO** → graduate
  `inspect_hooks` to a fresh effort (spec → writing-plans).
- HIGH + [01] says needs an upstream SDK change (`getAllHandlers()`) → **GO**
  with hook observability accepted as a known limitation (document the
  `console.log` workaround in CONTEXT.md / README).
- (The MEDIUM branch is now moot.)

Set cold: this classification was made WITHOUT reading [01]'s feasibility
answer.
