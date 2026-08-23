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

- [ ] 01 — smart mode plumbing + figure detection (no vision) — mode parses, soft vision
      resolve, figure.ts detectors, figure-flag manifest record + skip notice, non-figure
      pages unchanged. Blockers: none.
- [ ] 02 — vision enhance on figure pages — figureHint prompt, append `## Figure (vision)`,
      scan-page OCR-band path, guard degrade, concurrency. Blockers: 01.
- [ ] 03 — E2E suite hardening + docs + CLI surface. Blockers: 01, 02.

**Execution order:** 01 → 02 → 03 (every edge is a hard `blocking:` edge — no choice pairs)

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

## Frontier

Ticket 01 (`tickets/01-smart-mode-plumbing.md`) — no blockers; the ladder skeleton with
degrade-notice behavior is demoable on its own and unblocks 02's vision path.

## Fog of war

- **Real-VLM smart run unmeasured** — the E2E mocks the LLM; a live LM Studio pass over the
  USB4 31 figure pages is the validation still owed (ranked next goal).
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
