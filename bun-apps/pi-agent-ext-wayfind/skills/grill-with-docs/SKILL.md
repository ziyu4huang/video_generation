---
name: grill-with-docs
description: Use when the user wants a relentless interview that ALSO captures its output — writes resolved terms to a CONTEXT.md glossary and hard-to-reverse decisions as ADRs as the grill runs. Invocation-only via /grill-with-docs; same interview as grilling but it leaves a paper trail.
---

# Grill With Docs

Run a `grilling` session **while driving `domain-modeling`**: as the interview resolves terms and decisions, write them down the moment they crystallise — fuzzy language sharpened into canonical terms lands in `CONTEXT.md`, and genuinely hard-to-reverse decisions land as ADRs under `docs/adr/`.

The grilling **leaves a paper trail**. A plain interview sharpens thinking and then evaporates when the session ends; this one captures each resolved term into the `CONTEXT.md` glossary inline (not batched at the end), and records ADRs sparingly. The alignment survives the conversation instead of living only in the user's head.

Load both the `grilling` and `domain-modeling` skills and run them together:

- `grilling` — the interview engine: one question at a time, a recommended answer for each, facts from the environment, decisions to the user.
- `domain-modeling` — the capture discipline: glossary-only `CONTEXT.md`, ADRs only when hard-to-reverse + surprising-without-context + real-trade-off.

If the user only wants the interview without the artifacts, use `grill-me` instead. If the plan is already clear and they just need to pin down terminology, use `domain-modeling` directly.
