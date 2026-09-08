---
effort: 2026-09-09-file2md-render-hardening
created: 2026-09-09
last: 2026-09-09
status: active
---

# Wayfinder map: 2026-09-09-file2md-render-hardening — liveness bound + pptx mid-run honesty + golden pins

## Destination

The render seams shipped in PR #2220 become honest under failure and pinned
under change: a wedged WebView degrades to structural output within a bounded
liveness budget instead of hanging a conversion; a mid-run renderer failure in
runPptx leaves an in-note trace on every png-less slide AND is recoverable on
a re-run (the permanent-degrade trap dies at BOTH of its gates); current
htmlToMarkdown bytes and the non-contiguous-parts quicklook degrade are pinned
by committed tests. Hardening only — no new features, no new deps, no design
rule relitigated. One implementation PR, merged via the standard devops chain.

## Context

Successor arc per `output/next-goal-20260908-214343.md` (strict v2,
validator-passed): its Immediate steps are this arc's ticket set, sourced from
the 6 accepted follow-up nits of the independent reviewer APPROVE on PR #2220
(parent map `.planning/2026-09-08-file2md-svg-pptx-vision/` Shipped-as records
them verbatim). Measured by the planner 2026-09-09 (6 file reads):

- `waitReady` (src/raster/svg.ts:67-83) has NO TS-side bound: its in-page 3 s
  cap only gates tick scheduling inside the page — if the web process is
  wedged, the page's JS never runs, `view.evaluate` never settles, and
  `probe.navigate`/`waitReady`/`measureContent`/`view.screenshot`
  (svg.ts:104,105,106,122,123,124) can each hang a conversion forever. No
  view factory exists — `new Bun.WebView(...)` is constructed inline
  (svg.ts:100,119), so unit tests cannot inject a stalled view.
- The permanent-degrade trap has TWO gates, and the next-goal's step 3 fix
  (needRender only) plugs just one:
  - `needRender` (src/pipeline.ts:1071-1073) checks `status === "done" &&
    existsSync(mdAbs(i+1))` — md only, never the png, so a run that marked
    pages done without pngs never re-renders;
  - `processSlide`'s skip (src/pipeline.ts:1098) early-returns on the SAME
    md-only condition — even after a successful re-render wrote the pngs to
    disk, the degraded page's note is never regenerated, so the
    `![[page-NNN.png]]` embed never lands.
  - The mid-run failure path only console.errors (pipeline.ts:1085-1087);
    png-less pages in the renderer-present path get NO in-note notice at all
    (the only notice today is the renderer-null early path, pipeline.ts:1015)
    — a silent text-only degrade.
- `htmlToMarkdown` (src/pipeline.ts:1343, exported) changed bytes in #2220
  (`<(b|strong)` word boundary so `<body>` stops opening a `**`; stray
    closing-heading markers) with no committed golden — pipeline.ts:1353-1360
  carries the fixes as comments only.
- Quicklook promote: `promoteSlideFirst` (src/raster/deck.ts:260) is PURE
  (XML strings in/out) and throws `PptxRenderError` on unreferenced/missing
  slides (deck.ts:265,273,278); non-contiguous slide parts (slide1+slide3,
  no slide2) trip it mid-render → caught at pipeline.ts:1085 → whole-deck
  text-only degrade — currently unpinned by any test.
- Manifest reuse checks pageCount only (pipeline.ts:1066-1068 region) —
  nit 12, PRE-EXISTING runPdf parity, explicitly OUT of scope this arc.
- Test rig: `__tests__/pptx-lane.test.ts` already mocks
  `raster/deck.ts` (fake renderer with call counter) + sessions +
  vision-inference via `mock.module` — the seam-D1 renderer-free discipline
  is in place; package suite 309/309 green at parent close.

## Tickets

**Phase 1 — hardening (one implementation PR, branch `file2md-render-hardening`)**

- [x] `tickets/01-arc-open.md` — this map + tickets; planner pass done (this
      run)
- [x] `tickets/02-svg-liveness.md` — TS-side liveness bound in
      `src/raster/svg.ts` (withLiveness race + `opts.createView` factory +
      `opts.livenessMs`); stalled-view unit test
