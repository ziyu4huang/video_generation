---
ticket: 02-title-overflow
effort: archify-deck-visual-fidelity
type: task
status: done
created: 2026-08-21
last: 2026-08-22
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

## Resolution — 2026-08-22

**Option 1: a correctly-calibrated lint.** The prior effort's decision stands; only its
calibration was replaced. The deciding evidence is §4 of
`receipts/archify-title-wrap-calibration-2026-08-22.md`: of eight real content-slide titles
across both example decks, **seven fit the band comfortably and one exceeded it** — the one
the defect was reported on. The ticket's escape clause ("unless ordinary CJK action titles
cannot fit") is therefore not triggered. The band is not too small; that title was too long.
It was shortened from 27.7 em to 22.7 em and both decks build.

### What was built

`lib/text-extent.ts` (new) — `textEms(s)` estimates set width from four buckets (full width
1.0, wide 0.78, other 0.60, narrow 0.31, space 0.29) and `lineCapacityEms(w, pt)` gives the
one-line budget after OOXML's two default insets. Buckets, not a per-glyph metrics table: a
metrics table is tied to one font and rots the first time a deck sets a different
`defaults.font`.

`deck-theme.ts` — `TITLE_BAND` now owns the two band geometries. `layouts.ts` reads them
instead of carrying the inch literals inline, so the linter predicts a wrap against the same
numbers the layout draws with. Values unchanged, so the D3 byte-identity lock still holds.

`deck-lint.ts` — `title-too-long` (a 90-character count) is gone. `title-overflows` replaces
it, at **error** severity past the budget and **warn** inside a 5 % margin of it, because
`text-extent.ts` is accurate to ±1.7 % and claiming "fits" inside that band would be a claim
the model cannot support. `DeckLintNote["severity"]` gained `"error"`.

`deck-build.ts` — `buildDeck` refuses any manifest carrying an error-severity note. Style
notes stay advisory; this one is not a style note.

### Decisions

- **The em dash is a full em.** Measured at 1.00 em in PingFang TC, same as an ideograph.
  The clipped title carried `——`; a Latin-advance model reads that as ~1.0 em against a real
  2.0. That single row is most of the defect.
- **The budget subtracts both text insets even though Quick Look ignores the right one.**
  QL breaks against the full 9.0 in box; PowerPoint honours `lIns` and `rIns` both. Since
  PowerPoint is the target, the shipped check is stricter than the renderer used to
  calibrate it — the safe direction.
- **The narrower band shape is used unconditionally.** A title that fits only because the
  slide happens to carry no takeaway breaks the moment someone adds one.
- **No `--allow-overflow` escape hatch.** The threshold is the real budget, not the margin,
  so a false positive needs the model to be wrong at the exact boundary; and the remedy —
  three fewer characters — improves the title anyway. Revisit if it ever fires falsely.
- **`statement` slides are exempt.** Their chrome is drawn with `title: false`; the string
  never occupies the band.

### Gates

```
bun run typecheck   clean
bun test            433 pass / 21 skip / 0 fail   (405 / 21 / 0 before)
```

`examples/deck-composed` slide 4 re-rendered: one ink band, y in [0.449, 0.781] in, clear of
the accent rule at 1.02 in. `examples/deck` still passes the D3 lock; its slide 2 (24.16 em
against a 24.37 em budget) warns, and a warn does not block.

Receipt: `receipts/archify-title-wrap-calibration-2026-08-22.md`.
