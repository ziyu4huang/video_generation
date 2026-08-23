/**
 * pptx-shapes.ts — ShapeIR → NATIVE PowerPoint shapes.
 *
 * The whole point of this module: a slide that opens in PowerPoint as editable
 * shapes and text runs. No screenshot, no `addImage`, no `<a:blip>` anywhere in
 * the slide XML — `tests/pptx-shapes.test.ts` asserts that count is zero,
 * which is the one property a regression to rasterization cannot fake.
 *
 * ## pptxgenjs geometry, measured (v4.0.1, probed 2026-08-21)
 *
 * - `custGeom` `points` are **relative to the shape's own x/y**, in inches.
 *   pptxgenjs emits `<a:path w=… h=…>` equal to the shape's `w`/`h`, so points
 *   outside that box are out of the path's coordinate space. Every path shape
 *   therefore gets its OWN bounding box, with points rebased onto it.
 * - `points` supports `moveTo` (multiple subpaths), `{close:true}`, and
 *   `curve: {type:'quadratic'|'cubic'|'arc'}` — a direct match for ShapeIR's
 *   `Seg` union, which is why arcs were pre-converted to cubics upstream.
 * - `rectRadius` is a **length in inches**, despite typings that read as a
 *   fraction — see the `rect` case, where getting this backwards was P1.
 * - `line.width` is in POINTS (1 inch = 72 pt), while x/y/w/h are inches.
 */
import { boundsOf, type Rgba, type Seg, type ShapeIR, type ShapeNode, type Style } from "./shape-ir.ts";
import { flatten, themeBackground, toHex } from "./svg-theme.ts";
import { textEms } from "./text-extent.ts";

/**
 * The slide surface this module needs. Structural rather than pptxgenjs's own
 * type so the mapper is trivially testable with a spy — and so `addImage` can
 * be present-but-forbidden.
 */
export interface SlideLike {
  addShape(type: string, opts: Record<string, unknown>): unknown;
  /**
   * A run array is how ONE PowerPoint text box holds a multi-paragraph list
   * (see `emit-pptx.ts`). This module only ever passes a plain string.
   */
  addText(text: string | TextRun[], opts: Record<string, unknown>): unknown;
  /**
   * The `table` drawing primitive's sink (D5). On the real pptxgenjs slide this
   * emits `<a:tbl>` inside a `<p:graphicFrame>`; the spy records it so the
   * zero-blip property can assert its absence there too.
   */
  addTable(rows: unknown, opts: Record<string, unknown>): unknown;
}

/** One paragraph inside a multi-run text box. */
export interface TextRun {
  text: string;
  options?: Record<string, unknown>;
}

/** Target rectangle on the slide, in inches. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PptxShapeOptions {
  /** Font for text runs. */
  fontFace?: string;
  /** Floor for hairlines so thin strokes survive projection (points). */
  minStrokePt?: number;
  /**
   * Scale to the union of what the diagram paints instead of its canvas (P4:
   * the vendored renderers emit canvases with dead margins, so centring the
   * canvas parks the visible content small and off-centre). Default `false` —
   * canvas fit — which the D3-locked `diagram` layout must keep.
   */
  fitContent?: boolean;
}

export interface PlacementResult {
  shapes: number;
  texts: number;
  /** The uniform SVG-unit → inch scale actually used. */
  scale: number;
  /**
   * Smallest text pt emitted, when any text node was placed.
   *
   * `pt = fontSize * scale * 72`. A diagram whose viewBox is large relative to
   * the slide's diagram box silently collapses its labels (e.g. 8px × 0.006in ×
   * 72 ≈ 3.5pt) — the deck exposes this so an agent is told the diagram text
   * will be unreadable BEFORE the deck ships, not after a screenshot. Absent
   * when the slide (or box) holds no text.
   */
  minPt?: number;
}

const EPS = 1e-6;

