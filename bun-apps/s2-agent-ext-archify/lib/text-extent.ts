/**
 * text-extent.ts — how wide does this string set, in ems?
 *
 * archify never measures glyphs: a block declares a box and PowerPoint wraps
 * inside it (`emit-pptx.ts`). That contract holds for LAYOUT. It does not hold
 * for the one place where the box cannot absorb an overflow — the action-title
 * band, whose accent rule sits at a fixed y, so a second title line is struck
 * through by the rule and clipped by the content well. Something has to predict
 * that wrap before the deck is written, and this module is the smallest thing
 * that can: a bucketed advance estimate, no font tables, no renderer.
 *
 * **It estimates. It does not measure.** Callers must treat a result near a box
 * width as "unknown", not as "fits" — see `deck-lint.ts`, which fails only past
 * the budget and warns inside a margin of it.
 *
 * ## Calibration (measured 2026-08-22 on this machine, PingFang TC bold 26 pt)
 *
 * Probe decks were rendered through macOS Quick Look and the ink bounding box
 * of the title band read back per slide, at 120 px/in:
 *
 * - A repeated glyph 16× gives its advance within `span/16 … span/15`:
 *   `一` `—` `，` `…` `→` `＋` all land at 1.00 em; `M` 0.90, `A` 0.70,
 *   `n` 0.58, `e` 0.58, `0` 0.60, `i` 0.27.
 * - Eleven mixed CJK/Latin prose titles of growing length agree with the
 *   buckets below to within **±1.7 %** of their measured extent.
 *
 * Quick Look breaks lines against the FULL box width, ignoring the right inset;
 * PowerPoint honours both insets (`lineCapacityEms` below). The budget is
 * therefore stricter than the renderer used to calibrate it, which is the safe
 * direction: a title this module passes fits in both.
 */

/**
 * Advance per character class, in ems. Four buckets, not a metrics table — a
 * per-glyph table would be tied to one font and would rot the first time a deck
 * sets `defaults.font` to something else.
 */
export const EM_ADVANCE = {
  /** CJK ideographs, kana, hangul, fullwidth forms. Exactly one em by design. */
  fullWidth: 1.0,
  /** The word space. */
  space: 0.29,
  /** `iljtIfr` and most punctuation: well under half an em. */
  narrow: 0.31,
  /** Capitals and the wide lowercase pair `m` `w`. */
  wide: 0.78,
  /** Everything else — lowercase Latin and digits. */
  other: 0.6,
} as const;

/**
 * OOXML's default text-box insets, in inches (`lIns`/`rIns` = 91440 EMU). Not
 * set anywhere in `emit-pptx.ts`, so every text box gets these.
 */
export const TEXT_INSET_IN = 0.1;

/**
 * Code-point ranges a CJK font sets at a full em.
 *
 * The East Asian Width classes `W` and `F`, plus the handful of `A`
 * (Ambiguous) code points that a Chinese or Japanese face renders full width
 * and that show up in real titles: the dashes, the ellipses, the arrows and
 * `※`. Curly quotes are deliberately NOT here — they are equally at home in an
 * English title, where they are narrow, and guessing wrong there costs more
 * than the em it would win.
 */
const FULL_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2014, 0x2015], // em dash, horizontal bar
  [0x2025, 0x2026], // two-dot leader, horizontal ellipsis
  [0x203b, 0x203b], // reference mark
  [0x2190, 0x2193], // arrows
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff], // kana, bopomofo, compatibility
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms, small form variants
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x20000, 0x3ffff], // CJK Extensions B and beyond
];

const NARROW = /[iljtIfr.,:;'"|!()[\]-]/;
const WIDE = /[A-Zmw@%&]/;

/** Does a CJK face set this code point at one full em? */
export function isFullWidth(codePoint: number): boolean {
  for (const [lo, hi] of FULL_WIDTH_RANGES) {
    if (codePoint < lo) return false; // ranges are sorted; nothing later can match
    if (codePoint <= hi) return true;
  }
  return false;
}

/**
 * Estimated set width of `s`, in ems. Iterates by code point, so an astral
 * ideograph counts once rather than twice.
 */
export function textEms(s: string): number {
  let ems = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (isFullWidth(cp)) ems += EM_ADVANCE.fullWidth;
    else if (ch === " ") ems += EM_ADVANCE.space;
    else if (NARROW.test(ch)) ems += EM_ADVANCE.narrow;
    else if (WIDE.test(ch)) ems += EM_ADVANCE.wide;
    else ems += EM_ADVANCE.other;
  }
  return ems;
}

/**
 * How many ems fit on ONE line of a text box `widthIn` inches wide at
 * `sizePt`, after OOXML's default left and right insets.
 */
export function lineCapacityEms(widthIn: number, sizePt: number): number {
  return ((widthIn - 2 * TEXT_INSET_IN) * 72) / sizePt;
}
