# Receipt — portable render seam (`deck render`), 2026-08-22

Ticket `05-portable-render-seam` (effort `archify-deck-visual-fidelity`). One-off,
committed evidence per D1/D3: the renderer SEES, it never gates, and no pixel
baseline is implied by these images — they record what was seen, once, on one
machine.

## Environment

| what | value |
| --- | --- |
| OS | macOS 26.5.1 (darwin) |
| backend | `quicklook` (`qlmanage`, system binary — zero install) |
| bun | 1.4.0 |
| pre-fix tree | `origin/main` @ `285f77e8d` (temp worktree) |
| post-fix tree | this branch (P1–P4 + seam) |

## Exact commands

```bash
# the seam, end to end (build + picture in one call):
cd bun-apps/s2-agent-ext-archify
bun run deck render examples/deck-composed/deck.config.json --out <dir>

# picturing an EXISTING pptx (how the pre-fix decks were shot):
bun -e 'import { pickRenderer } from "./lib/deck-render.ts";
  (await pickRenderer()!.renderSlides("/path/deck.pptx", "<dir>"))'

# no-backend refusal (PATH stripped of qlmanage, soffice, pdftoppm):
env PATH="$(dirname "$(which bun)")" bun scripts/deck.ts render cfg.json
# → deck: no render backend on this machine
#     quicklook: needs darwin + qlmanage — not found here
#     libreoffice: needs soffice + pdftoppm — not found here
#   exit 1, no stack trace
```

Measured: **6 images in 826 ms** (composed example, one call, `slide-1.png` …
`slide-6.png`); spec §2.5's 0.24 s figure was `qlmanage` alone — the difference
is six zip repacks plus six process spawns.

## The four defects, before → after (pre-fix deck vs post-fix deck)

P1 — icon fill semantics (`legacy` slide 1 & 3)
: The legend/icon regions differ visibly between pre and post renders (VLM
  diff: pre icons render as solid filled marks, post as outlined star-bursts).
  The authoritative contract is ticket 01's structural pin (`<a:noFill/>` +
  in-range `roundRect` adjustment), not these pixels.

P2 — action title overflows (`composed` slide 4, old title)
: **The gate is the evidence, not the image.** Rebuilding the pre-fix config
  (old 27.7-em title) with the fixed builder refuses:
  `slide 4: [title-overflows] title sets about 27.7 em against a 24.4 em band
  (9 in at 26 pt) — it will wrap onto a second line, which the accent rule
  strikes through; shorten it` (exit 1). The example now ships a reworded title
  that fits. Caveat, per the effort's fog entry: **Quick Look breaks lines
  against the full box width and ignores `rIns`**, so this backend CANNOT
  picture the two-line wrap PowerPoint shows — the pre-fix image misleadingly
  shows one clean line. A renderer that cannot show a defect is exactly why
  D1 keeps images out of the gates.

P3 — East Asian node text advance (`legacy` slide 3)
: Pre: the `AUDIO APU` sub-label renders `拉近看` — the `→` glyph is clipped
  (a Latin advance under-reserving an ideograph-and-arrow label). Post: the
  full `拉近看 →` renders. **This pays ticket 03's owed re-run**: its original
  by-eye pass used a scratch pipeline because the seam did not exist.

P4 — split-slide diagram fit (`composed` slide 3)
: Pre: the column diagram occupies roughly the lower half of its column with a
  dead band above (canvas fit centring an mostly-empty artifact canvas). Post:
  the diagram fills the column (VLM diff: ~50 % → ~100 % of column height;
  emit-side measurement in ticket 04: 4.13×2.25 → 7.16×3.90 in). **This pays
  ticket 04's owed re-run** — its original sighting needed a hand-built
  one-slide deck to get past Quick Look's slide-1-only limit.

## Design deviation from the ticket text, measured before committing to it

The ticket sketched the quicklook route as "split the deck into N one-slide
decks, reusing the deck builder". The seam as built does NOT rebuild: it copies
the pptx N times and rotates each copy's `<p:sldIdLst>` so slide N is first
(`lib/deck-render.ts: promoteSlideFirst`). Reasons:

1. `renderSlides(pptx, outDir)` has no manifest — D2's interface is
   `pptx → N images`, and a rebuild route would need the config the interface
   deliberately does not take.
2. A rebuild re-runs the vendored renderer and pictures a DIFFERENT file than
   the one on disk; rotation pictures the actual bytes, just starting elsewhere.
3. Measured before shipping: `qlmanage` renders the first `<p:sldIdLst>` entry
   (promoting slide 3 changed the thumbnail from a title slide to the split
   slide), not the lowest id and not the first part name.

Every part of the copy stays exactly as built — the throwaway merely starts
somewhere else.

## Not measured

`libreoffice` (`soffice` → pdf → `pdftoppm`): not installed on this machine,
rendered nothing here. No number is claimed for it anywhere. Cross-platform
fidelity vs Apple's importer remains the effort's open fog item.
