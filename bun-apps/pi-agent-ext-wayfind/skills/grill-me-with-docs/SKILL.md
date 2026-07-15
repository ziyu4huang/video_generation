---
name: grill-me-with-docs
description: Use when stress-testing a plan or design AND wanting the interview to leave a paper trail — resolves terms into a CONTEXT.md glossary and hard-to-reverse decisions as ADRs as the grill runs, then optionally seeds a task_plan.md for planning-with-files. The flagship /grill-me-with-docs command; invocation-only.
---

# Grill Me With Docs

The flagship interview: a relentless, one-question-at-a-time walk down the decision tree that **captures its output** as it goes. A plain interview sharpens thinking and then evaporates when the session ends; this one writes each resolved term into a `CONTEXT.md` glossary inline and records genuinely hard-to-reverse decisions as ADRs — so the alignment survives the conversation instead of living only in your head.

This is `grill-me` (the interview) **plus** `domain-modeling` (the paper trail), fused into one session. Run by invoking `/grill-me-with-docs [topic]`.

## What the session does

1. **Enters grilling mode** — load the `grilling` skill: one question at a time, a recommended answer for every question, facts looked up in the environment, decisions put to the user. Never act until shared understanding is confirmed.
2. **Drives domain-modeling inline** — load the `domain-modeling` skill: as each term resolves, write it to `CONTEXT.md` *right there* (not batched at the end). Offer an ADR **only** when a decision is hard-to-reverse + surprising-without-context + the result of a real trade-off. Most sessions sharpen the glossary and write few or no ADRs — that's the intended shape.
3. **Coordinates with planning-with-files** — while this session is active, planning-with-files yields its plan injection/auto-continue (the two won't double-drive). The status bar shows the grill is driving.
4. **Hands off** — when shared understanding is reached, end with `/grill-done`. Optionally `/grill-done --seed-plan` to synthesize the resolved decisions + glossary into a `task_plan.md` seed, which you then drive with `/plan-execute` on planning-with-files.

## Where it fits

`grill-me-with-docs` is the **opening step** of the build chain — before anything is written down as a spec:

```txt
grill-me-with-docs → to-spec → to-tickets → (planning-with-files /plan-execute) → implement → code-review
```

It produces the shared understanding and settled vocabulary that `to-spec` then synthesizes into a spec without re-interviewing you.

## It's working if

- It asks one question at a time and waits, rather than dumping a questionnaire.
- Terms get written to `CONTEXT.md` the moment they resolve, in the project's own words.
- It reaches into the codebase to answer its own factual questions where it can.
- ADRs stay rare — you're not asked to rubber-stamp reversible choices.
- At the end, the resolved decisions can seed a `task_plan.md` cleanly.
