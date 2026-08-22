---
ticket: 03-node-text-advance
effort: archify-deck-visual-fidelity
type: task
status: done
created: 2026-08-21
last: 2026-08-22
---
# 03 — CJK text in diagram nodes is clipped by a Latin advance guess

> Spec §2.3, §4 (P3).

## The defect

In the rendered `.pptx`, `SYS.1/2 需求來源` inside the MRD node is clipped, and the connector
label `系統需求` breaks as `系統需 / 求`. Source: `lib/pptx-shapes.ts` places SVG text with
`wrap: false` and width `node.fontSize * 0.62 * text.length * 1.35` — a Latin advance
applied to full-width glyphs whose true advance is ≈ 1.0 em.

`0.62 * 1.35 ≈ 0.837 em` per character. For CJK that under-reserves by ~16 %, which is
exactly enough to clip a label that fits in the HTML twin.

## What to build

Make the estimate script-aware: classify each character as full-width (CJK ideographs, kana,
full-width forms, CJK punctuation) or not, and sum ≈ 1.0 em against ≈ 0.837 em rather than
multiplying one factor by `.length`.

Keep `wrap: false`. This path reproduces a **fixed diagram layout** where the SVG already
decided where the line breaks are — turning on wrapping would reflow text the diagram
positioned deliberately. The prior effort's §2.3 reasoning holds; only the advance is wrong.

## Acceptance

- A width contract asserted on the emitted text box: for a set of fixture strings spanning
  pure-Latin, pure-CJK and mixed, the reserved width is ≥ the script-aware estimate.
- Text that fits in the HTML twin is not clipped in the `.pptx`, checked once by eye via
  ticket 05.
- No renderer in the assertion.
- Diagram slides in the legacy deck still build; expect and account for width bytes moving.

## Gate

`( cd bun-apps/s2-agent-ext-archify && bun run typecheck && bun test )`

## Resolution — 2026-08-22

**Script-aware reservation, as the ticket proposed — via `textEms()`, not a second
model.** Commit `9156af09f`; receipt `receipts/archify-node-text-advance-2026-08-22.md`.

### Root cause, measured before fixing

All 137 labels across `examples/deck/`'s five slides, old estimate vs the ticket-02 model:
Latin/mixed over-reserved 1.07–1.68×, **every one of the 40 pure-CJK labels under-reserved
at exactly 0.837×**. `系統需求` got 3.35 em for a 4.00 em string — 3.35 characters fit, which
is precisely why it broke as `系統需 / 求`.

### What was built

`lib/pptx-shapes.ts` — `labelWidthEms(text) = max(1, textEms(text)) * 1.15`. The headroom
is not an insurance premium: the model's worst measured bucket miss is `M` at −13 %, and
`wrap: false` needs an **upper bound** because not every OOXML renderer honours
`wrap="none"` (Quick Look does not — the very renderer that exposed the defect). `wrap:
false` itself is kept: this path replays a diagram whose SVG already decided where the lines
break.

`__tests__/pptx-mapper.test.ts` — the renderer-free width contract: fixtures spanning
pure-Latin / pure-CJK / mixed assert reserved ≥ script-aware estimate, ideographs get a
full em (the 3.35-vs-4.00 regression named directly), and headroom over the model rather
than parity.

### One acceptance substitution, recorded

The acceptance line "checked once by eye via ticket 05" could not be met literally — ticket
05 (the portable render seam) is not built. The check was done with the ticket-02 scratch
Quick Look pipeline instead: all five slides rendered before and after; every
previously-broken label (`系統需求`, `體檢`, `壞散文`, `寫得對不對`) is one line, and no
Latin label wrapped despite its narrower box (`IF·ALLOC·BUDGET·FSM`, `AXI4 64-bit`).
Same renderer, same machine, same by-eye standard — only the reusable seam is missing.
When ticket 05 lands, this is a candidate for its first receipt re-run.

### Gates

```
bun run typecheck   clean
bun test            445 pass / 21 skip / 0 fail   (433 / 21 / 0 before)
```

Both example decks build, content + ooxml lint clean, D3 byte-identity lock holds.

### Follow-ups found while closing

- The East Asian Ambiguous glyphs (`≥ · ≈ ▶ ↔ ≠ ×`) had no measurement behind their 0.6 em;
  re-measured with a clean ink window and corrected in `textEms()` (commit `4ba8e093d`,
  receipt `archify-ambiguous-advance-2026-08-22.md`). Diagram labels inherit the correction
  for free.
- Slide 3's `DETAIL · ~64 個` overlaps `HWE.2` vertically in both before and after renders —
  pre-existing, not a P3 regression; handed to ticket 04's attribution step.
