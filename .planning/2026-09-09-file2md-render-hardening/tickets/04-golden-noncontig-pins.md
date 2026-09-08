# Ticket 04 — pins: htmlToMarkdown golden + non-contiguous promote

Status: done (depends on 03 — the pipeline-level pin asserts its notice)

## Goal

Close the two disclosure gaps: #2220's htmlToMarkdown byte change gets a
committed golden (pre-commit bytes recorded going forward), and the
non-contiguous slide-parts quicklook degrade gets pinned as a CONTRACT (pure
unit throw + pipeline-level degrade, never a throw out of runPptx). Map D7,
D8.

## Files

- `bun-apps/s2-agent-ext-file2md/__tests__/fixtures/html-golden/input.html`
  (new) + `expected.md` (new, GENERATED then committed)
- `bun-apps/s2-agent-ext-file2md/__tests__/html-golden.test.ts` (new —
  imports the exported `htmlToMarkdown`, pipeline.ts:1343; no pipeline run,
  no mocks needed)
- `bun-apps/s2-agent-ext-file2md/__tests__/deck-*.test.ts` (existing pure
  deck tests — add the promoteSlideFirst pin there)
- `bun-apps/s2-agent-ext-file2md/src/raster/deck.ts` (READ :249-360 first;
  edit only if the pin reveals the throw is NOT reachable for non-contiguous
  parts — then fix the promote loop, do not loosen the pin)

## Scope

1. Golden fixture: `input.html` exercising the #2220-fixed constructs — a
   `<body>` tag (the `<b|strong` word-boundary fix), a stray closing `</h2>`,
   `<title>`, headings, list, link, emphasis, table. Generate `expected.md`
   by RUNNING current `htmlToMarkdown` on the input (never hand-write it),
   commit both, assert byte-equality. A committed
   `UPDATE-GOLDEN` note (test comment) states the regeneration command.
2. Promote pin: pure unit test calling `promoteSlideFirst` with
   presentation/rels XML whose slide parts skip slide2 (slide1+slide3) →
   expects `PptxRenderError` (CI-safe, no qlmanage). Read deck.ts:249-360
   first to pin the actual reachability (fog: which throw line fires —
   265/273/278/353).
3. Pipeline-level pin: the ticket-03 midway-throw test IS the
   non-contiguous-observable pin (fake renderer throws like promote would →
   in-note degrade, not a throw out of runPptx). If its wording assertion
   does not already cover this, extend it — do not duplicate a whole test.

## Done when

- [ ] Golden test green and genuinely byte-equal (temporarily flip one char
      in a copy → test fails — prove the pin bites).
- [ ] `input.html` contains `<body>`, a stray closing heading, and `<title>`
      (the two #2220 fixes + the title prefix path are all pinned).
- [ ] promoteSlideFirst non-contiguous unit test green expecting
      PptxRenderError; `bun run test` + `typecheck` + `check` (biome) green.
- [ ] No source change in deck.ts unless the pin found the throw unreachable
      (if changed: its own test + rationale in the PR body).

## Risks

- Golden too narrow (only the fixed constructs) or too broad (a full page) —
  keep it ~20 lines of html; enough to pin the fixes, small enough to
  regenerate by hand when a deliberate change lands.
- If promoteSlideFirst turns out NOT to throw for slide1+slide3 (fog), the
  reviewer nit's mechanism is elsewhere — investigate before pinning; record
  the finding in the map's Fog of war resolution, don't invent a throw.

## Resolution

closed: 2026-09-09 — `__tests__/fixtures/html-golden/{input.html,expected.md}` byte-equal test in convert.test.ts (D7 form: files generated from current code, never hand-edited); non-contiguous pinned at BOTH layers — pure promoteSlideFirst refusal (deck.test.ts, slide1+slide3 rels) + the pipeline-level degrade test.