- [x] `tickets/03-pptx-honesty-recovery.md` — runPptx: capture renderError →
      in-note trace on png-less pages; re-attempt at BOTH gates (needRender
      1071-1073 + processSlide skip 1098); midway-throw + recovery tests
- [x] `tickets/04-golden-noncontig-pins.md` — committed htmlToMarkdown golden
      fixture (byte-equal) + pure promoteSlideFirst non-contiguous pin
      (depends on 03's notice for its pipeline-level assertion)

**Phase 2 — close-out**

- [ ] `tickets/05-gates-pr-closeout.md` — package gates + `local-ci-cli` +
      reviewer + squash-merge + map close + successor next-goal

## Decisions

Carried from parent (in force, do not relitigate): auto/ocr never call a VLM;
text-mode html output = today's htmlToMarkdown bytes (the golden now pins
them); render/vision failures degrade to text + notice, never throw; no new
npm deps; renderer-free unit tests; mock.module E2E pattern; slide cap 20.

- D1 liveness budget = `opts.livenessMs` with a 10 000 ms default constant in
  svg.ts. Prod gets a fixed sane bound; tests inject 25-50 ms and assert
  wall-clock return — no fake timers.
- D2 race granularity = per-PASS, not per-call: one `withLiveness()` wrapper
  races each whole WebView pass (probe: navigate+waitReady+measure; capture:
  navigate+waitReady+screenshot) against the timer, resolving null on expiry.
  navigate/measure/screenshot hang identically to waitReady, and the in-page
  3 s cap never fires when the page's JS isn't running — racing only
  waitReady would miss every other hang site. The losing promise gets a
  swallowed `.catch(() => {})` (closing a wedged view can reject), and the
  timer is CLEARED on success — an uncleared Bun timer pins the event loop
  and stalls process exit.
- D3 injectable view factory = `opts.createView?: (width, height) =>
  SvgViewLike` (structural: navigate/evaluate/screenshot/close). Default path
  unchanged (`webViewAvailable()` gate + real `new Bun.WebView`). Unit tests
  inject a stalled fake — the parent deck-seam D1 discipline (no real
  renderer in CI) extended to the svg seam.
- D4 png-less page honesty: in the renderer-present path, every page that
  ends without a png gets an in-note notice — `> Slide renders incomplete
  (renderer failed: <msg>)` when the captured renderError exists, a plain
  `> Slide renders incomplete (<renderer id> produced no image for this
  slide)` when the renderer simply returned nothing for it. Status stays
  `done` + manifest png null: the text note IS valid; a fake `error` status
  would misreport it in the index note (writeIndexNote renders ❌).
- D5 recovery is png-gated at BOTH gates, bounded per run: needRender
  (1071-1073) also fires when a selected page is done+md but its png is
  missing on disk, and the processSlide skip (1098) gains the same
  png-exists term so recovered pages REGENERATE their note (embed included).
  No loop is possible: needRender is evaluated exactly once per invocation,
  and the renderer-null path early-returns (pipeline.ts:1003) before it — an
  absent renderer never re-attempts, a broken one costs exactly one failed
  renderSlides call per run.
- D6 recovery reprocesses the whole note, so smart/vlm pages re-run vision on
  a recovery pass. Accepted: recovery is rare, and correctness of embed +
  notices beats a surgical embed-line md patch (more code than this arc
  warrants). `--pages`-excluded pages stay excluded (the `only` guard stays
  first in processSlide).
- D7 golden = separate committed fixtures `__tests__/fixtures/html-golden/`
  (input.html + expected.md), byte-equal assert on the EXPORTED
  `htmlToMarkdown` (pipeline.ts:1343 — no pipeline harness needed). Not
  inline literals (invisible-whitespace edits), not bun snapshots
  (regeneration hides content diffs). expected.md is GENERATED from current
  code then committed — never hand-written — and the input includes `<body>`,
  a stray closing heading, `<title>`, list/link/emphasis constructs so both
  #2220 fixes are pinned.
