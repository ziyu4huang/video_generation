# Spec — file2md smart enhance ladder

## Problem Statement

Today a born-digital spec PDF converts with every page `provenance: text`, but pages that are
mostly figures come out as a bare `Figure N-x. …` caption — the diagram itself is a vector
drawing the text layer cannot read (measured 2026-08-23: 31 such pages < 900 B in the 839-page
USB4 CLEAN spec). Getting the diagram content requires the caller to hand-pick pages and opt
into a whole-document VLM mode (`--extract vlm --pages <list>`) at ~90 s per image. Scanned
pages face the same hole: OCR recovers their text, but a figure on a scan stays invisible.
There is no mode that adapts per page: text when text is enough, OCR when the text layer is
thin, vision only where a real figure sits.

## Solution

A fourth pipeline mode, `--extract smart`, in `s2-agent-ext-file2md`. Per PDF page the
pipeline: (1) extracts the text layer and, when it is usable and the page carries no
substantial figure, stops there; (2) when the text layer is thin, rasterizes and OCRs; (3)
when the page carries a figure (excluding small inline ones), describes it with the local
vision LLM and **appends** the description as a `## Figure (vision)` section under the
untouched original body. With no vision server, figure pages get a skip notice and a manifest
flag — a page never fails because enhancement did not run. Existing modes are unchanged.

## User Stories

1. As a knowledge worker converting a spec PDF, I want a `smart` mode so that figure pages
   are described by the local VLM without me hand-picking pages or opting into whole-doc VLM.
2. As an offline user, I want `smart` mode to never require a vision server, so my text+OCR
   conversion still completes with figures flagged for later enhancement.
3. As a consumer of the converted markdown, I want the original text untouched and the vision
   description in a clearly marked appended section, so I can trust what came from where.
4. As a CLI user, I want `--extract smart` listed in help with an example, so I can discover
   the mode.
5. As a developer, I want the ladder covered by fixture-driven E2E tests, so the detection
   thresholds and the degrade behavior cannot drift silently.
6. As a resuming session, I want figure flags recorded in the manifest, so a re-run
   (`--pages` or resume) does not redo enhancement work it already did.

## Implementation Decisions

- **Mode semantics.** `smart` joins `text|ocr|vlm` in the mode type and parser; `auto` keeps
  converging on `ocr`. Vision resolution in smart mode is *soft*: the existing vision
  resolution leaf is attempted, and on failure the run continues with figures flagged. `vlm`
  mode keeps its hard resolve.
- **Figure detection (D2).** A pure, IO-free detector module owns two rules:
  - Text pages: body contains a `Figure N-x.` caption AND body length ≤ 1300 chars
    (`FIGURE_MAX_BODY_CHARS`). Prose pages — where any figure is small and incidental — never
    fit the band, which is the "exclude small" rule.
  - Scan pages (text layer < 8 chars): the page is OCR'd as today; OCR output ≤ 200 chars
    (`FIGURE_OCR_MAX_CHARS`) marks the page as figure-heavy (labels-only OCR).
- **Enhancement output (D3).** Append `## Figure (vision)` after the original body; page
  frontmatter gains `enhanced: vision`; provenance stays `text`/`ocr`; the manifest page
  record gains an additive `figure: { detected, enhanced }` object (manifest schema version
  unchanged — additive field).
- **Vision call.** The existing page-explanation agent gains a figure hint that switches the
  prompt to describe-the-diagram phrasing. The existing empty-output guard and retry wrapper
  are reused; a rejected/empty result degrades to the skip notice.
- **Rasterization budget.** A text figure page is the only new rasterization in smart mode
  (rendered once when enhancement can run). Scan pages reuse the raster already produced for
  OCR. Prose pages never rasterize.
- **Concurrency.** Figure vision calls run under the existing per-document pool
  (`PI_VLM_CONCURRENCY`), same as vlm mode.
- **CLI/extension surface.** The mode enum, help text, and the extension tool's mode
  parameter gain `smart`; no other tool/CLI surface changes.
- **Degrade notice (D4).** No server, or vision failure: append
  `> Figure detected — vision enhancement skipped (no vision server).` and record
  `enhanced: false`; log one warning line per run (not per page).

## Testing Decisions

- **E2E is the gate the user asked for.** A dedicated smart-mode suite follows the
  established pipeline-v2 pattern: the REAL pipeline runs against pdf-lib fixtures, only the
  wasm/worker pair (`raster/pdf.ts`, `ocr/ocr.ts`) is stubbed, and the vision LLM is mocked —
  deterministic, offline, no LM Studio.
- Fixtures pin the ladder branches: caption-only figure page fires vision; prose page with an
  inline `Figure` mention never fires; scan page with short OCR fires; scan page with long OCR
  does not; no-VLM run flags and continues; ladder-order assertion (prose pages never
  rasterize, scan pages rasterize once).
- Detector unit tests cover band boundaries (1299/1300/1301 chars, caption regex variants)
  and the OCR band (199/200/201 chars).
- Tests assert external behavior (page md content, frontmatter, manifest records, emit
  events), never implementation internals.
- Existing-mode tests must stay green — smart is additive, not a rewrite.

## Out of Scope

- Making `auto` the smart ladder (default change) — rejected this effort (D1).
- Auto-detecting figures on non-PDF inputs (images already OCR/vision; office formats have no
  page raster).
- Raster ink-coverage detection for uncaptioned diagrams (approach B, charted-and-rejected).
- A figure detector that distinguishes vector diagrams from photos or screenshots.
- Re-running a live LM Studio validation pass over the USB4 figure pages (follow-up goal).
- Any change to `vlm` mode semantics or the vision-tier resolution leaf itself.

## Further Notes

- The prior effort (`.planning/2026-08-23-file2md-vision-extraction`) documented the
  caption-only figure gap and the `--extract vlm --pages <list>` advisory path; its D3
  remains true for non-smart modes — smart is the opt-in automation of exactly that path.
- Thresholds are named constants in the detector module precisely so the E2E fixtures can
  pin them; adjusting a threshold is a deliberate code + fixture change.
- The `CONTEXT.md` glossary (`bun-apps/s2-agent-ext-file2md/`) should gain the new terms
  (smart mode, figure page, enhance ladder) when the tickets land — domain-modeling rule.