/**
 * Headroom on a diagram label's reserved width, as a multiple of its estimated
 * set width.
 *
 * The estimate this replaces was `fontSize * 0.62 * text.length * 1.35`
 * ≈ 0.837 em per character — one Latin advance applied to every script.
 * Measured across the five slides of `examples/deck/` (2026-08-22, 137 labels):
 * it over-reserves Latin and mixed labels by 1.07…1.68x and under-reserves
 * EVERY pure-CJK label by exactly that 0.837, because a Han ideograph sets at a
 * full em. 40 labels were under-reserved. `系統需求` was given 3.35 em for a
 * 4.00 em string — 3.35 characters fit, which is precisely why it broke as
 * `系統需 / 求` (P3 of archify-deck-visual-fidelity).
 *
 * `textEms()` answers the width question script-aware, calibrated against
 * rendered ink. What it does not do is leave room for its own error: it is a
 * four-bucket model and its worst measured miss is `M`, which sets at 0.90 em
 * against a modelled 0.78 (−13 %). This factor covers that, turning a best
 * guess into an upper bound — which is what `wrap: false` requires, since a
 * renderer that ignores it breaks the line at the box edge instead.
 */
export const LABEL_WIDTH_SAFETY = 1.15;

/**
 * Reserved width for a diagram label, in ems of its own font size.
 *
 * Exported so the width contract can be asserted without a renderer and
 * without restating the formula (`tests/pptx-mapper.test.ts`).
 */
export function labelWidthEms(text: string): number {
  return Math.max(1, textEms(text)) * LABEL_WIDTH_SAFETY;
}

/** SVG dasharray → the nearest PowerPoint preset dash. */
function dashType(dash: number[] | undefined): string | undefined {
  if (!dash || dash.length === 0) return undefined;
  const on = dash[0]!;
  if (on <= 2) return "sysDot";
  if (on <= 4) return "dash";
  if (on <= 6) return "sysDash";
  return "lgDash";
}

/** Composite a color onto the page background — PowerPoint fills are opaque-first. */
function paint(c: Rgba, ir: ShapeIR): string {
  return toHex(c.a >= 1 ? c : flatten(c, themeBackground(ir.theme)));
}

/**
 * A no-fill shape is spelled by OMITTING `fill`, not by `fill: { type: "none" }`.
 *
 * This is counter-intuitive and was the cause of P1 (stroke-only icons rendering
 * as star bursts). Measured against pptxgenjs@4.0.1, 2026-08-22 — the emitted
 * `<p:spPr>` for each spelling:
 *
 *   fill: { type: "none" }            → NO fill element at all
 *   fill: "none"                      → NO fill element (and a console warning)
 *   fill: { color, transparency:100 } → NO fill element
 *   fill omitted                      → `<a:noFill/>`          ← the one we need
 *   fill: { type: "solid", color }    → `<a:solidFill>`
 *
 * DrawingML treats an ABSENT fill as "inherit from the shape style", not as
 * "no fill", so the first three spellings all let the theme paint the icon.
 */
function fillOf(style: Style, ir: ShapeIR): Record<string, unknown> {
  if (!style.fill) return {};
  const opacity = style.opacity ?? 1;
  const effective: Rgba = { ...style.fill, a: style.fill.a * opacity };
  return { fill: { color: paint(effective, ir) } };
}

function lineOf(
  style: Style,
  ir: ShapeIR,
  scale: number,
  minStrokePt: number
): Record<string, unknown> | undefined {
  if (!style.stroke) return undefined;
  const opacity = style.opacity ?? 1;
  const effective: Rgba = { ...style.stroke, a: style.stroke.a * opacity };
  const widthPt = Math.max(minStrokePt, (style.strokeWidth ?? 1) * scale * 72);
  const dash = dashType(style.dash);
  return {
    line: {
      color: paint(effective, ir),
      width: Math.round(widthPt * 100) / 100,
      ...(dash ? { dashType: dash } : {}),
    },
  };
}

/** The two endpoints of a straight two-point path, or null. */
function straightRun(node: ShapeNode): [number, number, number, number] | null {
  if (node.kind !== "path") return null;
  if (node.segments.length !== 2) return null;
  const [a, b] = node.segments;
  if (a?.c !== "M" || b?.c !== "L") return null;
  return [a.x, a.y, b.x, b.y];
}