- D8 non-contiguous pin = two layers: a PURE unit test on `promoteSlideFirst`
  (deck.ts:260, string in/out, CI-safe) expecting PptxRenderError for a rels
  set that skips slide2; plus the pipeline-level pin = the fake-renderer
  midway-throw test (ticket 03) asserting runPptx degrades in-note and never
  throws out. qlmanage is not CI-runnable; we pin the contract, not the
  machine.
- D9 manifest input-identity (nit 12) stays OUT of scope — pre-existing
  runPdf parity (reuse checks pageCount only, pipeline.ts:1066-1068).
  Recorded as a follow-up, not a ticket; do not "fix" it incidentally.

## Frontier

`tickets/02-svg-liveness.md` — smallest, zero dependency on the others, and
it ships the pattern (injectable seam + bounded race) that ticket 03's tests
lean on conceptually. Then 03 → 04 (04's pipeline-level assertion targets
03's notice) → 05.

## Fog of war

- The exact throw line promoteSlideFirst hits for non-contiguous parts
  (deck.ts:265 vs 273 vs 278 vs the count check at 353) — executor reads
  deck.ts:249-360 before writing the unit pin; the pin asserts the throw
  class, not the line.
- `view.close()` on a wedged view: reject, hang, or leak? D2's swallowed
  catch covers rejection; if close can HANG, do not await it unguarded in
  the finally (ticket 02 risk).
- Whether `renderSlides` can legitimately return paths > slideCount (the
  regex+n guard at pipeline.ts:1081-1082 already ignores them — believed
  safe, verify while editing).
- soffice+pdftoppm has still never been live-run on this machine (quicklook
  wins the probe on darwin) — stays ranked goal 2 in the successor file,
  NOT this arc.
- Recovery-pass vision cost on smart/vlm decks with many degraded pages
  (accepted in D6; `--pages` is the pressure valve).


## Executor deviations (recorded 2026-09-09)

- D10 (D3 typing): the factory is typed `Bun.WebView` (the only real impl)
  rather than a new structural `SvgViewLike` — fakes satisfy the structural
  surface via test-side casts; no `any` anywhere. The planner's concern
  (no `any` at call sites) holds.
- D11 (recovery skip-gate): the processSlide skip compares manifest `mp.png`
  linkage with disk state (`noteMatchesDisk = pngOnDisk === (mp.png !== null)`)
  rather than png-existence alone — a recovered render must re-embed the png a
  failure-era note lacks AND vice versa (a deleted png regenerates an honest
  note). Strictly stronger than the ticket's png term.
- D12 (ticket 03 midway-throw expectation corrected): the ticket's done-when
  said "page-1 note has `![[page-001.png]]`" — measured FALSE for the real
  seam: renderSlides discards its work dir when it throws mid-loop, so NO png
  lands and every page carries the notice. The fake renderer reproduces this
  faithfully; the test asserts the honest behavior.
- D13 (D4 second wording): silent-shortfall notice reads
  `> Slide render missing for this slide (renderer returned no image) — text
  runs only.` (planner sketched `<renderer id> produced no image`); substance
  identical, both tests pin their exact strings.
- D14: `raceLiveness` resolves by REJECTION (caller catch → null), not the
  sketched `Promise<T | null>`;loser-rejection swallow + cleared timer +
  `closeQuietly` (close raced against the same fuse, rejections swallowed)
  implement D2's guard requirements verbatim.

## Fog of war resolutions

- close() on a wedged view: guarded — `closeQuietly` races it against the
  same liveness fuse and swallows rejection/hang expiry (svg.ts).
- renderSlides returning paths > slideCount: verified guarded at the copy
  loop (`n >= 1 && n <= slideCount`, pipeline.ts) — safe as believed.

## Cross-effort links

Builds-on: `2026-09-08-file2md-svg-pptx-vision` (PR #2220 — the seams being
hardened; its reviewer's 6 accepted follow-up nits are this arc's source).
Shares-decision-with: parent D1/D6 (probed optional layers, no new deps) and
the smart-enhance D4 degrade semantics (notice, never throw) — both applied
here to liveness, not just failure.
