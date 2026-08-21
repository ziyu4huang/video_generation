---
type: task
blocking:
---

## Question

Additive env-knob sugar (D5): `parseSkillExclude()` in `src/superpowers.ts` supports a leading `!` token in `PI_SUPERPOWERS_SKILL_EXCLUDE` that resets the accumulated set — `"!,verification-before-completion"` = defaults-off + exclude exactly that; `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0` keeps working unchanged; bare `!` is a safe no-op reset. Doc comment + README + ADR-0008 note; test cases: reset, reset+add, defaults-off unchanged, bare `!`.

## Resolution

Landed 2026-08-21 (phase S8, branch feat/superpowers-s8-env-reset-sugar). `parseSkillExclude()` treats a `!` token as "drop everything accumulated so far" (defaults AND earlier env tokens): `"!,x"` = defaults-off + exclude exactly x; bare `"!"` = safe no-op reset (empty set → whole-dir representation, identical to DEFAULTS=0 + no list); `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0` unchanged and orthogonal. Purely additive — every previously-valid value parses identically. Four new test cases (leading reset via advertisement, mid-list reset, bare reset, DEFAULTS=0 orthogonality); README "Env knobs" section + ADR-0008 amendment. Gates: superpowers 145/0 + check + typecheck; adr-citation 19/0.

closed: (landed)
