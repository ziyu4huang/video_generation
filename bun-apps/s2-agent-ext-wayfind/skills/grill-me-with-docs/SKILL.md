---
name: grill-me-with-docs
description: Use when stress-testing a plan or design AND wanting the interview to leave a paper trail — resolves terms into a CONTEXT.md glossary and hard-to-reverse decisions as ADRs as the grill runs, then optionally seeds a task_plan.md for the plan coordinator. The flagship /grill docs command; invocation-only.
disable-model-invocation: true
---

# Grill Me With Docs

The flagship interview: a relentless, one-question-at-a-time walk down the decision tree that **captures its output** as it goes. A plain interview sharpens thinking and then evaporates when the session ends; this one writes each resolved term into a `CONTEXT.md` glossary inline and records genuinely hard-to-reverse decisions as ADRs — so the alignment survives the conversation instead of living only in your head.

This is `grill-me` (the interview) **plus** `domain-modeling` (the paper trail), fused into one session. Run by invoking `/grill docs [topic]`.

## What the session does

1. **Enters grilling mode** — load the `grilling` skill: one question at a time, a recommended answer for every question, facts looked up in the environment, decisions put to the user. Never act until shared understanding is confirmed.
2. **Drives domain-modeling inline** — load the `domain-modeling` skill: as each term resolves, write it to `CONTEXT.md` *right there* (not batched at the end). Offer an ADR **only** when a decision is hard-to-reverse + surprising-without-context + the result of a real trade-off. Most sessions sharpen the glossary and write few or no ADRs — that's the intended shape.
3. **Hands off** — when shared understanding is reached, end with `/grill done`. Optionally `/grill done --seed-plan` to synthesize the resolved decisions + glossary into a `task_plan.md` seed, which you then drive by executing the plan.

## Where it fits

`grill-me-with-docs` is the stress-test step of the build chain — it sits AFTER
`brainstorming` (which produced the design/spec) and before the plan is written:

```txt
brainstorm → grill-me-with-docs → (to-spec → to-tickets)? → execute the plan → implement → close
```

The chain is the DEFAULT path with documented skips: `brainstorm` is an optional opener
(skip for clear, well-scoped tasks); `to-spec`/`to-tickets` are an OPTIONAL ticketed-
planning variant (skip for the common direct `grill → execute the plan` path); `close` is
`finishing-a-development-branch`, then close the plan. The canonical, full statement of this
chain lives in `writing-plans`. The grill produces the shared understanding and settled
vocabulary that `to-spec` then synthesizes into a spec without re-interviewing you — or,
skipping to-spec, that flows straight into executing the plan.

## It's working if

- It asks one question at a time and waits, rather than dumping a questionnaire.
- Terms get written to `CONTEXT.md` the moment they resolve, in the project's own words.
- It reaches into the codebase to answer its own factual questions where it can.
- ADRs stay rare — you're not asked to rubber-stamp reversible choices.
- At the end, the resolved decisions can seed a `task_plan.md` cleanly.
