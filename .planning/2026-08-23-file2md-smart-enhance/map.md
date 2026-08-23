---
effort: 2026-08-23-file2md-smart-enhance
created: 2026-08-23
last: 2026-08-23
status: active
---

# file2md smart enhance — adaptive text → OCR → vision-on-figure ladder

## Destination

`s2-agent-ext-file2md` gains a fourth pipeline mode, `--extract smart`: per PDF page the
pipeline extracts the text layer first, runs vendored tesseract-wasm OCR only when the text
layer is thin, and — only when the page carries a *figure* (excluding small inline ones) —
describes the figure with the local vision LLM and appends the description as a clearly
marked section. No VLM server present → figures are flagged, never a failure. The ladder
ships covered by a fixture-driven E2E test suite pinning the detection thresholds.

## Context

Measured 2026-08-23 in this worktree unless noted.

- **Current pipeline** (`bun-apps/s2-agent-ext-file2md/src/pipeline.ts`): modes
  `text|ocr|vlm` (`auto` converges on `ocr`, parseMode `pipeline.ts:90-96`); per-page ladder
  is text layer ≥ `OCR_TEXT_MIN_CHARS = 8` → done, else raster → vision (vlm mode) or OCR
  (`extractPdfPage`, `pipeline.ts:335-400`). Vision resolves EAGERLY and hard in vlm mode
  (`pipeline.ts:131-137`); text/ocr are VLM-free by design.
- **Prior decision D3** (`.planning/2026-08-23-file2md-vision-extraction`): the caption-only
  figure-page gap is "documentation + advisory trigger, not an auto-vision heuristic" — a
  ~90s/img LM Studio round-trip is the wrong DEFAULT. This effort supersedes D3 **for the new
  explicit `smart` mode only** (operator choice, brainstormed 2026-08-23); D3 stays true for
  auto/ocr/vlm/text.
- **Measured figure-page shape (USB4 CLEAN spec, 839 pp, converted 2026-08-23)**:
  31 pages < 900 B (pure caption-only figure pages), 56 pages in 900–1300 B (figure captions
  + label fragments); all 839 `provenance: text`. The caption+band shape is the empirical
  detector target.
