/**
 * layouts.ts — six pure functions `Slide -> PlacedBlock[]`.
 *
 * Nothing in this module imports pptxgenjs, emits HTML, or names a colour. A
 * layout decides WHERE things go and WHAT they are; `deck-theme.ts` decides how
 * they look and the emitters decide how they are drawn.
 *
 * ## The compatibility constraint
 *
 * `diagram` is not a new layout — it is the pre-composition builder's private
 * `addChrome()` + one full-width diagram, re-expressed. Its coordinates are the
 * literal inch values that builder used, converted once through `fromInches`,
 * and its BLOCK ORDER matches the order those shapes were added in. That is
 * what lets every manifest written before layouts existed build unchanged
 * (effort decision D3), and `__tests__/layouts.test.ts` pins the numbers.
 *
 * Everything else is laid out on the same 13.333 x 7.5 stage in inches and
 * converted the same way, so the whole file reads in one unit.
 */
import {
  CONTENT,
  TITLE_BAND,
  type Role,
} from "./deck-theme.ts";
import { at } from "./blocks.ts";
import {
  normalizeBullets,
  type InchBox,
  type LayoutCtx,
  type PlacedBlock,
  type Slide,
  type SlideLayout,
} from "./slide-model.ts";

/**
 * Text block constructor, narrow-`Role` on purpose: the six code layouts keep
 * the union's type safety even though `BlockContent.role` widens to `string`
 * at the emitter boundary (§4.5). Box assembly goes through the shared `at`.
 */
function text(box: InchBox, role: Role, s: string, align?: PlacedBlock["align"], valign?: PlacedBlock["valign"]): PlacedBlock {
  return at(box, { kind: "text", role, text: s }, align, valign);
}

// ── shared chrome ────────────────────────────────────────────────────────────

/**
 * The frame every content slide wears: tag chip, action title, accent rule,
 * source footer, page number.
 *
 * The five inch boxes below are the pre-composition builder's, unchanged. The
 * only geometry that moves is the title band, and only when a `takeaway` is
 * present — with no takeaway the output is coordinate-for-coordinate what it
 * was.
 *
 * Exported so layout templates wear the SAME chrome (§4.3): a template's
 * blocks must be indistinguishable from a code layout's, and chrome is where
 * a second implementation would drift first.
 */
export function chrome(slide: Slide, ctx: LayoutCtx, opts: { title?: boolean } = {}): PlacedBlock[] {
  const withTitle = opts.title !== false;
  const hasTakeaway = withTitle && !!slide.takeaway;
  const blocks: PlacedBlock[] = [
    at({ x: 9.7, y: 0.28, w: 3.13, h: 0.4 }, { kind: "panel", tone: "tag" }),
    text({ x: 9.7, y: 0.28, w: 3.13, h: 0.4 }, "tag", ctx.tag, "center", "middle"),
  ];

  if (withTitle) {
    blocks.push(
      text(
        hasTakeaway ? TITLE_BAND.withTakeaway : TITLE_BAND.alone,
        "title",
        slide.title,
        "left",
        "middle"
      )
    );
    if (hasTakeaway) {
      blocks.push(
        text({ x: 0.5, y: 0.7, w: 12.333, h: 0.3 }, "takeaway", slide.takeaway!, "left", "middle")
      );
    }
    blocks.push(at({ x: 0.5, y: 1.02, w: CONTENT.w, h: 0.035 }, { kind: "rule" }));
  }

  // The footer text is emitted even when empty — the pre-composition builder
  // did (`opts.subtitle ?? ""`), and the text-run count is part of the D3 lock.
  blocks.push(
    text({ x: 0.5, y: 7.0, w: 11.4, h: 0.4 }, "source", slide.source ?? slide.subtitle ?? "", "left", "middle"),
    text(
      { x: 11.9, y: 7.0, w: 0.94, h: 0.4 },
      "pageNumber",
      `${ctx.index + 1} / ${ctx.total}`,
      "right",
      "middle"
    )
  );
  return blocks;
}

// ── the six ──────────────────────────────────────────────────────────────────

/** Cover. No chrome: a cover with a page number reads as a content slide. */
function titleLayout(slide: Slide, _ctx: LayoutCtx): PlacedBlock[] {
  const blocks: PlacedBlock[] = [];
  if (slide.eyebrow) {
    blocks.push(text({ x: 0.9, y: 2.15, w: 11.5, h: 0.35 }, "eyebrow", slide.eyebrow, "left", "bottom"));
  }
  blocks.push(text({ x: 0.9, y: 2.6, w: 11.0, h: 1.9 }, "coverTitle", slide.title, "left", "top"));
  blocks.push(at({ x: 0.9, y: 4.62, w: 2.6, h: 0.05 }, { kind: "rule" }));
  if (slide.subtitle) {
    blocks.push(text({ x: 0.9, y: 4.95, w: 10.5, h: 1.1 }, "coverSubtitle", slide.subtitle, "left", "top"));
  }
  if (slide.date) {
    blocks.push(text({ x: 0.9, y: 6.5, w: 6.0, h: 0.35 }, "date", slide.date, "left", "middle"));
  }
  return blocks;
}

