/**
 * core/figure.test.ts — smart-mode figure detector unit tests (D5).
 *
 * Pins the band boundaries (1299/1300/1301 chars, OCR 199/200/201) and the
 * caption regex variants so a threshold drift is a red test, not a silent
 * behavior change.
 */
import { describe, expect, test } from "bun:test";
import {
  FIGURE_CAPTION_RE,
  FIGURE_MAX_BODY_CHARS,
  FIGURE_OCR_MAX_CHARS,
  FIGURE_SKIP_NOTICE,
  isScanFigure,
  isTextFigure,
} from "./figure.ts";

/** A body of exactly `len` chars containing the canonical caption somewhere. */
function bodyWithCaption(len: number): string {
  const cap = "Figure 3-4. The quick brown fox jumps over the lazy dog.";
  return cap + "x".repeat(Math.max(0, len - cap.length));
}

describe("isTextFigure — caption regex variants", () => {
  test("accepts the canonical `Figure N-x.` caption shapes", () => {
    const captions = [
      "Figure 3-4. The block diagram.",
      "figure 12-8. lowercase caption",
      "FIGURE 3-4. uppercase caption",
      "Figure 3–4. en-dash caption",
      "Figure 3 - 4. spaced dash",
      "Figure 35-4. USB4 spacing compliance matrix.",
      "Figure 3-4.",
      "intro text.\nFigure 4-2. The transmit section.\nmore text",
      "Figure  3-4. double space",
    ];
    for (const c of captions) {
      expect(isTextFigure(c)).toBe(true);
      expect(FIGURE_CAPTION_RE.test(c)).toBe(true);
    }
  });

  test("rejects prose mentions that are not a `Figure N-x.` caption", () => {
    const prose = [
      "The result is shown in Figure 4 without a section numeral.",
      "Figure 3-4 has no trailing period",
      "See Fig. 3-4. for the short form",
      "Figure 3.4. label with a dot only",
      "This long prose paragraph mentions Figure in passing but carries no caption number.",
      "Figure-3-4. spaced from the word word-start",
    ];
    for (const p of prose) {
      expect(isTextFigure(p)).toBe(false);
      expect(FIGURE_CAPTION_RE.test(p)).toBe(false);
    }
  });
});

describe("isTextFigure — band boundaries", () => {
  test("1299/1300 chars with a caption are figures; 1301 is not", () => {
    expect(isTextFigure(bodyWithCaption(FIGURE_MAX_BODY_CHARS - 1))).toBe(true);
    expect(isTextFigure(bodyWithCaption(FIGURE_MAX_BODY_CHARS))).toBe(true);
    expect(isTextFigure(bodyWithCaption(FIGURE_MAX_BODY_CHARS + 1))).toBe(false);
  });

  test("a caption-less body never flags, whatever its length", () => {
    expect(isTextFigure("x".repeat(FIGURE_MAX_BODY_CHARS))).toBe(false);
    expect(isTextFigure("x".repeat(10))).toBe(false);
  });
});

describe("isScanFigure — OCR band boundaries", () => {
  test("199/200 chars are figure-heavy; 201 is not", () => {
    expect(isScanFigure("x".repeat(FIGURE_OCR_MAX_CHARS - 1))).toBe(true);
    expect(isScanFigure("x".repeat(FIGURE_OCR_MAX_CHARS))).toBe(true);
    expect(isScanFigure("x".repeat(FIGURE_OCR_MAX_CHARS + 1))).toBe(false);
  });

  test("the skip notice is the D4 literal", () => {
    expect(FIGURE_SKIP_NOTICE).toBe("> Figure detected — vision enhancement skipped (no vision server).");
  });
});
