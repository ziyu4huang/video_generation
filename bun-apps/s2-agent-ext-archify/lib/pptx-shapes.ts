/**
 * pptx-shapes.ts — ShapeIR → NATIVE PowerPoint shapes.
 *
 * The whole point of this module: a slide that opens in PowerPoint as editable
 * shapes and text runs. No screenshot, no `addImage`, no `<a:blip>` anywhere in
 * the slide XML — `__tests__/pptx-shapes.test.ts` asserts that count is zero,
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
 * - `rectRadius` is a **fraction 0–1** (emitted as `adj val = r*100000`), not a
 *   length. A rounded rect's SVG `rx` must be divided by the smaller side.
 * - `line.width` is in POINTS (1 inch = 72 pt), while x/y/w/h are inches.
 */
import { boundsOf, type Rgba, type Seg, type ShapeIR, type ShapeNode, type Style } from "./shape-ir.ts";
import { flatten, themeBackground, toHex } from "./svg-theme.ts";

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
}

export interface PlacementResult {
  shapes: number;
  texts: number;
  /** The uniform SVG-unit → inch scale actually used. */
  scale: number;
}

const EPS = 1e-6;

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

function fillOf(style: Style, ir: ShapeIR): Record<string, unknown> {
  if (!style.fill) return { fill: { type: "none" } };
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
 * Place a ShapeIR onto a slide as native shapes.
 *
 * One uniform scale with centering, so aspect ratio is never distorted — a
 * stretched architecture diagram reads as a rendering bug to anyone who has
 * seen the browser version.
 */
export function addShapeIrToSlide(
  slide: SlideLike,
  ir: ShapeIR,
  box: Box,
  options: PptxShapeOptions = {}
): PlacementResult {
  const fontFace = options.fontFace ?? "Arial";
  const minStrokePt = options.minStrokePt ?? 0.5;

  const scale =
    ir.width > 0 && ir.height > 0
      ? Math.min(box.w / ir.width, box.h / ir.height)
      : 0;
  const offX = box.x + (box.w - ir.width * scale) / 2;
  const offY = box.y + (box.h - ir.height * scale) / 2;
  const px = (x: number) => offX + x * scale;
  const py = (y: number) => offY + y * scale;
  const len = (v: number) => v * scale;

  let shapes = 0;
  let texts = 0;
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
        // rectRadius is a FRACTION of the smaller side, not a length.
        const radius =
          node.rx !== undefined && node.rx > 0
            ? Math.min(0.5, node.rx / Math.max(EPS, Math.min(node.w, node.h)))
            : 0;
        slide.addShape(radius > 0 ? "roundRect" : "rect", {
          x: px(node.x),
          y: py(node.y),
          w: len(node.w),
          h: len(node.h),
          ...(radius > 0 ? { rectRadius: Math.round(radius * 1000) / 1000 } : {}),
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
        // (~0.35em above the baseline) and let valign do the rest — no glyph
        // metrics are available here, so the box is deliberately roomy and
        // wrapping is off so a mis-estimated width can never reflow to 2 lines.
        const sizePt = node.fontSize * scale * 72;
        const boxH = len(node.fontSize * 1.8);
        const centerY = py(node.y - node.fontSize * 0.35);
        const estWidth = len(node.fontSize * 0.62 * Math.max(1, node.text.length) * 1.35);
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

  return { shapes, texts, scale };
}
