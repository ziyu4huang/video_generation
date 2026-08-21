---
ticket: 02-title-overflow
effort: archify-deck-visual-fidelity
type: task
status: open
created: 2026-08-21
last: 2026-08-21
---
# 02 — the action title must not wrap through the chrome rule

> Spec §2.2, §4 (P2). Revisits `archify-slide-composition`'s title-guard decision.

## The defect

Composed slide 4's title wraps to two lines. The chrome rule is at a fixed y, so line two is
struck through by the rule and clipped by the content well. `deck-lint` passed the deck.

The prior effort chose a length rule over autofit on the reasoning that "a title that
silently shrinks is worse than one a linter complains about". **That reasoning is sound and
this ticket does not overturn it** — what failed is the calibration. A character-count
threshold picked without reference to the box width or the font size cannot predict a wrap,
and it did not.

## What to build

A wrap budget, not a length limit: derive the maximum title extent from the title box width
and the title font size in `deck-theme.ts`, and count **full-width characters as ≈ 1 em**
against a Latin advance for the rest — the same asymmetry that makes P3 a defect makes a
naive `.length` wrong here. Then make exceeding it a **failing** check on the composed
path, not an advisory one, because the failure mode is a clipped title rather than a style
opinion.

Decide explicitly between three ends, and record which and why in the Result:
1. stricter, correctly-calibrated lint (keeps the prior decision, fixes its calibration);
2. a chrome band that grows to two title lines (changes geometry, affects every layout);
3. autofit on the title (reverses the prior decision — needs a stated reason to).

Option 1 is the default unless the measurement says the budget is so tight that ordinary
CJK action titles cannot fit, in which case that measurement is the argument for 2.

## Acceptance

- A deck whose title would wrap past the chrome band **fails**.
- The six-layout example deck **passes** — if it does not, that is evidence for option 2,
  not a reason to loosen the budget until the example squeaks through.
- No renderer involved in the check.
- If the prior effort's decision changes, append a Resolution to
  `archify-slide-composition`'s relevant ticket and cross-link both maps, per
  `.planning/CONVENTIONS.md`.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`