/** Direction of a path's final segment, for orienting an arrowhead. */
function terminalDirection(segments: Seg[]): { x: number; y: number; angle: number } | null {
  let prev: { x: number; y: number } | null = null;
  let last: { x: number; y: number } | null = null;
  for (const s of segments) {
    if (s.c === "Z") continue;
    const p = s.c === "C" ? { x: s.x2, y: s.y2 } : s.c === "Q" ? { x: s.x1, y: s.y1 } : last;
    if (last) prev = p ?? last;
    last = { x: s.x, y: s.y };
  }
  if (!last || !prev) return null;
  const dx = last.x - prev.x;
  const dy = last.y - prev.y;
  const len = Math.hypot(dx, dy);
  if (len < EPS) return null;
  return { x: last.x, y: last.y, angle: Math.atan2(dy, dx) };
}

/**
 * Union of every node's `boundsOf` — the ink the diagram actually paints, as
 * opposed to the canvas it was emitted on.
 *
 * A text node contributes only its anchor point: `boundsOf` has no model for a
 * glyph's extent, and an anchor always sits on the label it belongs to, so the
 * union is a tight-enough stand-in for content that is bounded by shapes on
 * every side (which node labels are — they sit inside or beside their node).
 */
export function contentBoundsOf(ir: ShapeIR): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of ir.nodes) {
    const b = boundsOf(n);
    // A degenerate bbox is fine from a TEXT node — `boundsOf` gives a text
    // only its anchor point, and that point is exactly what must participate.
    // From any other kind it means the node paints nothing (e.g. a path of
    // nothing but `Z`), and (0,0) would wrongly stretch the bounds to origin.
    if (n.kind !== "text" && b.w === 0 && b.h === 0) continue;
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Place a ShapeIR onto a slide as native shapes.
 *
 * One uniform scale with centering, so aspect ratio is never distorted — a
 * stretched architecture diagram reads as a rendering bug to anyone who has
 * seen the browser version.
 *
 * What is centred depends on `options.fitContent`: the canvas (default, and
 * what the D3-locked `diagram` layout must keep) or the content bounds — see
 * `contentBoundsOf`.
 */
export function addShapeIrToSlide(
  slide: SlideLike,
  ir: ShapeIR,
  box: Box,
  options: PptxShapeOptions = {}
): PlacementResult {
  const fontFace = options.fontFace ?? "Arial";
  const minStrokePt = options.minStrokePt ?? 0.5;

  const cb = options.fitContent ? contentBoundsOf(ir) : null;
  // Fall back to canvas fit when there is nothing to measure, so an empty
  // diagram degrades to today's behaviour instead of a zero scale.
  const fitW = cb && cb.w > 0 ? cb.w : ir.width;
  const fitH = cb && cb.h > 0 ? cb.h : ir.height;
  const fitX = cb && cb.w > 0 ? cb.x : 0;
  const fitY = cb && cb.h > 0 ? cb.y : 0;

  const scale = fitW > 0 && fitH > 0 ? Math.min(box.w / fitW, box.h / fitH) : 0;
  const offX = box.x + (box.w - fitW * scale) / 2 - fitX * scale;
  const offY = box.y + (box.h - fitH * scale) / 2 - fitY * scale;
  const px = (x: number) => offX + x * scale;
  const py = (y: number) => offY + y * scale;
  const len = (v: number) => v * scale;

  let shapes = 0;
  let texts = 0;
  let minPt: number | undefined;
  if (scale <= 0) return { shapes, texts, scale: 0 };

  /** Emit an arrowhead triangle matching SVG's markerUnits="strokeWidth". */
  const arrowhead = (node: ShapeNode, style: Style): void => {
    if (node.kind !== "path" || !node.markerEnd || !style.stroke) return;
    const dir = terminalDirection(node.segments);
    if (!dir) return;
    // archify's four markers are the same 10x7 triangle differing only in fill,
    // and that fill always matches the connector's own stroke — so synthesize it
    // rather than plumbing marker defs through the IR.
    const sw = style.strokeWidth ?? 1;
    const long = 10 * sw;
    const half = 3.5 * sw;
    const cos = Math.cos(dir.angle);
    const sin = Math.sin(dir.angle);
    const tip = { x: dir.x, y: dir.y };
    const back = { x: dir.x - long * cos, y: dir.y - long * sin };
    const pts = [
      { x: back.x - half * -sin, y: back.y - half * cos },
      tip,
      { x: back.x + half * -sin, y: back.y + half * cos },
    ];
    const minX = Math.min(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y));
    const w = Math.max(...pts.map((p) => p.x)) - minX;
    const h = Math.max(...pts.map((p) => p.y)) - minY;
    slide.addShape("custGeom", {
      x: px(minX),
      y: py(minY),
      w: Math.max(len(w), EPS),
      h: Math.max(len(h), EPS),
      points: [
        { x: len(pts[0]!.x - minX), y: len(pts[0]!.y - minY), moveTo: true },
        { x: len(pts[1]!.x - minX), y: len(pts[1]!.y - minY) },
        { x: len(pts[2]!.x - minX), y: len(pts[2]!.y - minY) },
        { close: true },
      ],
      fill: { color: paint(style.stroke, ir) },
      line: { type: "none" },
    });
    shapes++;
  };

  for (const node of ir.nodes) {
    const style = node.style;

    switch (node.kind) {
      case "rect": {
        /**
         * `rectRadius` is a LENGTH IN INCHES, not a fraction.
         *
         * pptxgenjs@4.0.1's typings say "values: 0.0 to 1.0", which reads as a
         * fraction and is what this code used to pass. Its actual formula is
         * unambiguous:
         *
         *   adj = round(rectRadius * 914400 * 100000 / min(cx, cy))
         *
         * — `rectRadius * EMU` is a length. Passing the fraction 0.222 for a
         * 0.08 in legend swatch therefore asked for a 0.222 INCH corner radius
         * and emitted `adj val="269169"`, where ECMA-376 caps `roundRect`'s adj
         * at 50000 (50 %). An out-of-range adjustment makes the preset's corner
         * arcs self-intersect, which is what rendered every small rounded rect
         * as a star burst (P1 of archify-deck-visual-fidelity — 43 out-of-range
         * values across the two example decks, worst 317450 = 6.3x the ceiling).
         *
         * Passing `fraction * min(w, h)` in inches makes the library's formula
         * collapse back to `adj = fraction * 100000`, which is what was meant.
         */
        const radiusFraction =
          node.rx !== undefined && node.rx > 0
            ? Math.min(0.5, node.rx / Math.max(EPS, Math.min(node.w, node.h)))
            : 0;
        const radiusInches = radiusFraction * Math.min(len(node.w), len(node.h));
        slide.addShape(radiusFraction > 0 ? "roundRect" : "rect", {
          x: px(node.x),
          y: py(node.y),
          w: len(node.w),
          h: len(node.h),
          ...(radiusFraction > 0 ? { rectRadius: radiusInches } : {}),
          ...fillOf(style, ir),
          ...lineOf(style, ir, scale, minStrokePt),
        });
        shapes++;
        break;
      }

      case "ellipse": {
        slide.addShape("ellipse", {
          x: px(node.cx - node.rx),
          y: py(node.cy - node.ry),
          w: len(node.rx * 2),
          h: len(node.ry * 2),
          ...fillOf(style, ir),
          ...lineOf(style, ir, scale, minStrokePt),
        });
        shapes++;
        break;
      }

      case "polygon": {
        const minX = Math.min(...node.points.map((p) => p.x));
        const minY = Math.min(...node.points.map((p) => p.y));
        const w = Math.max(...node.points.map((p) => p.x)) - minX;
        const h = Math.max(...node.points.map((p) => p.y)) - minY;
        slide.addShape("custGeom", {
          x: px(minX),
          y: py(minY),
          w: Math.max(len(w), EPS),
          h: Math.max(len(h), EPS),
          points: [
            ...node.points.map((p, i) => ({
              x: len(p.x - minX),
              y: len(p.y - minY),
              ...(i === 0 ? { moveTo: true } : {}),
            })),
            { close: true as const },
          ],
          ...fillOf(style, ir),
          ...lineOf(style, ir, scale, minStrokePt),
        });
        shapes++;
        break;
      }

      case "path": {
        const run = straightRun(node);
        if (run) {
          // A straight two-point run becomes a native `line`, which stays ONE
          // editable connector in PowerPoint and can carry a real arrowhead.
          const [x1, y1, x2, y2] = run;
          const line = lineOf(style, ir, scale, minStrokePt)?.line as
            | Record<string, unknown>
            | undefined;
          slide.addShape("line", {
            x: px(Math.min(x1, x2)),
            y: py(Math.min(y1, y2)),
            w: len(Math.abs(x2 - x1)),
            h: len(Math.abs(y2 - y1)),
            // A line's box is its bounding box, so a right-to-left or
            // bottom-to-top run needs a flip to keep its actual direction —
            // which is what decides where the arrowhead lands.
            ...(x2 < x1 ? { flipH: true } : {}),
            ...(y2 < y1 ? { flipV: true } : {}),
            ...(line
              ? { line: { ...line, ...(node.markerEnd ? { endArrowType: "triangle" } : {}) } }
              : {}),
          });
          shapes++;
          break;
        }

        const b = boundsOf(node);
        const points: Record<string, unknown>[] = [];
        for (const seg of node.segments) {
          if (seg.c === "Z") {
            points.push({ close: true });
            continue;
          }
          const base = { x: len(seg.x - b.x), y: len(seg.y - b.y) };
          if (seg.c === "M") points.push({ ...base, moveTo: true });
          else if (seg.c === "L") points.push(base);
          else if (seg.c === "Q") {
            points.push({
              ...base,
              curve: { type: "quadratic", x1: len(seg.x1 - b.x), y1: len(seg.y1 - b.y) },
            });
          } else {
            points.push({
              ...base,
              curve: {
                type: "cubic",
                x1: len(seg.x1 - b.x),
                y1: len(seg.y1 - b.y),
                x2: len(seg.x2 - b.x),
                y2: len(seg.y2 - b.y),
              },
            });
          }
        }
        slide.addShape("custGeom", {
          x: px(b.x),
          y: py(b.y),
          w: Math.max(len(b.w), EPS),
          h: Math.max(len(b.h), EPS),
          points,
          ...fillOf(style, ir),
          ...lineOf(style, ir, scale, minStrokePt),
        });
        shapes++;
        arrowhead(node, style);
        break;
      }

      case "text": {
        // SVG `y` is the BASELINE; a PowerPoint text box is positioned by its
        // top edge. Centre a generous box on the visual middle of the glyphs
        // (~0.35em above the baseline) and let valign do the rest — vertical
        // extent still has no model, so the box stays deliberately tall.
        //
        // `wrap: false` is kept: this path replays a diagram whose SVG already
        // decided where every line breaks, so wrapping would reflow text the
        // diagram positioned deliberately. But `wrap="none"` is not honoured by
        // every OOXML renderer, so the width must be an upper bound anyway —
        // see `labelWidthEms` above.
        const sizePt = node.fontSize * scale * 72;
        if (minPt === undefined || sizePt < minPt) minPt = sizePt;
        const boxH = len(node.fontSize * 1.8);
        const centerY = py(node.y - node.fontSize * 0.35);
        const estWidth = len(node.fontSize * labelWidthEms(node.text));
        const align = node.anchor === "middle" ? "center" : node.anchor === "end" ? "right" : "left";
        const x =
          node.anchor === "middle"
            ? px(node.x) - estWidth / 2
            : node.anchor === "end"
              ? px(node.x) - estWidth
              : px(node.x);
        slide.addText(node.text, {
          x,
          y: centerY - boxH / 2,
          w: estWidth,
          h: boxH,
          fontFace,
          fontSize: Math.round(sizePt * 10) / 10,
          bold: node.fontWeight >= 600,
          color: style.fill ? paint(style.fill, ir) : "000000",
          align,
          valign: "middle",
          margin: 0,
          wrap: false,
          ...(style.opacity !== undefined && style.opacity < 1
            ? { transparency: Math.round((1 - style.opacity) * 100) }
            : {}),
        });
        texts++;
        break;
      }
    }
  }

  return { shapes, texts, scale, ...(minPt !== undefined ? { minPt } : {}) };
}