/** Divider. A full-bleed field so the deck visibly changes chapter. */
function sectionLayout(slide: Slide, ctx: LayoutCtx): PlacedBlock[] {
  const blocks: PlacedBlock[] = [
    at({ x: 0, y: 0, w: 13.333, h: 7.5 }, { kind: "panel", tone: "section" }),
  ];
  blocks.push(
    text(
      { x: 0.9, y: 2.9, w: 3.0, h: 0.4 },
      "sectionNumber",
      slide.sectionNumber ?? String(ctx.index + 1).padStart(2, "0"),
      "left",
      "bottom"
    )
  );
  blocks.push(text({ x: 0.9, y: 3.35, w: 11.0, h: 1.7 }, "sectionTitle", slide.title, "left", "top"));
  return blocks;
}

/**
 * One bullet column. Capped at 10.5 in rather than the full 12.333: a line of
 * body text spanning the whole stage is past the width the eye tracks back
 * across comfortably.
 */
function bulletsLayout(slide: Slide, ctx: LayoutCtx): PlacedBlock[] {
  const top = slide.takeaway ? 1.5 : 1.4;
  return [
    ...chrome(slide, ctx),
    at(
      { x: 0.5, y: top, w: 10.5, h: 7.0 - top - 0.5 },
      { kind: "bullets", role: "bullet", items: normalizeBullets(slide.bullets) },
      "left",
      "top"
    ),
  ];
}

/** The asymmetric two-column workhorse: diagram left, points right. */
function splitLayout(slide: Slide, ctx: LayoutCtx): PlacedBlock[] {
  const ratio = clampRatio(slide.ratio);
  const gap = 0.4;
  const top = slide.takeaway ? 1.5 : 1.4;
  const h = 7.0 - top - 0.4;
  const usable = CONTENT.w - gap;
  const leftW = usable * ratio;
  const rightW = usable - leftW;
  const blocks: PlacedBlock[] = [...chrome(slide, ctx)];
  if (slide.ir) {
    // Content fit (P4): a split column is narrow, so canvas dead margins waste
    // a large share of it — on the shipped example, 42 % of the artifact's
    // canvas width is empty and the visible diagram filled only 4.13 of 7.16
    // inches. The `diagram` layout stays canvas-fit: its geometry is D3-locked.
    blocks.push(at({ x: 0.5, y: top, w: leftW, h }, { kind: "diagram", ir: slide.ir, fit: "content" }));
  }
  blocks.push(
    at(
      { x: 0.5 + leftW + gap, y: top, w: rightW, h },
      { kind: "bullets", role: "bullet", items: normalizeBullets(slide.bullets) },
      "left",
      "top"
    )
  );
  return blocks;
}

/** 0.35..0.8, so neither column collapses to a sliver. Default 0.6. */
function clampRatio(r: number | undefined): number {
  if (typeof r !== "number" || !Number.isFinite(r)) return 0.6;
  return Math.min(0.8, Math.max(0.35, r));
}

/**
 * Full-width diagram — the pre-composition builder, exactly. The diagram block
 * carries `CONTENT` verbatim, and it is appended AFTER the chrome because that
 * is the order those shapes were added in, and paint order is part of the lock.
 */
function diagramLayout(slide: Slide, ctx: LayoutCtx): PlacedBlock[] {
  const blocks = chrome(slide, ctx);
  if (slide.ir) {
    const y = slide.takeaway ? CONTENT.y + 0.1 : CONTENT.y;
    blocks.push(
      at({ x: CONTENT.x, y, w: CONTENT.w, h: CONTENT.h - (y - CONTENT.y) }, { kind: "diagram", ir: slide.ir })
    );
  }
  return blocks;
}

/**
 * One large line. The title is NOT drawn — on a statement slide the statement
 * IS the title, and printing both says the same thing twice at two sizes.
 */
function statementLayout(slide: Slide, ctx: LayoutCtx): PlacedBlock[] {
  const blocks = chrome(slide, ctx, { title: false });
  blocks.push(
    text({ x: 1.4, y: 2.1, w: 10.5, h: 2.8 }, "statement", slide.statement ?? slide.title, "center", "middle")
  );
  blocks.push(at({ x: 6.17, y: 5.15, w: 1.0, h: 0.04 }, { kind: "rule" }));
  if (slide.attribution) {
    blocks.push(text({ x: 1.4, y: 5.4, w: 10.5, h: 0.4 }, "attribution", slide.attribution, "center", "top"));
  }
  return blocks;
}

const LAYOUTS: Record<SlideLayout, (slide: Slide, ctx: LayoutCtx) => PlacedBlock[]> = {
  title: titleLayout,
  section: sectionLayout,
  bullets: bulletsLayout,
  split: splitLayout,
  diagram: diagramLayout,
  statement: statementLayout,
};

/** Dispatch. Throws on an unknown name so a typo is loud, not a blank slide. */
export function layoutFor(name: SlideLayout): (slide: Slide, ctx: LayoutCtx) => PlacedBlock[] {
  const fn = LAYOUTS[name];
  if (!fn) throw new Error(`Unknown slide layout: ${JSON.stringify(name)}`);
  return fn;
}

export { clampRatio };
