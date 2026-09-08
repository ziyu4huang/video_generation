---
effort: 2026-09-08-archify-deck-html
created: 2026-09-08
last: 2026-09-08
status: active
---

# Wayfinder map: 2026-09-08-archify-deck-html — HTML/SVG decks as first-class presentations

## Destination

archify's vision — "produce PPT-grade presentations as simple HTML+SVG, stored
in well-defined JSON/JSONL, deterministically translated to PPTX" — holds end
to end with no silent pages: per-slide HTML and native-shape PPTX stay twin-
fidelity, a single self-contained `deck.html` plays any build offline, the
source format is schema-validated at build time (missing slots REFUSE to
build), and `deck pack/unpack` gives a byte-stable JSONL interchange envelope.

## Context

Three parallel GLM-5.3 audit agents (2026-09-07) mapped the vision against the
tree; reports are the effort's evidence base:

- `.planning/plans/2026-09-07-archify-eval-track1-html.md` — HTML/SVG surface
- `.planning/plans/2026-09-07-archify-eval-track2-format.md` — format/JSONL
- `.planning/plans/2026-09-07-archify-eval-track3-pptx.md` — PPTX determinism

Verdict: the vision is ~80% built. Per-slide HTML exceeds ordinary HTML-deck
quality (twin-emitter consistency is test-pinned); diagram IRs are the
strongest-format citizen (schema + version policy + drift gate); the pptx
translation was already content-deterministic. The real gaps were deck-level,
not slide-level.

## Shipped

- **POC-B — determinism gate (#2207, `bb373a2`)**: same deck built twice →
  canonicalized sha256 identical, as a permanent test
  (`tests/deck-determinism.test.ts`); `pptx-canonical.ts` pins core.xml
  timestamps + zeroes DOS dates.
- **POC-A — first-class deck.html (#2211, `f0704d3d`)**: `deck --combine`
  emits one self-contained player (sandboxed srcdoc iframes, keyboard paging,
  `#n` deep-links, `g` overview, deck-palette shell, zero network, notes stay
  out); `tests/deck-combine.test.ts`.
- **t01 — slot gate at build time (this PR)**: `slotProblems` moved to
  `layout-registry.ts` and enforced in `buildDeck` — missing/over-full
  template slots now REFUSE the build instead of rendering silently empty;
  `table.layout.json`'s `note` slot corrected to optional per its own
  description (the gate caught the inconsistency on its first run, plus two
  test manifests that relied on it).

## Tickets

- [ ] t02 — deck manifest schema + version story (`deck.config.json` gets a
  draft-2020-12 schema and a validated `manifestVersion`; template slot fields
  join the type surface) — track2 §3-1/3
- [ ] t03 — `deck pack` / `deck unpack`: byte-stable JSONL interchange
  envelope (header line + one slide per line; round-trip identity on the four
  example manifests) — track2 §4
- [ ] t04 — speaker notes reach the HTML deck shell (presenter view in
  deck.html; notes stay out of per-slide pages) — track1 §3-4
- [ ] t05 — print/PDF path: composed-slide `@media print` + deck-level
  one-slide-per-page pagination — track1 §3-3
- [ ] t06 — font subsetting/embedding for strict-offline diagram artifacts
  (replace the stripped Google Fonts link) — track1 §3-5

## Fog of war

- Whether JSONL pack/unpack should eventually feed an append-only agent
  authoring API (LLM writes one line per slide) — decide after t03's shape
  exists.
- A manifest schema (t02) may obsolete parts of the hand-written
  `parseManifest` — the split of authority needs a design pass first.
