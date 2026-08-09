# 05 — slim core-task always-on footprint

**Status:** REVERTED

#5 attempted to gate `ask_user_question` + `todo` out of core (#1142, merged, squash
commit dc6cfbb6). A miss-rate A/B (`qa/miss-rate-ab.ts`) showed an 81% adversarial
miss-rate (todo 0%, ask_user_question 33%) — keyword-gating is the wrong mechanism
for high-frequency core-workflow tools.

**REVERTED:** both restored to `core: true` (revert of dc6cfbb6, commit e6e171da).

**Lesson:** keyword-gating fits heavy domain tools, not high-frequency workflow
tools. The miss-rate-ab.ts QA guard that caught this is kept (`bun run qa:miss-ab`);
it is a gated-state-only probe and correctly refuses to run against the reverted
`core:true` configuration with a clear diagnostic.
