/**
 * core/figure.ts — smart-mode figure detection (D2 of the smart-enhance effort).
 *
 * IO-free heuristics pinning the measured caption-only-figure shape: the
 * thresholds are named constants HERE so a drift is a red test, not a silent
 * behavior change.
 *
 *   - Text page: `Figure N-x.` caption AND body ≤ FIGURE_MAX_BODY_CHARS
 *     (1300 — prose pages, where any figure is small and incidental, never
 *     fit the band; that is the "exclude small inline figures" rule).
 *   - Scan page: OCR output ≤ FIGURE_OCR_MAX_CHARS (200 — labels-only OCR).
 */

/** Text-page band cap: caption-only figure pages are short (measured corpus). */
export const FIGURE_MAX_BODY_CHARS = 1300;

/** Scan-page band cap: labels-only OCR output on figure-heavy scans. */
export const FIGURE_OCR_MAX_CHARS = 200;

/** Skip notice a figure page carries when enhancement cannot run (D4). */
export const FIGURE_SKIP_NOTICE = "> Figure detected — vision enhancement skipped (no vision server).";

/** `Figure N-x.` caption shape (digit sub-index; hyphen or en dash). */
export const FIGURE_CAPTION_RE = /\bfigure\s+\d+\s*[-–]\s*\d+\s*\./i;

/**
 * Modern caption shape `Figure N:` (colon REQUIRED — prose references say
 * "Figure 1" or "Figure 1." at sentence end; only real captions use the
 * colon). Measured on the 2026-09-09 kcard-scale corpus (10 modern arXiv
 * papers, 221 pages): 53 caption-bearing pages, NONE matched the legacy
 * `Figure N-x.` shape, and the shortest caption page body was 1452 chars —
 * the legacy 1300 band fired ZERO times on the entire corpus.
 */
export const FIGURE_CAPTION_RE_MODERN = /\bfigure\s+\d+\s*:/i;

/**
 * Modern caption-page band. Above the legacy 1300 because a modern two-column
 * figure page carries its caption PLUS surrounding text (measured caption-page
 * bodies: min 1452, median 3792, max 6286). 3000 catches the thinnest ~20% of
 * caption pages; the caption requirement (not the band) is the discriminator —
 * prose pages never carry `Figure N:` and never fire regardless of length.
 */
export const FIGURE_CAPTION_PAGE_MAX_CHARS = 3000;

/** Manifest figure record for smart-mode pages (additive; schema stays v1). */
export interface FigureRecord {
  detected: boolean;
  enhanced: boolean;
}

/** Text-page detector: caption present AND body within the band. */
export function isTextFigure(body: string): boolean {
  return body.length <= FIGURE_MAX_BODY_CHARS && FIGURE_CAPTION_RE.test(body);
}

/**
 * Modern text-page detector (kcard-scale corpus, 2026-09-09): `Figure N:`
 * caption within the modern band. The legacy spec shape (`Figure N-x.`,
 * caption-ONLY pages ≤ 1300) stays its own detector — different measured
 * semantics, both feed the same smart-lane enhancement.
 */
export function isCaptionFigure(body: string): boolean {
  return body.length <= FIGURE_CAPTION_PAGE_MAX_CHARS && FIGURE_CAPTION_RE_MODERN.test(body);
}

/** Scan-page detector: OCR output within the labels-only band. */
export function isScanFigure(ocrText: string): boolean {
  return ocrText.length <= FIGURE_OCR_MAX_CHARS;
}
