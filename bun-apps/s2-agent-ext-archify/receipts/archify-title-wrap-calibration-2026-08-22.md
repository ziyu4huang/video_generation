# Receipt — action-title wrap budget: calibrating a text estimate without a metrics table

- **Date:** 2026-08-22
- **Machine:** darwin arm64 (Darwin 25.5.0), bun 1.4.0, pptxgenjs 4.0.1, macOS Quick Look
  (`qlmanage`) as the OOXML renderer
- **Effort:** `.planning/2026-08-21-archify-deck-visual-fidelity/` ticket 02 (P2)
- **Scope:** everything below was measured on this machine. Nothing is quoted from
  documentation, and no font file was parsed.

## Why a measurement was needed

The pre-existing rule was `TITLE_MAX = 90` characters. It passed the deck whose title was
visibly clipped, because a character count cannot see a box width, a type size, or the
difference between `一` and `i`. Replacing it needed a model, and a model needs calibration.

## Method

`archify` never measures glyphs — a block declares a box, PowerPoint wraps inside it. So the
calibration ran the other way round: render known strings, read the ink back.

1. Build one-slide `.pptx` decks from a synthetic manifest (`layout: "bullets"`, one probe
   title per slide, `defaults.font: "PingFang TC"`, the shipped `title` role = 26 pt bold).
2. `qlmanage -t -s 1600 -o <dir> <files>` → one PNG per deck, 120 px/in.
3. `sips -s format bmp` → parse the BMP directly and take the ink bounding box of the title
   band (x ∈ [0.35, 9.69] in, y < 1.015 in — stopping just above the accent rule so the rule
   itself is not counted as ink).

Counting inked-row runs also detects the wrap: one band = one line, two bands = wrapped.

## 1. Per-class advance — a repeated glyph 16× bounds its own advance

A glyph repeated *n* times has `span = (n−1)·advance + inkWidth`, so
`span/n ≤ advance ≤ span/(n−1)`. At 26 pt, 1 em = 0.3611 in.

| glyph | ink span (in) | advance (em) | bucket |
|---|---|---|---|
| `一` | 5.766 | 1.00 | full width |
| `—` | 5.800 | 1.00 | full width |
| `，` | 5.500 | 1.00 | full width |
| `…` | 5.734 | 1.00 | full width |
| `→` | 5.775 | 1.00 | full width |
| `＋` | 5.658 | 1.00 | full width |
| `M` | 5.183 | 0.90 | wide |
| `A` | 3.933 | 0.70 | wide |
| `0` | 3.450 | 0.60 | other |
| `n` | 3.325 | 0.58 | other |
| `e` | 3.267 | 0.58 | other |
| `i` | 1.550 | 0.27 | narrow |

**The em dash is a full em.** That single row is most of the defect: the clipped title
carried `——`, which a Latin-advance model reads as ~1.0 em total and PingFang sets as 2.0.

## 2. Prose agreement — the buckets hold to ±1.7 %

Eleven mixed CJK/Latin titles of growing length, model vs measured extent:

```
err%   text
+1.6   Latency is dominated by the
+1.7   Latency is dominated by the cold
+1.2   Latency is dominated by the cold path
+1.0   Latency is dominated by the cold path and
+0.6   Latency is dominated by the cold path and the
 0.0   Latency is dominated by the cold path and the retry
-1.0   延遲主要來自冷啟動路徑
-0.5   延遲主要來自冷啟動路徑 cold
-1.3   延遲主要來自冷啟動路徑 cold start
-1.2   延遲主要來自冷啟動路徑 cold start path
-1.5   延遲主要來自冷啟動路徑 cold start path budget
```

These eleven rows are frozen as data in `__tests__/text-extent.test.ts`. The renderer
produced them once; the test never runs one — effort decision D1, *the renderer sees, it
never gates*.

## 3. Where the line actually breaks — and a Quick Look quirk

Nine probe titles of 20…28 ideographs, rendered:

```
20 21 22 23 24 25  → one band  (fits)
26 27 28           → two bands (wrapped, line two crossing the rule at y=1.02 in)
```

Ink starts at 0.617 in against a box at x = 0.5 in, confirming the OOXML default left inset
(`lIns` = 91440 EMU = 0.1 in) is applied. But the wrap boundary lands at ~9.0 in of line
length, not the 8.8 in that honouring **both** insets would give — and the Latin series
independently put a 8.97 in line on one line. **Quick Look breaks against the full box
width, ignoring `rIns`.**

`lineCapacityEms()` subtracts both insets anyway, because PowerPoint honours both and it is
the target. The shipped budget is therefore *stricter* than the renderer used to calibrate
it, which is the safe direction: anything this check passes fits in both.

At the shipped title band (9.0 in, 26 pt) the budget is **24.37 em ≈ 24 CJK characters**.

## 4. Result on the real decks

| deck | slide | em | verdict |
|---|---|---|---|
| `examples/deck` | 1 | 19.96 | ok |
| `examples/deck` | 2 | 24.16 | **warn** — inside the 5 % margin |
| `examples/deck` | 3 | 14.62 | ok |
| `examples/deck` | 4 | 17.18 | ok |
| `examples/deck` | 5 | 14.16 | ok |
| `examples/deck-composed` | 3 | 22.00 | ok |
| `examples/deck-composed` | 4 | 27.66 | **error** — the slide that was clipped |
| `examples/deck-composed` | 5 | 17.58 | ok |

One title of eight exceeds the budget, and it is the one the defect was reported on. Seven
ordinary CJK action titles fit comfortably. That is the measurement the ticket asked for
before choosing between a calibrated lint and a taller chrome band: it says the band is not
too small, so the title was too long. It was shortened; both decks now build.

## 5. Verified after the fix

- `examples/deck-composed` slide 4 re-rendered: **one ink band**, y ∈ [0.449, 0.781] in —
  clear of the accent rule at 1.02 in.
- `bun run typecheck` clean; `bun test` **433 pass / 21 skip / 0 fail** (405 before).
- `examples/deck` still passes the D3 byte-identity lock — its slide 2 warns, and a warn
  does not block.

## Reproducing

The probe harnesses were scratch scripts, not shipped code (they need a renderer, and this
package does not gate on one). To redo it: emit one-slide decks per probe title, render with
`qlmanage -t -s 1600`, convert with `sips -s format bmp`, and read the ink bounding box of
the title band. The numbers above are what that produced on 2026-08-22.
