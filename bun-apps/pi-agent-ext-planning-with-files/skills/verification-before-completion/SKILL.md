---
name: verification-before-completion
description: Use when about to claim any work is done, fixed, passing, or ready — before committing, opening a PR, marking a task complete, advancing to the next task, or accepting a subagent's report. Demands fresh verification evidence (run the command, read the full output, confirm the exit code) before any success claim; "should work" is not verification.
---

# Verification Before Completion

## Overview

Claiming work is complete without verification is not efficiency — it is dishonesty.
**Core principle: always back conclusions with evidence.**

Going through the motions of this rule while cutting corners violates its spirit just
as much as ignoring it.

> This skill supplies the *discipline* for the "Testing & Verification" phase that
> `task_plan.md` defines. It is cross-cutting: apply it at every task boundary inside
> `executing-plans`, not only at the end.

## The Iron Rule

```
No completion claim without fresh verification evidence.
```

If you have not run a verification command in this turn, you cannot claim tests pass.

## The Gate Function

Before claiming ANY state or expressing satisfaction:

1. **Determine** — what command proves this conclusion?
2. **Run** — execute the full command (re-run, complete execution — not a cached result)
3. **Read** — the full output; check the exit code; count the failures
4. **Verify** — does the output support the conclusion?
   - No → state the actual status, backed by evidence
   - Yes → state the conclusion with the evidence
5. **Only then** — make the claim

Skipping any step = lying, not verifying.

## Failure Modes — what evidence each claim requires

| Conclusion | Required evidence | Not sufficient |
|------------|-------------------|----------------|
| Tests pass | test command output: 0 failures | a previous run, "should pass" |
| Linter clean | linter output: 0 errors | partial check, inference |
| Build succeeds | build command: exit 0 | linter passed, logs look fine |
| Bug fixed | the original symptom test: passes | "code changed, assume fixed" |
| Regression covered | red→green cycle verified | test passed once |
| Subagent finished | diff / artifact inspection | the subagent reported "success" |
| Requirement met | item-by-item checklist against the spec | "tests pass" |

## Red lines — stop

You are about to violate this rule if you catch yourself:

- using "should", "probably", "seems to"
- expressing satisfaction *before* verifying ("great!", "perfect!", "done!")
- about to commit / push / open a PR without verification
- trusting a subagent's success report without inspecting its diff
- relying on partial verification
- thinking "just this once"
- tired and wanting to wrap up
- **any phrasing that implies success without having run verification**

## Anti-rationalization table

| Excuse | Reality |
|--------|---------|
| "should work now" | run the verification command |
| "I'm confident" | confidence ≠ evidence |
| "just this once" | no exceptions |
| "linter passed" | linter ≠ compiler |
| "the subagent said it succeeded" | verify independently — inspect the diff |
| "I'm tired" | fatigue is not an excuse |
| "a partial check is enough" | a partial check proves nothing |
| "rephrasing it makes the rule not apply" | the spirit outweighs the letter |

## Grilling — adversarial self-interrogation before "done"

The Gate Function is reactive (you remember to verify). **Grilling is proactive**: before
*any* completion claim, write down the 3–5 hardest questions a skeptical reviewer would ask,
then answer each with concrete evidence (a command + its output, a file:line, a diff hunk).
This is a relentless interview you run on yourself — borrowed from the "grilling" technique.

If **any** question can only be answered with "should", "probably", or a paraphrase of the
claim itself, the work is not done — go back and produce the evidence.

**Grill template (answer every line with evidence, not assertion):**

1. What command proves it works? *(paste output)*
2. What was the exact failure before, and what proves it's gone? *(red→green evidence)*
3. What did the spec/plan require that I have *not* shown evidence for? *(item-by-item)*
4. Where could this silently break that my test does not cover? *(edge / integration)*
5. If a subagent did the work: what does the actual diff show vs. its "success" report?

A claim that survives the grill is one you can state with evidence. One that doesn't is a lie
in progress — fix it before speaking.

Grilling is especially mandatory before: committing, opening a PR, marking a `todo` complete,
accepting a subagent's report, and the final `/plan-done`.

## Key patterns

**Tests:**
```
✅ [run test command] [see: 34/34 pass] "all tests pass"
❌ "should pass by now" / "looks right"
```

**Regression (TDD red-green):**
```
✅ write test → run (fails) → revert fix → run (must fail) → restore → run (passes)
❌ "I wrote a regression test" (without red-green proof)
```

**Build:**
```
✅ [run build] [see: exit 0] "build passes"
❌ "linter passed" (a linter does not compile)
```

**Requirements:**
```
✅ re-read the plan → build a checklist → verify item by item → report gaps or done
❌ "tests pass, phase complete"
```

**Subagent delegation:**
```
✅ subagent reports success → inspect the VCS diff → verify the change → report real status
❌ trust the report
```

## When to use

**Before any of these:**
- any success / completion claim
- any expression of satisfaction
- any positive statement about work status
- committing, opening a PR, marking a task done
- advancing to the next task
- delegating to a subagent and accepting its result

The rule applies to exact wording, synonyms, paraphrases, implications of success, and
any communication conveying completion or correctness.

## Why it matters

From real failure records: a partner saying "I don't believe you" (trust broken);
an undefined function shipped (crashes on arrival); a missed requirement delivered
(feature incomplete); false-completion waste → rework → redo. The principle: honesty
is a core value. If you lie, you get replaced.

## Bottom line

There is no shortcut to verification. Run the command. Read the output. Then — and
only then — claim the result. Non-negotiable.
