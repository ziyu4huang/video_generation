/**
 * slide-model.ts — the format-neutral seam between authoring and rendering.
 *
 * A layout is a pure function `Slide -> PlacedBlock[]`. A block says WHERE it
 * sits and WHAT it is; it never says how wide its text will be.
 *
 * ## Why boxes and not glyph metrics
 *
 * This package has a hard zero-browser contract (`__tests__/no-browser-deps.test.ts`),
 * so there is no layout engine and therefore no glyph advances to measure. The
 * design turns that constraint into the architecture:
 *
 *   > A block declares a box. The target environment wraps text inside it.
 *
 * PowerPoint wraps and autofits inside a text box; CSS wraps inside a positioned
 * div. Neither needs us to know how wide a glyph is — which is also why this
 * path gets CJK right where `lib/pptx-shapes.ts` cannot. That module places SVG
 * text with `wrap: false` and an estimated width tuned for Latin advances; it is
 * reproducing a diagram whose line breaks were already decided by the renderer,
 * a genuinely different problem from laying out a paragraph.
 *
 * Boxes are FRACTIONS of the stage (0..1), not inches, so a layout can be read
 * and diffed without knowing the stage size — and so a fractions-vs-inches
 * mix-up shows up immediately as an out-of-range box rather than as a shape
 * quietly parked off-slide.
 */
import { CONTENT, STAGE, type Role } from "./deck-theme.ts";

export type { Role };

/** A box in stage-relative fractions: every value lies in [0, 1]. */
export interface FracBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BulletItem {
  text: string;
  /** Nesting depth, 0-based. Only 0 and 1 are used by the shipped layouts. */
  level?: number;
}

/**
 * What goes inside a placed block. `role` is a `string`, not `Role`: layout
 * templates declare their own role names, and `Role` widens here — the emitter
 * boundary — only. Code layouts keep the narrow union via `layouts.ts`'s
 * private `text()` wrapper.
 */
export type BlockContent =
  | { kind: "text"; role: string; text: string }
  | { kind: "bullets"; role: string; items: BulletItem[] }
  /**
   * A rendered archify diagram. `ir` is an absolute path to the IR .json.
   *
   * `fit: "content"` scales to the union of what the diagram actually paints,
   * not to its canvas — the vendored renderers emit canvases with dead margins
   * (a dataflow canvas can carry 42 % trailing emptiness), and centring a
   * mostly-empty canvas parks the visible diagram small and off-centre
   * (visual-fidelity P4). Omitted ⇒ canvas fit, which the D3-locked `diagram`
   * layout must keep.
   */
  | { kind: "diagram"; ir: string; fit?: "content" }
  /** The accent rule under a slide title. */
  | { kind: "rule" }
  /** A flat plate: the tag chip's field, or a section divider's full bleed. */
  | { kind: "panel"; tone: "tag" | "section" }
  /**
   * A native PowerPoint table (`<a:tbl>` inside a graphicFrame — effort
   * decision D5, probed 2026-08-22). Two roles paint it: `headerRole` for the
   * column-head row, `role` for every body row. No colour literals anywhere.
   */
  | { kind: "table"; columns: string[]; rows: string[][]; role: string; headerRole: string };

export interface PlacedBlock {
  box: FracBox;
  content: BlockContent;
  align?: "left" | "center" | "right";
  valign?: "top" | "middle" | "bottom";
}

/** The six shipped layouts. */
export type SlideLayout = "title" | "section" | "bullets" | "split" | "diagram" | "statement";

export const SLIDE_LAYOUTS: readonly SlideLayout[] = [
  "title",
  "section",
  "bullets",
  "split",
  "diagram",
  "statement",
] as const;

/**
 * One authored slide.
 *
 * Field names follow consulting practice deliberately: `title` is an ACTION
 * TITLE — the slide's takeaway as a complete sentence, not a label — because
 * stacked action titles are what make a deck's argument readable end to end
 * (horizontal logic). `lib/deck-lint.ts` checks that advisorily.
 */
