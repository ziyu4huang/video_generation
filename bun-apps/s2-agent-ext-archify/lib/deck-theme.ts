/**
 * deck-theme.ts — the one home for "what colour" and "how big" on a slide.
 *
 * Split out of deck-build.ts when slides stopped being "one diagram per page":
 * six layouts all need the same answers, and answering them inside the builder
 * is how a 420-line module became six responsibilities.
 *
 * Two rules this file exists to enforce:
 *
 *   1. **`PALETTES`' six original keys are frozen.** They are what the `diagram`
 *      layout paints with, and that layout must stay byte-identical to the
 *      pre-composition builder (effort decision D3). New layouts get NEW keys.
 *   2. **Size lives in `TYPE_SCALE`, keyed by semantic role**, never inline at a
 *      call site — the same reason archify's own Cardinal Rule bans inline
 *      colours in an IR.
 */
import type { Theme } from "./shape-ir.ts";

export type { Theme };

/** The 16:9 stage, in inches. Every `FracBox` is a fraction of this. */
export const STAGE = { w: 13.333, h: 7.5 } as const;

/**
 * The content well: everything below the accent rule and above the footer.
 * These are the literal numbers the pre-composition builder used; the `diagram`
 * layout reproduces them exactly.
 */
export const CONTENT = { x: 0.5, y: 1.18, w: 12.333, h: 5.7 } as const;

/**
 * The action-title band, in inches — the one box on a content slide that cannot
 * absorb an overflow.
 *
 * Both shapes are the pre-composition builder's numbers, unchanged (effort
 * decision D3): with a `takeaway` the title gives up height to it. They live
 * here rather than inline in `layouts.ts` because `deck-lint.ts` has to predict
 * a wrap against the same width and font size the layout draws with, and two
 * copies of a number are two numbers.
 *
 * The accent rule sits at y = 1.02 in. A second line of 26 pt type, centred in
 * either band, crosses it — which is the defect this constant exists to let the
 * linter see coming.
 */
export const TITLE_BAND = {
  withTakeaway: { x: 0.5, y: 0.16, w: 9.0, h: 0.56 },
  alone: { x: 0.5, y: 0.22, w: 9.0, h: 0.75 },
} as const;

export interface Palette {
  // ── the original six: frozen, see rule 1 above ────────────────────────────
  slideBg: string;
  title: string;
  accent: string;
  subtitle: string;
  tagBg: string;
  tagBorder: string;
  // ── added for composed layouts ────────────────────────────────────────────
  /** Running body copy and bullet text. */
  body: string;
  /** De-emphasised text: eyebrows, dates, attributions. */
  muted: string;
  /** A statement slide's single large line. */
  statement: string;
  /** Plate behind a grouped region. */
  panelBg: string;
  panelBorder: string;
  /** A section divider's full-bleed field, and the type on it. */
  sectionBg: string;
  sectionFg: string;
}

export const PALETTES: Record<Theme, Palette> = {
  light: {
    slideBg: "FFFFFF",
    title: "0F2740",
    accent: "2563EB",
    subtitle: "6B7280",
    tagBg: "EFF4FA",
    tagBorder: "CBD5E1",
    body: "1F2937",
    muted: "94A3B8",
    statement: "0F2740",
    panelBg: "F8FAFC",
    panelBorder: "E2E8F0",
    sectionBg: "0F2740",
    sectionFg: "F8FAFC",
  },
  dark: {
    slideBg: "0B1220",
    title: "E2E8F0",
    accent: "60A5FA",
    subtitle: "94A3B8",
    tagBg: "1E293B",
    tagBorder: "334155",
    body: "CBD5E1",
    muted: "64748B",
    statement: "F1F5F9",
    panelBg: "111C2E",
    panelBorder: "1E293B",
    sectionBg: "060B14",
    sectionFg: "E2E8F0",
  },
};

/**
 * Every semantic slot a block can occupy. `emit-pptx` and `emit-html` both key
 * off this and nothing else, which is what keeps them from drifting.
 */
export type Role =
  | "coverTitle"
  | "coverSubtitle"
  | "eyebrow"
  | "date"
  | "sectionNumber"
  | "sectionTitle"
  | "title"
  | "takeaway"
  | "body"
  | "bullet"
  | "statement"
  | "attribution"
  | "source"
  | "pageNumber"
  | "tag";

export interface TypeSpec {
  sizePt: number;
  bold?: boolean;
  /** Palette key to paint with. */
  color: keyof Palette;
  /** Letter spacing in points; only eyebrows use it. */
  tracking?: number;
  /** Line spacing multiple, for the multi-line roles. */
  lineSpacing?: number;
  /**
   * Opt this role's long text into `fit: "shrink"` at the emitters. Omitted ⇒
   * the builtin `AUTOFIT_ROLES` set decides, so the six code layouts keep
   * their exact autofit behaviour and a template opts in explicitly.
   */
  autofit?: boolean;
}

/**
 * Sizes are deliberately few and far apart. A deck with eleven type sizes reads
 * as noise; the roles below collapse to four visual tiers (display / heading /
 * body / caption).
 */
export const TYPE_SCALE: Record<Role, TypeSpec> = {
  coverTitle: { sizePt: 44, bold: true, color: "title", lineSpacing: 1.1 },
  coverSubtitle: { sizePt: 18, color: "subtitle", lineSpacing: 1.25 },
  eyebrow: { sizePt: 12, bold: true, color: "accent", tracking: 2 },
  date: { sizePt: 12, color: "muted" },
  sectionNumber: { sizePt: 14, bold: true, color: "accent", tracking: 2 },
  sectionTitle: { sizePt: 40, bold: true, color: "sectionFg", lineSpacing: 1.1 },
  // The pre-composition builder's title: 26 pt bold in `title`. Frozen with it.
  title: { sizePt: 26, bold: true, color: "title" },
  takeaway: { sizePt: 14, color: "accent", lineSpacing: 1.25 },
  body: { sizePt: 16, color: "body", lineSpacing: 1.3 },
  bullet: { sizePt: 16, color: "body", lineSpacing: 1.35 },
  statement: { sizePt: 34, bold: true, color: "statement", lineSpacing: 1.2 },
  attribution: { sizePt: 13, color: "muted" },
  // Footer + page number: 11 pt in `subtitle`, tag chip: 10 pt in `title`.
  source: { sizePt: 11, color: "subtitle" },
  pageNumber: { sizePt: 11, color: "subtitle" },
  tag: { sizePt: 10, color: "title" },
};

/** A nested bullet is one tier down, so the hierarchy is visible at a glance. */
export const BULLET_LEVEL_STEP_PT = 2;

/**
 * The builtin `roleOf`: the type scale itself. Both emitters default to this
 * when a caller passes no template roles, which is what keeps the six code
 * layouts' output byte-identical through the §4.5 refactor.
 */
export function builtinRoleOf(role: string): TypeSpec {
  return (
    TYPE_SCALE[role as Role] ?? { sizePt: 16, color: "body", lineSpacing: 1.3 }
  );
}

/** Font size for a bullet at nesting `level` (0-based). */
export function bulletSizePt(level: number): number {
  return Math.max(10, TYPE_SCALE.bullet.sizePt - level * BULLET_LEVEL_STEP_PT);
}
