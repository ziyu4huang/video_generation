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

/** Manifest figure record for smart-mode pages (additive; schema stays v1). */
export interface FigureRecord {
  detected: boolean;
  enhanced: boolean;
}

/** Text-page detector: caption present AND body within the band. */
export function isTextFigure(body: string): boolean {
  return body.length <= FIGURE_MAX_BODY_CHARS && FIGURE_CAPTION_RE.test(body);
}

/** Scan-page detector: OCR output within the labels-only band. */
export function isScanFigure(ocrText: string): boolean {
  return ocrText.length <= FIGURE_OCR_MAX_CHARS;
}
