---
name: systematic-debugging
description: Use when encountering any bug, test failure, build error, exception, performance problem, or unexpected behavior — before proposing a fix. Enforces root-cause investigation first; fixing only the symptom is failure. Especially under time pressure, after a "small fix" mindset, or when 2+ fix attempts have already failed.
---

# Systematic Debugging

## Overview

Random fixing wastes time and introduces new bugs. A sloppy patch only masks the deeper
problem.

**Core principle: always find the root cause before fixing. Fixing the symptom is
failure.**

Going through the motions of this process while cutting corners violates debugging's
spirit just as much as ignoring it.

> **Position in the chain:** this is the cross-cutting recovery skill you switch to from
> `executing-plans` whenever a test fails or a blocker appears. Verify every fix with
> the `verification-before-completion` discipline.

## The Iron Rule

```
No fix proposal without root-cause investigation.
```

If you haven't completed Phase 1, you cannot propose a fix.

## When to use

For any technical problem: test failure, production bug, unexpected behavior,
performance issue, build failure, integration problem.

**Especially when:**
- time is tight (emergencies most tempt guess-fixing)
- it feels like "one small change" will do it
- you've already tried several fixes
- the last fix didn't work
- you don't fully understand the problem

**Also don't skip when:**
- the problem looks simple (simple bugs still have root causes)
- you're in a rush (rushing → rework)
- someone demands an instant fix (systematic debugging is faster than repeated guessing)

## The four phases

Complete each phase before the next.

### Phase 1: root-cause investigation

**Before any fix attempt:**

1. **Read the error carefully**
   - don't skip errors or warnings — they often contain the solution
   - read the full stack trace
   - note line numbers, file paths, error codes

2. **Stabilize reproduction**
   - can you trigger it reliably? what are the exact repro steps? every time?
   - if you can't reproduce it → collect more data; don't guess

3. **Check recent changes**
   - `git diff`, recent commits, new dependencies, config changes, env differences

4. **Gather evidence in multi-component systems**
   When the system has multiple components (CI → build → sign; API → service → DB),
   add diagnostic logging at each boundary before proposing a fix:
   ```
   for each component boundary:
     - log data entering the component
     - log data leaving the component
     - verify env/config propagation
     - check each layer's state
   run once to collect evidence → find the break point → investigate that component
   ```

5. **Trace the data flow** — when the error is deep in the call stack, trace backward:
   where did the bad value originate? who called here with it? keep going up to the
   source. Fix at the source, not the symptom.

### Phase 2: pattern analysis

**Find the pattern before fixing:**

1. **Find a working example** — similar code in the same codebase that works correctly
2. **Compare against the reference** — if implementing a pattern, read the full reference
   implementation line by line; don't skim
3. **Identify the differences** — list every difference between working and broken, no
   matter how small; don't assume "that can't matter"
4. **Understand the dependencies** — what other components does this need? what setup,
   config, env? what hidden assumptions?

### Phase 3: hypothesis and verification

**Scientific method:**

1. **Single hypothesis** — state it clearly: "I think X is the root cause because Y."
   Write it down. Be specific.
2. **Minimal test** — make the smallest change that tests the hypothesis; change one
   variable at a time; don't fix multiple things at once
3. **Verify before continuing** — worked? yes → Phase 4. no → new hypothesis. Don't
   stack more fixes on top.
4. **When unsure** — say "I don't understand X." Don't pretend. Ask for help or research
   more.

### Phase 4: implementation

**Fix the root cause, not the symptom:**

1. **Create the failing test first** — minimal repro, automated where possible; a
   throwaway script is fine if there's no framework; the test MUST exist before the fix.
   (This is TDD applied to the bug.)
2. **Implement the single fix** — fix the located root cause; one change at a time; no
   "while I'm here" optimizations; no bundled refactors.
3. **Verify the fix** — does the test pass now? did you break other tests? is the problem
   actually solved?
4. **If the fix doesn't work:**
   - stop. count your fix attempts.
   - fewer than 3 → back to Phase 1 with the new information
   - **3 or more → stop and question the architecture** (step 5). Don't attempt a 4th
     fix without an architecture discussion.
5. **If 3+ fixes failed: question the architecture.** Signals of an architecture problem:
   - every fix exposes a new shared-state/coupling issue elsewhere
   - the fix requires a "large refactor" to land
   - every fix produces a new symptom somewhere else
   Stop and ask: is this pattern fundamentally sound? are we inertia-driving a wrong
   approach? refactor, or keep patching? Discuss with your partner before more fixes.
   This is not a hypothetical failure — the architecture is wrong.

## Red lines — stop and follow the process

You're rationalizing if you catch yourself thinking:

- "patch it for now, investigate later"
- "try changing X and see"
- "change several things at once and run the tests"
- "skip the test, I'll verify manually"
- "probably X, let me fix it"
- "I don't fully understand it, but this should work"
- "the process says X, but I'll do it differently"
- "[listing fixes without having investigated]"
- **"try another fix" (after 2+ attempts)**
- **each fix exposes a new problem somewhere else**

**All of these mean: stop. Return to Phase 1.** If 3+ fixes failed, question the
architecture (Phase 4, step 5).

## Partner signals — your approach is wrong

Watch for these cues:
- "isn't it that…?" — you assumed without verifying
- "can it tell us…?" — you should have gathered evidence first
- "stop guessing" — you proposed a fix without understanding
- "think deeper" — question the root, not just the symptom
- "are we stuck?" (frustrated) — your approach isn't working

**When you see these: stop. Return to Phase 1.**

## Common excuses

| Excuse | Reality |
|--------|---------|
| "simple problem, no need for the process" | simple problems still have root causes; the process is fast for simple bugs |
| "emergency, no time for the process" | systematic debugging is faster than repeated guessing |
| "try it, then investigate" | the first fix sets the tone; do it right from the start |
| "write the test after confirming the fix works" | an untested fix doesn't stick; the test is what proves the fix |
| "fixing multiple at once saves time" | you can't isolate which worked; you introduce new bugs |
| "the reference is too long, I'll improvise" | half-understanding guarantees bugs; read it fully |
| "I see the problem, let me fix it" | seeing the symptom ≠ understanding the cause |
| "try again" (after 2+ failures) | 3+ failures = architecture problem; question the pattern |

## Cheat sheet

| Phase | Key activity | Pass criterion |
|-------|--------------|----------------|
| **1. Root cause** | read error, reproduce, check changes, gather evidence | understand what's broken and why |
| **2. Pattern** | find a working example, compare | identify the differences |
| **3. Hypothesis** | state a theory, test minimally | hypothesis verified or new one formed |
| **4. Implementation** | create test, fix, verify | bug fixed, tests pass |

## When the process shows "no root Cause found"

If systematic investigation reveals the problem is genuinely environment-, timing-, or
externally-driven:

1. you've completed the process
2. document what you investigated
3. implement an appropriate handler (retry, timeout, error message)
4. add monitoring/logging for next time

**But:** 95% of "can't find a root cause" is actually insufficient investigation.

## Related skills

- **verification-before-completion** — verify every fix actually works before claiming
  the bug is resolved
- write the failing test in Phase 4 step 1 using the TDD red-green cycle