- **Vision reality**: LM Studio MLX vision model is always-on-reasoning
  (`qwen/qwen3.8-27b`); non-reasoning sibling pre-wired but not loaded (#1913). The #1913
  empty-output guard (`runVisionInference` completed-but-empty → `ok:false`) is the degrade
  the ladder reuses.
- **Test prior art**: `__tests__/pipeline-v2.test.ts` runs the REAL pipeline end-to-end with
  pdf-lib fixtures (`__tests__/helpers/docs.ts`: `textPdf`, `scannedPdf`) and only the
  wasm/worker pair (`raster/pdf.ts`, `ocr/ocr.ts`) stubbed. Package canonical test:
  203 pass / 0 fail (2026-08-23).

## Tickets

### Phase A — ladder

- [x] 01 — smart mode plumbing + figure detection (no vision) — mode parses, soft vision
      resolve, figure.ts detectors, figure-flag manifest record + skip notice, non-figure
      pages unchanged. Blockers: none.
  **(CLOSED 2026-08-23 — PR #1928 `16d0caac`, verdict CLEAN, branchSpent: true.
  221 tests +12 (figure boundary/caption-regex units + smart-mode E2E fixtures);
  local_ci 10 packages + 28 gates green; s2-agent bumped 0.5.1 → 0.5.2 via
  PR #1931. Detector fixture note: pdfjs clips one long text object at the page
  width, prose fixtures draw in ≤85-char lines.)**
- [ ] 02 — vision enhance on figure pages — figureHint prompt, append `## Figure (vision)`,
      scan-page OCR-band path, guard degrade, concurrency. Blockers: 01.
- [ ] 03 — E2E suite hardening + docs + CLI surface. Blockers: 01, 02.

### Phase B — OCR engine (independent; user-added 2026-08-23)

- [x] 04 — swap OCR engine: tesseract.js → tesseract-wasm (robertknight, npm
      `tesseract-wasm` 0.11.0, BSD-2-Clause) — in-process low-level `OCREngine`,
      raw tessdata_fast `.traineddata` vendored, worker_threads gone.
  **(CLOSED 2026-08-23 — PR #1920 `19abde98`, verdict CLEAN, branchSpent:
  true. 209 tests +6, smoke-proven both paths, gates 27/27.)**
- [x] 05 — ship file2md in the s2-agent deploy tree + OCR e2e vs the deployed
      dist (user-directed 2026-08-23: ensure the wasm is the correct package
      and works in s2-agent-sh; e2e must catch a broken asset layout).
  **(CLOSED 2026-08-23 — PR #1922 `48a3c93d` CLEAN/spent; PR #1923 s2-agent
  bump → 0.5.1. Deployed `0.5.1+g2f38d39`, e2e pass incl. file2md-ocr:pass
  (deployed bundle OCR'd the fixture). Flip side-effects resolved: locators
  specifier-based, wrapper resolve, base-set seams (core-runtime migration +
  BUN_PI_FILE2MD=0), facade rows dropped.)**

**Execution order:** 04 → 05 → 01 → 02 → 03 — 04 shipped (#1920), 05 shipped
(#1922, +0.5.1 via #1923) and 01 shipped (#1928, +0.5.2 via #1931): the
engine is in the deployed tree with OCR e2e; smart mode's skeleton is in.
Next: 02 (vision enhance on figure pages) → 03.

## Decisions

- **D1 — `smart` is a new explicit mode; auto/ocr/vlm/text are untouched.** Backward
  compatible; offline users never pay a vision default; D3 (vision-extraction) remains true
  for every non-smart mode. Reason: user chose explicit mode over default change
  (brainstorm 2026-08-23).
- **D2 — figure detection is caption+band on text pages, OCR-length band on scan pages**
  (approach A of the brainstorm; raster ink-coverage and caption-only alternatives
  charted-and-rejected). Text page: a `Figure N-x.` caption AND body ≤
  `FIGURE_MAX_BODY_CHARS = 1300`. Scan page (thin text layer): OCR output ≤
  `FIGURE_OCR_MAX_CHARS = 200`. Small inline figures are excluded by construction — prose
  pages never fit the band. No blanket rasterization; a text figure page is the only new
  rasterization, and only when enhancement can actually run.
- **D3 — enhancement appends, never replaces.** `## Figure (vision)` section after the
  untouched original body; page provenance stays text/ocr; page frontmatter gains
  `enhanced: vision`; manifest page record gains additive `figure: { detected, enhanced }`
  (manifest schema stays v1 — old readers ignore it).
- **D4 — smart resolves vision softly.** No VLM server → warn once, append
  `> Figure detected — vision enhancement skipped (no vision server).`, `enhanced: false`.
  A page never fails because enhancement did not. `vlm` mode keeps its hard resolve.
- **D5 — thresholds are named constants in the tested module** (`src/core/figure.ts`), pinned
  by the smart-mode E2E fixtures so a drift is a red test, not a silent behavior change.
- **D6 — OCR engine is the standalone tesseract-wasm (robertknight), in-process, no
  worker_threads** (user-added 2026-08-23; upstream npm `tesseract-wasm` 0.11.0, BSD-2-Clause,
  "JS/WebAssembly build of the Tesseract OCR engine for use in browsers and Node"). Adopted for
  the ADR-0001-documented Bun fragility (tesseract.js node workers use `worker_threads`; the
  in-process low-level `OCREngine` removes the fallback concern entirely) and the raw
  `.traineddata` story (no gunzip cache). `OcrSession`/`OcrResult` public contract is preserved
  (hermes-memory consumes `OcrResult`); degrade-to-`undefined`-and-notice preserved. Lang data
  = tessdata_fast `eng`/`chi_sim` `.traineddata`, vendored beside the package under the
  existing symlink-to-external-store convention. `tesseract.js` becomes a removed dependency.
  Sequential dependency: smart mode's scan-figure band (01/02) is tuned against the settled
  engine — 04 runs first (chosen slot). D6 is SHIPPED (PR #1920).
- **D7 — file2md ships in the s2-agent-sh deploy tree with its OCR assets, and the deployed
  binary gets an OCR e2e (user-directed 2026-08-23).** The registry's `excludeReason` flips to
  a `deploy:` block with `copy:`/`vendor:` entries carrying `dist/tesseract-core.wasm` + the
  vendored `.traineddata`; the e2e proof is a probe against the deployed dist (`cli file2md`
  on an OCR fixture), not repo-tree inspection. Wasm/asset layout regressions must fail the
  probe.

## Frontier

Ticket 05 (`tickets/05-deploy-file2md-wasm-e2e.md`) — the deploy flip + OCR e2e against the
deployed s2-agent-sh tree (user-directed; registry already names the flip shape: `deploy.flip
= copy/vendor fields` at `deploy/run.ts:630-631`). Then ticket 01 (no blockers; ladder
skeleton with degrade-notice unblocks 02).

## Fog of war

- **Real-VLM smart run unmeasured** — the E2E mocks the LLM; a live LM Studio pass over the
  USB4 31 figure pages is the validation still owed (ranked next goal).
- **tesseract-wasm image-input path under Bun unproven** (ticket 04 spike is the crux): the
  engine consumes decoded images (ImageBitmap/ImageData-world); our raster produces
  BMP/BGRA — plumbing round-trip must be demonstrated before the swap is real. The
  `OCRClient` high-level worker path is browser-oriented; the in-process low-level `OCREngine`
  is the intended Bun path, but its exact input shape is the spike deliverable.
- **Engine quality delta unmeasured** — tesseract.js fast models vs tesseract-wasm tessdata_fast
  on real scans: same fast-model family in principle, but tokenization/whitespace may differ;
  the smart scan-figure band (≤200 chars) is calibrated on the settled engine via 04's
  sequencing (fog item), not on the old engine's output.
- **Lang asset re-fetch required** — `.traineddata.gz` → raw `.traineddata` (tessdata_fast)
  via the external-store symlink; eng/chi_sim sizes re-measured (old gz budget ~4.4 MB).
- **Deploy `copy:`/`vendor:` entries for the wasm trio** (tesseract-core.wasm + fallback +
  worker) remain a deploy-flip follow-up — same class as the pdfium note in ADR-0001.
- **Thresholds tuned on one corpus** (USB4 CLEAN spec). Other doc shapes (papers, slides,
  posters) may need band adjustments — visible as fixture updates, not silent drift.
- **Scan-figure OCR band (≤200 chars) is a hypothesis** — no measured scan-figure corpus yet.
- **Figure-description prompt quality unmeasured** — `figureHint` wording is first-draft;
  description usefulness needs a human read on a real figure page.

## Cross-effort links

- **Supersedes (scoped)**: `.planning/2026-08-23-file2md-vision-extraction` D3 — the advisory
  `--extract vlm --pages <list>` path becomes the `smart` mode; its D1/D2 (guards, pre-wire)
  stand.
- **Builds-on**: `.planning/2026-08-23-file2md-bun-only-redesign` — the v2 bun-only pipeline
  (`src/pipeline.ts`, `src/vlm/*`) and the #1913 empty-output guard the ladder degrades
  through.
- **Shares-decision-with**: `.planning/2026-08-21-vision-tier-centralization` — exactly one
  vision resolution leaf (`resolveVisionLLM`); smart wraps it softly instead of adding a
  second leaf.
