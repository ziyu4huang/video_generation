import { describe, expect, test } from "bun:test";
import {
  EM_ADVANCE,
  isFullWidth,
  lineCapacityEms,
  textEms,
} from "../lib/text-extent.ts";
import { TITLE_BAND, TYPE_SCALE } from "../lib/deck-theme.ts";

describe("character classes", () => {
  test("an ideograph is exactly one em", () => {
    expect(textEms("一")).toBe(1);
    expect(textEms("一".repeat(24))).toBe(24);
  });

  test("CJK punctuation and the em dash are full width", () => {
    // This is the class that made the defect: a naive `.length` or a Latin
    // advance reads "——" as two narrow characters, when PingFang sets it as
    // two full ems. Measured 2026-08-22: 16 em dashes span 5.800 in at 26 pt,
    // i.e. 1.00 em each — the same as 16 ideographs (5.766 in).
    for (const ch of ["—", "，", "。", "、", "…", "→", "＋", "（", "」"]) {
      expect([ch, textEms(ch)]).toEqual([ch, 1]);
    }
  });

  test("curly quotes are deliberately NOT full width", () => {
    // They are equally at home in an English title. Guessing full width there
    // costs more than the em it would win; see text-extent.ts.
    expect(textEms("“")).toBeLessThan(1);
  });

  test("an astral ideograph counts once, not twice", () => {
    // "𠀋" is U+2000B — two UTF-16 units, one character. `.length` says 2.
    expect("𠀋".length).toBe(2);
    expect(textEms("𠀋")).toBe(1);
  });

  test("Latin buckets are ordered narrow < other < wide < full", () => {
    expect(textEms("i")).toBe(EM_ADVANCE.narrow);
    expect(textEms("n")).toBe(EM_ADVANCE.other);
    expect(textEms("M")).toBe(EM_ADVANCE.wide);
    expect(EM_ADVANCE.narrow).toBeLessThan(EM_ADVANCE.other);
    expect(EM_ADVANCE.other).toBeLessThan(EM_ADVANCE.wide);
    expect(EM_ADVANCE.wide).toBeLessThan(EM_ADVANCE.fullWidth);
  });

  test("isFullWidth walks its ranges in order", () => {
    expect(isFullWidth(0x4e00)).toBe(true); // 一
    expect(isFullWidth(0x2014)).toBe(true); // —
    expect(isFullWidth(0x0041)).toBe(false); // A
    expect(isFullWidth(0x2013)).toBe(false); // – en dash, just below the range
  });
});

/**
 * The East Asian Ambiguous round (2026-08-22, second calibration pass).
 *
 * Every glyph the previous model silently classed `other` (0.6 em) was
 * re-measured with a clean ink window — the window bounds proven first by
 * reproducing the known calibration glyphs (一 1.001, M 0.900, i 0.270) before
 * trusting any new number. Each row's interval is [span/16, span/15] em at
 * 26 pt; the assertion is that the bucket the model assigns lands within
 * ±20 % of the interval's midpoint. `↕ ▲ ◀` rendered blank (no ink) and are
 * deliberately absent: an unmeasurable glyph stays `other` rather than
 * being guessed either way.
 */
describe("calibration — East Asian Ambiguous math glyphs", () => {
  /** [glyph, measured advance interval in ems] */
  const MEASURED: ReadonlyArray<readonly [string, readonly [number, number]]> = [
    ["≥", [0.779, 0.831]],
    ["≤", [0.779, 0.831]],
    ["≈", [0.779, 0.831]],
    ["≠", [0.779, 0.831]],
    ["×", [0.604, 0.645]],
    ["÷", [0.604, 0.645]],
    ["±", [0.604, 0.645]],
    ["▶", [0.875, 0.934]],
    ["↔", [0.95, 1.014]],
    ["℃", [0.929, 0.991]],
  ];

  for (const [g, [lo, hi]] of MEASURED) {
    test(`U+${g.codePointAt(0)!.toString(16)} ${g} → ${textEms(g)} em (measured ${lo}–${hi})`, () => {
      const mid = (lo + hi) / 2;
      expect(Math.abs(textEms(g) - mid) / mid).toBeLessThan(0.2);
    });
  }

  test("↔ and ℃ are full width; ≥ ≤ ≈ ≠ ▶ are wide", () => {
    // The near-em family splits at 0.9: ↔ (0.950–1.014) and ℃ (0.929–0.991)
    // sit against the em, the ≥ family against the wide bucket (0.78).
    expect(textEms("↔")).toBe(EM_ADVANCE.fullWidth);
    expect(textEms("℃")).toBe(EM_ADVANCE.fullWidth);
    for (const g of ["≥", "≤", "≈", "≠", "▶"]) {
      expect(textEms(g)).toBe(EM_ADVANCE.wide);
    }
  });

  test("an unmeasurable glyph stays in other rather than being guessed", () => {
    // ↕ ▲ ◀ render blank through Quick Look — no ink, no number. Leaving them
    // at 0.6 is a recorded unknown, not a claim about their width.
    expect(textEms("↕")).toBe(EM_ADVANCE.other);
  });

  test("· and ° over-reserve in other — the safe direction, kept", () => {
    // Measured 0.482–0.514 and 0.335–0.357 respectively. Both stay at 0.6:
    // over-reserving can only warn early, never pass a wrapping title, and °
    // is superscript-scale in any real title anyway.
    expect(textEms("·")).toBe(EM_ADVANCE.other);
    expect(textEms("°")).toBe(EM_ADVANCE.other);
  });
});