export interface Slide {
  /** Omitted + `ir` present ⇒ "diagram". See `resolveLayout`. */
  layout?: SlideLayout;
  /** The action title. Required by `parseManifest` for every layout. */
  title: string;
  /** Footer line. On a `title` slide, the cover's second line. */
  subtitle?: string;
  /** The "so what" band under the title. */
  takeaway?: string;
  /** Attribution footnote; replaces `subtitle` in the footer when both exist. */
  source?: string;
  /** `bullets` / `split`. Plain strings are level 0. */
  bullets?: (BulletItem | string)[];
  /** `diagram` / `split`. Path to an archify IR, relative to the manifest. */
  ir?: string;
  /** `statement`. */
  statement?: string;
  /** `statement` attribution, `title` eyebrow. */
  eyebrow?: string;
  attribution?: string;
  /** `title` slide date line. */
  date?: string;
  /** `section` divider's kicker, e.g. "02". */
  sectionNumber?: string;
  /** `split` — the diagram column's share of the content width. Default 0.6. */
  ratio?: number;
  /**
   * The `table` layout template's slots (effort ticket 05): column names and
   * one array of cells per row. `deck-lint.ts` reads them for the row-count
   * advisory and the inline-colour sweep; the template resolves them into a
   * `table` block via `{slide.columns}` / `{slide.rows}`.
   */
  columns?: string[];
  rows?: string[][];
  /**
   * `diagram`/`split`. `"expand"` ⇒ the deck pipeline expands the IR's
   * `meta.views` into this overview slide plus one guided build slide per
   * view (title = view label, takeaway = view note, non-focus content
   * dimmed in the pptx projection). The HTML artifact stays interactive.
   */
  views?: "expand";
  /** Internal, set by views expansion: dim everything outside these node ids. */
  viewFocus?: string[];
  /** Speaker notes; passed through to the PPTX, ignored by the HTML emitter. */
  notes?: string;
}

export interface LayoutCtx {
  /** 0-based slide index. */
  index: number;
  total: number;
  /** The deck tag shown in the chip, e.g. "archify deck". */
  tag: string;
}

/**
 * Which layout a slide uses.
 *
 * A slide carrying `ir` and no `layout` IS a diagram slide — that inference is
 * the whole backward-compatibility story (effort decision D3). Every manifest
 * written before layouts existed keeps working with no edit and no version
 * field, because the shape of the old slide already says what it is.
 */
export function resolveLayout(slide: Slide): SlideLayout {
  if (slide.layout) return slide.layout;
  if (slide.ir) return "diagram";
  if (slide.statement) return "statement";
  if (slide.bullets) return "bullets";
  return "title";
}

/** Normalize the `string | BulletItem` authoring shorthand. */
export function normalizeBullets(items: Slide["bullets"]): BulletItem[] {
  if (!items) return [];
  return items.map((b) =>
    typeof b === "string" ? { text: b, level: 0 } : { text: b.text, level: b.level ?? 0 }
  );
}

// ── stage conversion ─────────────────────────────────────────────────────────

/** A box in inches on the 13.333 x 7.5 stage. */
export interface InchBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Fractions → inches. The ONLY place the stage size is applied. */
export function toInches(box: FracBox): InchBox {
  return {
    x: box.x * STAGE.w,
    y: box.y * STAGE.h,
    w: box.w * STAGE.w,
    h: box.h * STAGE.h,
  };
}

/** Inches → fractions, for expressing the legacy chrome coordinates. */
export function fromInches(box: InchBox): FracBox {
  return {
    x: box.x / STAGE.w,
    y: box.y / STAGE.h,
    w: box.w / STAGE.w,
    h: box.h / STAGE.h,
  };
}

/** The content well as a fraction box — what full-width layouts fill. */
export const CONTENT_FRAC: FracBox = fromInches(CONTENT);

// ── debug formatting ─────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toFixed(4).replace(/\.?0+$/, "") || "0";
}

/**
 * One line per block, in order. Goldens use this rather than JSON so a diff
 * reads as "this box moved" instead of re-indented punctuation — the same
 * reasoning as `formatShapeIR`.
 */
export function formatBlocks(blocks: PlacedBlock[]): string {
  return blocks
    .map((b) => {
      const box = `[${fmt(b.box.x)} ${fmt(b.box.y)} ${fmt(b.box.w)} ${fmt(b.box.h)}]`;
      const pos = `${b.align ?? "left"}/${b.valign ?? "top"}`;
      const c = b.content;
      let what: string;
      switch (c.kind) {
        case "text":
          what = `text:${c.role} ${JSON.stringify(c.text)}`;
          break;
        case "bullets":
          what = `bullets:${c.role} ${c.items.map((i) => `${i.level ?? 0}:${JSON.stringify(i.text)}`).join(" ")}`;
          break;
        case "diagram":
          what = `diagram ${JSON.stringify(c.ir)}${c.fit ? ` fit=${c.fit}` : ""}`;
          break;
        case "rule":
          what = "rule";
          break;
        case "panel":
          what = `panel:${c.tone}`;
          break;
        case "table":
          what =
            `table:${c.role}/${c.headerRole} ${JSON.stringify(c.columns)} ` +
            c.rows.map((r) => JSON.stringify(r)).join(" ");
          break;
      }
      return `${box} ${pos} ${what}`;
    })
    .join("\n");
}
