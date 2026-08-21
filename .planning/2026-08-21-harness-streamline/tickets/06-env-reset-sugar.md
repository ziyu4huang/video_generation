---
type: task
blocking:
---

## Question

Additive env-knob sugar (D5): `parseSkillExclude()` in `src/superpowers.ts` supports a leading `!` token in `PI_SUPERPOWERS_SKILL_EXCLUDE` that resets the accumulated set — `"!,verification-before-completion"` = defaults-off + exclude exactly that; `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0` keeps working unchanged; bare `!` is a safe no-op reset. Doc comment + README + ADR-0008 note; test cases: reset, reset+add, defaults-off unchanged, bare `!`.