describe("line capacity", () => {
  test("both of OOXML's default insets come off the box", () => {
    // 9.0 in box, 26 pt: (9.0 - 0.2) * 72 / 26.
    expect(lineCapacityEms(9.0, 26)).toBeCloseTo(24.37, 2);
  });

  test("capacity scales inversely with type size", () => {
    expect(lineCapacityEms(9.0, 13)).toBeCloseTo(2 * lineCapacityEms(9.0, 26), 6);
  });
});

/**
 * The calibration receipt.
 *
 * Each row is an ink extent read off a Quick Look render at 120 px/in on
 * 2026-08-22 (PingFang TC bold, 26 pt, the title band). The renderer produced
 * these numbers once; the test compares the model against them and never runs
 * a renderer itself — effort decision D1, "the renderer sees, it never gates".
 *
 * If a bucket in `EM_ADVANCE` is retuned, this is what says whether the tune
 * was an improvement or a guess.
 */
describe("calibration — the model tracks measured ink to ±2%", () => {
  const EM_IN = 26 / 72;
  /** [measured advance width in inches, string] */
  const MEASURED: ReadonlyArray<readonly [number, string]> = [
    [4.929, "Latency is dominated by the"],
    [5.779, "Latency is dominated by the cold"],
    [6.662, "Latency is dominated by the cold path"],
    [7.42, "Latency is dominated by the cold path and"],
    [8.095, "Latency is dominated by the cold path and the"],
    [9.02, "Latency is dominated by the cold path and the retry"],
    [4.013, "延遲主要來自冷啟動路徑"],
    [4.863, "延遲主要來自冷啟動路徑 cold"],
    [5.788, "延遲主要來自冷啟動路徑 cold start"],
    [6.662, "延遲主要來自冷啟動路徑 cold start path"],
    [7.996, "延遲主要來自冷啟動路徑 cold start path budget"],
  ];

  for (const [inches, s] of MEASURED) {
    test(`${s.slice(0, 34)}…`, () => {
      // Relative, not absolute: the tolerance that matters is a percentage of
      // the line, because that is what decides a wrap.
      expect(Math.abs(textEms(s) * EM_IN - inches) / inches).toBeLessThan(0.02);
    });
  }
});

describe("the title band it was built for", () => {
  const budget = lineCapacityEms(TITLE_BAND.withTakeaway.w, TYPE_SCALE.title.sizePt);

  test("the example title that WAS clipped measures over budget", () => {
    // The literal string `examples/deck-composed` shipped before this effort.
    // It rendered on two lines with the accent rule through line two.
    expect(textEms("整顆 SoC 怎麼切、誰接誰——這是 SAS 層要回答的唯一問題")).toBeGreaterThan(budget);
  });

  test("its replacement measures under budget", () => {
    expect(textEms("整顆 SoC 怎麼切、誰接誰，是 SAS 層的唯一問題")).toBeLessThan(budget);
  });

  test("the budget is worth roughly 24 CJK characters", () => {
    // Quick Look wrapped at 26 ideographs and fit 25 (it ignores the right
    // inset). PowerPoint honours both, so the budget lands one lower.
    expect(Math.floor(budget)).toBe(24);
  });
});
