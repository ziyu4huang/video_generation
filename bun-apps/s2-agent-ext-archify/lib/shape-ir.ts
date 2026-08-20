/**
 * shape-ir.ts — the format-neutral seam between "SVG" and "any exporter".
 *
 * `SvgDoc` (svg-model.ts) in, `ShapeIR` out: one flat, PAINT-ORDERED array of
 * normalized shapes in SVG user units, with transforms already applied and
 * styles already resolved. pptx-shapes.ts consumes this and knows nothing about
 * markup, CSS classes, or transforms; a future exporter (PDF, Keynote, Figma)
 * would attach here too.
 *
 * ## Normalizations, and why
 *
 * - **`<line>` becomes a two-segment path.** SVG's `line` is a `path` with extra
 *   steps; collapsing it means consumers implement one straight-run rule instead
 *   of two. (Measured: `line` appears 9 times across the corpus, exclusively in
 *   non-architecture diagrams — exactly the kind of element an architecture-only
 *   test sweep misses.)
 * - **Arcs (`A`/`a`) become cubic BÃ©ziers.** PowerPoint's `custGeom` does have an
 *   arc primitive, but with its own centre/sweep-angle conventions that are easy
 *   to get subtly wrong. Cubic approximation (â‰¤90Â° per segment, max error ~1e-4
 *   of the radius) keeps ONE well-understood curve type flowing to every
 *   exporter. Arcs are real in this corpus: 12 absolute + 12 relative.
 * - **Transforms are applied, not carried.** Measured, archify only emits
 *   `translate` + uniform `scale`, so rects stay axis-aligned; a rotating or
 *   skewing matrix would silently produce a WRONG axis-aligned box, so those
 *   degrade to an explicit polygon instead.
 * - **`style` is ignored.** Measured across all 13 vendored examples: every
 *   `style` value is `--step:N`, an animation-ordering custom property carrying
 *   no paint. Do not add a CSS declaration parser for it.
 */
import {
  applyMatrix,
  attr,
  classList,
  numAttr,
  type Matrix,
  type SvgDoc,
  type SvgNode,
} from "./svg-model.ts";
import {
  applyInlineAttrs,
  hasNonScalingStrokeChildren,
  inheritStyle,
  resolveStyle,
  type Rgba,
  type Style,
  type Theme,
} from "./svg-theme.ts";

export type { Theme, Style, Rgba };

export interface Pt {
  x: number;
  y: number;
}

/** A normalized path segment. Absolute coordinates; arcs already cubic-ized. */
export type Seg =
  | { c: "M"; x: number; y: number }
  | { c: "L"; x: number; y: number }
  | { c: "Q"; x1: number; y1: number; x: number; y: number }
  | { c: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: "Z" };

export type Anchor = "start" | "middle" | "end";

interface Common {
  style: Style;
  /** The `id` of a referenced `marker-end`, when present. */
  markerEnd?: string;
  /** Source element id, when the artifact carried one — useful for debugging. */
  id?: string;
}

export type ShapeNode =
  | (Common & { kind: "rect"; x: number; y: number; w: number; h: number; rx?: number })
  | (Common & { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number })
  | (Common & { kind: "polygon"; points: Pt[] })
  | (Common & { kind: "path"; segments: Seg[]; closed: boolean })
  | (Common & {
      kind: "text";
      x: number;
      y: number;
      text: string;
      anchor: Anchor;
      fontSize: number;
      fontWeight: number;
    });

export interface ShapeIR {
  width: number;
  height: number;
  theme: Theme;
  /** Array order IS paint order. */
  nodes: ShapeNode[];
}

/** Thrown when a path command outside the supported grammar is encountered. */
export class UnsupportedPathCommand extends Error {
  constructor(
    readonly command: string,
    readonly d: string
  ) {
    super(
      `Unsupported SVG path command ${JSON.stringify(command)} in d=${JSON.stringify(
        d.length > 120 ? `${d.slice(0, 120)}…` : d
      )}. Add it to shape-ir.ts rather than letting geometry be dropped.`
    );
    this.name = "UnsupportedPathCommand";
  }
}

// ── path parsing ────────────────────────────────────────────────────────────

const CMD_ARGS: Record<string, number> = {
  m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0,
};

/**
 * Parse an SVG `d` attribute into absolute `Seg`s.
 *
 * Implements the full standard grammar (not merely the commands this corpus
 * happens to use), because the failure mode of a partial parser is dropped
 * geometry that nobody notices. Anything outside the grammar throws.
 */
export function parsePathD(d: string): Seg[] {
  // Tokenize ANY letter, not just the known commands: a regex that only matches
  // the valid set would silently DROP an unknown command instead of rejecting
  // it — the exact silent-geometry-loss failure this parser exists to prevent.
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const segs: Seg[] = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  // Reflection state for the smooth variants (S/s and T/t).
  let lastCubicCtrl: Pt | null = null;
  let lastQuadCtrl: Pt | null = null;
  let cmd = "";

  const num = (): number => {
    const t = tokens[i++];
    const n = t === undefined ? Number.NaN : Number.parseFloat(t);
    if (!Number.isFinite(n)) throw new UnsupportedPathCommand(cmd || "?", d);
    return n;
  };

  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (/^[A-Za-z]$/.test(tok)) {
      cmd = tok;
      i++;
    } else if (cmd === "") {
      throw new UnsupportedPathCommand(tok, d);
    } else if (cmd === "M") {
      cmd = "L"; // implicit-lineto rule
    } else if (cmd === "m") {
      cmd = "l";
    }

    const lower = cmd.toLowerCase();
    if (!(lower in CMD_ARGS)) throw new UnsupportedPathCommand(cmd, d);
    const rel = cmd !== cmd.toUpperCase();

    switch (lower) {
      case "z": {
        segs.push({ c: "Z" });
        cx = startX;
        cy = startY;
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case "m": {
        const x = num();
        const y = num();
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        startX = cx;
        startY = cy;
        segs.push({ c: "M", x: cx, y: cy });
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case "l": {
        const x = num();
        const y = num();
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        segs.push({ c: "L", x: cx, y: cy });
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case "h": {
        const x = num();
        cx = rel ? cx + x : x;
        segs.push({ c: "L", x: cx, y: cy });
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case "v": {
        const y = num();
        cy = rel ? cy + y : y;
        segs.push({ c: "L", x: cx, y: cy });
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case "c": {
        const x1 = num(); const y1 = num();
        const x2 = num(); const y2 = num();
        const x = num(); const y = num();
        const a1 = { x: rel ? cx + x1 : x1, y: rel ? cy + y1 : y1 };
        const a2 = { x: rel ? cx + x2 : x2, y: rel ? cy + y2 : y2 };
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        segs.push({ c: "C", x1: a1.x, y1: a1.y, x2: a2.x, y2: a2.y, x: cx, y: cy });
        lastCubicCtrl = a2;
        lastQuadCtrl = null;
        break;
      }
      case "s": {
        const x2 = num(); const y2 = num();
        const x = num(); const y = num();
        // Reflect the previous cubic control point about the current point.
        const a1: Pt = lastCubicCtrl
          ? { x: 2 * cx - lastCubicCtrl.x, y: 2 * cy - lastCubicCtrl.y }
          : { x: cx, y: cy };
        const a2 = { x: rel ? cx + x2 : x2, y: rel ? cy + y2 : y2 };
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        segs.push({ c: "C", x1: a1.x, y1: a1.y, x2: a2.x, y2: a2.y, x: cx, y: cy });
        lastCubicCtrl = a2;
        lastQuadCtrl = null;
        break;
      }
      case "q": {
        const x1 = num(); const y1 = num();
        const x = num(); const y = num();
        const a1 = { x: rel ? cx + x1 : x1, y: rel ? cy + y1 : y1 };
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        segs.push({ c: "Q", x1: a1.x, y1: a1.y, x: cx, y: cy });
        lastQuadCtrl = a1;
        lastCubicCtrl = null;
        break;
      }
      case "t": {
        const x = num(); const y = num();
        const a1: Pt = lastQuadCtrl
          ? { x: 2 * cx - lastQuadCtrl.x, y: 2 * cy - lastQuadCtrl.y }
          : { x: cx, y: cy };
        cx = rel ? cx + x : x;
        cy = rel ? cy + y : y;
        segs.push({ c: "Q", x1: a1.x, y1: a1.y, x: cx, y: cy });
        lastQuadCtrl = a1;
        lastCubicCtrl = null;
        break;
      }
      case "a": {
        const rx = num(); const ry = num();
        const rot = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        const x = num(); const y = num();
        const ex = rel ? cx + x : x;
        const ey = rel ? cy + y : y;
        for (const seg of arcToCubics(cx, cy, rx, ry, rot, large, sweep, ex, ey)) segs.push(seg);
        cx = ex;
        cy = ey;
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
    }
  }
  return segs;
}

/**
 * SVG endpoint-parameterized arc → cubic BÃ©zier segments (â‰¤90Â° each).
 * Standard endpoint→centre conversion per the SVG 1.1 implementation notes
 * (F.6.5), then the well-known `k = 4/3 · tan(Δ/4)` control-point formula.
 */
function arcToCubics(
  x1: number, y1: number,
  rxIn: number, ryIn: number,
  rotDeg: number,
  largeArc: boolean, sweep: boolean,
  x2: number, y2: number
): Seg[] {
  // Degenerate radii ⇒ straight line (SVG spec).
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [{ c: "L", x: x2, y: y2 }];

  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;

  // Scale radii up if they cannot span the endpoints (spec F.6.6).
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = largeArc === sweep ? -1 : 1;
  const numer = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, numer / denom));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const startAngle = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle(
    (x1p - cxp) / rx, (y1p - cyp) / ry,
    (-x1p - cxp) / rx, (-y1p - cyp) / ry
  );
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;

  const count = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / count;
  const k = (4 / 3) * Math.tan(step / 4);
  const segs: Seg[] = [];
  let theta = startAngle;
  let px = x1;
  let py = y1;
  for (let n = 0; n < count; n++) {
    const next = theta + step;
    const cosT = Math.cos(theta); const sinT = Math.sin(theta);
    const cosN = Math.cos(next); const sinN = Math.sin(next);
    // Derivatives of the ellipse at theta / next, in the rotated frame.
    const d1x = -rx * sinT; const d1y = ry * cosT;
    const d2x = -rx * sinN; const d2y = ry * cosN;
    const map = (ex: number, ey: number): Pt => ({
      x: cosP * ex - sinP * ey + cx,
      y: sinP * ex + cosP * ey + cy,
    });
    const end = map(rx * cosN, ry * sinN);
    const c1 = { x: px + k * (cosP * d1x - sinP * d1y), y: py + k * (sinP * d1x + cosP * d1y) };
    const c2 = { x: end.x - k * (cosP * d2x - sinP * d2y), y: end.y - k * (sinP * d2x + cosP * d2y) };
    segs.push({ c: "C", x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y });
    px = end.x;
    py = end.y;
    theta = next;
  }
  return segs;
}

// ── transform helpers ───────────────────────────────────────────────────────

/** Uniform scale factor of a matrix (√|det|). Used for stroke width and font size. */
function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
}

/** True when the matrix rotates or skews (rects can no longer stay rects). */
function isAxisAligned(m: Matrix): boolean {
  return Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;
}

function mapSeg(seg: Seg, m: Matrix): Seg {
  switch (seg.c) {
    case "Z":
      return seg;
    case "M":
    case "L": {
      const [x, y] = applyMatrix(m, seg.x, seg.y);
      return { c: seg.c, x, y };
    }
    case "Q": {
      const [x1, y1] = applyMatrix(m, seg.x1, seg.y1);
      const [x, y] = applyMatrix(m, seg.x, seg.y);
      return { c: "Q", x1, y1, x, y };
    }
    case "C": {
      const [x1, y1] = applyMatrix(m, seg.x1, seg.y1);
      const [x2, y2] = applyMatrix(m, seg.x2, seg.y2);
      const [x, y] = applyMatrix(m, seg.x, seg.y);
      return { c: "C", x1, y1, x2, y2, x, y };
    }
  }
}

// ── the conversion ──────────────────────────────────────────────────────────

/** Elements that never carry paint of their own. */
const STRUCTURAL = new Set(["svg", "g", "defs", "marker", "pattern", "title", "desc", "tspan"]);

function markerRef(node: SvgNode): string | undefined {
  const raw = attr(node, "marker-end");
  const m = raw ? /^url\(#([^)]+)\)$/.exec(raw.trim()) : null;
  return m ? m[1] : undefined;
}

function anchorOf(node: SvgNode): Anchor {
  const a = attr(node, "text-anchor");
  return a === "middle" || a === "end" ? a : "start";
}

/**
 * Convert an `SvgDoc` into paint-ordered `ShapeIR`.
 *
 * Presentation properties are inherited parent → child exactly as SVG does it.
 * That is not a nicety here: archify's semantic sigils are UNCLASSED little
 * shapes inside a `.semantic-sigil` group, and every scrap of their paint
 * (`fill:none`, `stroke:currentColor`, `stroke-width:1.35`, `opacity:.76`)
 * comes from that group. An earlier version inherited only `color` and rendered
 * every sigil glyph invisible — the "every node carries resolved paint" test in
 * `__tests__/shape-ir.test.ts` exists because of it.
 */
export function toShapeIR(doc: SvgDoc, theme: Theme): ShapeIR {
  const nodes: ShapeNode[] = [];
  /** Ancestor styles + non-scaling-stroke context, as a depth-keyed stack. */
  const stack: { depth: number; style: Style; nonScalingStroke: boolean }[] = [];

  for (const node of doc.nodes) {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= node.depth) stack.pop();
    const parent = stack[stack.length - 1];
    const inheritedStyle = parent?.style ?? {};
    const nonScalingStroke = parent?.nonScalingStroke ?? false;

    const classes = classList(node);
    const own = applyInlineAttrs(
      resolveStyle(classes, theme, inheritedStyle.color),
      (n) => attr(node, n),
      inheritedStyle.color
    );
    const style = inheritStyle(inheritedStyle, own);
    stack.push({
      depth: node.depth,
      style,
      // `svg .semantic-sigil > * { vector-effect: non-scaling-stroke }` — the
      // glyphs are drawn at 16px and scaled down, so their stroke must NOT
      // shrink with the transform.
      nonScalingStroke: nonScalingStroke || hasNonScalingStrokeChildren(classes),
    });

    // defs/marker/pattern content is addressable but never painted in place;
    // ticket 04 reaches arrowhead polygons through the marker id instead.
    if (node.defOnly) continue;
    if (STRUCTURAL.has(node.tag)) continue;
    // The grid plate is chrome, not diagram content.
    if (node.tag === "rect" && attr(node, "fill")?.startsWith("url(")) continue;

    const m = node.ctm;
    const s = scaleOf(m);
    const id = attr(node, "id");
    const strokeScale = nonScalingStroke ? 1 : s;
    const common: Common = {
      style:
        style.strokeWidth === undefined
          ? style
          : { ...style, strokeWidth: style.strokeWidth * strokeScale },
      ...(markerRef(node) ? { markerEnd: markerRef(node) } : {}),
      ...(id ? { id } : {}),
    };

    switch (node.tag) {
      case "rect": {
        const x = numAttr(node, "x");
        const y = numAttr(node, "y");
        const w = numAttr(node, "width");
        const h = numAttr(node, "height");
        if (w <= 0 || h <= 0) break;
        if (isAxisAligned(m)) {
          const [px, py] = applyMatrix(m, x, y);
          const [qx, qy] = applyMatrix(m, x + w, y + h);
          const rx = attr(node, "rx") !== undefined ? numAttr(node, "rx") * s : undefined;
          nodes.push({
            ...common,
            kind: "rect",
            x: Math.min(px, qx),
            y: Math.min(py, qy),
            w: Math.abs(qx - px),
            h: Math.abs(qy - py),
            ...(rx !== undefined && rx > 0 ? { rx } : {}),
          });
        } else {
          // A rotating/skewing matrix would make an axis-aligned box wrong.
          const corners: Pt[] = [
            [x, y], [x + w, y], [x + w, y + h], [x, y + h],
          ].map(([px, py]) => {
            const [ax, ay] = applyMatrix(m, px!, py!);
            return { x: ax, y: ay };
          });
          nodes.push({ ...common, kind: "polygon", points: corners });
        }
        break;
      }
      case "circle": {
        const [cx, cy] = applyMatrix(m, numAttr(node, "cx"), numAttr(node, "cy"));
        const r = numAttr(node, "r") * s;
        if (r > 0) nodes.push({ ...common, kind: "ellipse", cx, cy, rx: r, ry: r });
        break;
      }
      case "ellipse": {
        const [cx, cy] = applyMatrix(m, numAttr(node, "cx"), numAttr(node, "cy"));
        const rx = numAttr(node, "rx") * s;
        const ry = numAttr(node, "ry") * s;
        if (rx > 0 && ry > 0) nodes.push({ ...common, kind: "ellipse", cx, cy, rx, ry });
        break;
      }
      case "polygon":
      case "polyline": {
        const raw = attr(node, "points") ?? "";
        const coords = raw.split(/[\s,]+/).map(Number.parseFloat).filter(Number.isFinite);
        const points: Pt[] = [];
        for (let k = 0; k + 1 < coords.length; k += 2) {
          const [px, py] = applyMatrix(m, coords[k]!, coords[k + 1]!);
          points.push({ x: px, y: py });
        }
        if (points.length >= 2) nodes.push({ ...common, kind: "polygon", points });
        break;
      }
      case "line": {
        // Normalized to a path — see the module header.
        const [ax, ay] = applyMatrix(m, numAttr(node, "x1"), numAttr(node, "y1"));
        const [bx, by] = applyMatrix(m, numAttr(node, "x2"), numAttr(node, "y2"));
        nodes.push({
          ...common,
          kind: "path",
          segments: [{ c: "M", x: ax, y: ay }, { c: "L", x: bx, y: by }],
          closed: false,
        });
        break;
      }
      case "path": {
        const d = attr(node, "d");
        if (!d) break;
        const segments = parsePathD(d).map((seg) => mapSeg(seg, m));
        if (segments.length === 0) break;
        nodes.push({
          ...common,
          kind: "path",
          segments,
          closed: segments.some((seg) => seg.c === "Z"),
        });
        break;
      }
      case "text": {
        const text = node.text.trim();
        if (text === "") break;
        const [x, y] = applyMatrix(m, numAttr(node, "x"), numAttr(node, "y"));
        nodes.push({
          ...common,
          kind: "text",
          x,
          y,
          text,
          anchor: anchorOf(node),
          fontSize: numAttr(node, "font-size", 12) * s,
          fontWeight: numAttr(node, "font-weight", 400),
        });
        break;
      }
      default:
        // Unknown but harmless (e.g. a decorative <use>): skip rather than
        // throw. Geometry-bearing gaps are caught by the census test instead.
        break;
    }
  }

  return { width: doc.width, height: doc.height, theme, nodes };
}

/** Axis-aligned bounding box of a shape, for layout and sanity checks. */
export function boundsOf(node: ShapeNode): { x: number; y: number; w: number; h: number } {
  const xs: number[] = [];
  const ys: number[] = [];
  const push = (x: number, y: number) => {
    xs.push(x);
    ys.push(y);
  };
  switch (node.kind) {
    case "rect":
      push(node.x, node.y);
      push(node.x + node.w, node.y + node.h);
      break;
    case "ellipse":
      push(node.cx - node.rx, node.cy - node.ry);
      push(node.cx + node.rx, node.cy + node.ry);
      break;
    case "polygon":
      for (const p of node.points) push(p.x, p.y);
      break;
    case "path":
      for (const seg of node.segments) {
        if (seg.c === "Z") continue;
        if (seg.c === "Q") push(seg.x1, seg.y1);
        if (seg.c === "C") {
          push(seg.x1, seg.y1);
          push(seg.x2, seg.y2);
        }
        push(seg.x, seg.y);
      }
      break;
    case "text":
      push(node.x, node.y);
      break;
  }
  if (xs.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

// ── human-readable serialization ────────────────────────────────────────────

function fmtNum(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
}

function fmtPaint(label: string, c: Rgba | null | undefined): string | null {
  if (c === undefined) return null;
  if (c === null) return `${label}=none`;
  const hex = `${[c.r, c.g, c.b]
    .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
  return c.a >= 1 ? `${label}=${hex}` : `${label}=${hex}@${fmtNum(c.a)}`;
}

function fmtStyle(s: Style): string {
  const parts = [
    fmtPaint("fill", s.fill),
    fmtPaint("stroke", s.stroke),
    s.strokeWidth !== undefined ? `sw=${fmtNum(s.strokeWidth)}` : null,
    s.dash ? `dash=${s.dash.map(fmtNum).join(",")}` : null,
    s.opacity !== undefined ? `opacity=${fmtNum(s.opacity)}` : null,
    fmtPaint("color", s.color),
  ].filter((p): p is string => p !== null);
  return parts.join(" ");
}

function fmtSeg(seg: Seg): string {
  switch (seg.c) {
    case "Z": return "Z";
    case "M": return `M${fmtNum(seg.x)},${fmtNum(seg.y)}`;
    case "L": return `L${fmtNum(seg.x)},${fmtNum(seg.y)}`;
    case "Q": return `Q${fmtNum(seg.x1)},${fmtNum(seg.y1)} ${fmtNum(seg.x)},${fmtNum(seg.y)}`;
    case "C":
      return `C${fmtNum(seg.x1)},${fmtNum(seg.y1)} ${fmtNum(seg.x2)},${fmtNum(seg.y2)} ${fmtNum(seg.x)},${fmtNum(seg.y)}`;
  }
}

/**
 * One line per shape, in paint order — the golden-fixture and `--emit-shape-ir`
 * format. Deliberately NOT JSON: a diff of this form shows what actually changed
 * about a diagram ("this box moved 4px", "this label lost its color") instead of
 * hundreds of lines of re-indented punctuation.
 */
export function formatShapeIR(ir: ShapeIR): string {
  const lines = [`# ${ir.width}x${ir.height} theme=${ir.theme} nodes=${ir.nodes.length}`];
  for (const n of ir.nodes) {
    const tail = [fmtStyle(n.style), n.markerEnd ? `marker=${n.markerEnd}` : ""]
      .filter((s) => s !== "")
      .join(" ");
    switch (n.kind) {
      case "rect":
        lines.push(
          `rect ${fmtNum(n.x)},${fmtNum(n.y)} ${fmtNum(n.w)}x${fmtNum(n.h)}` +
            `${n.rx !== undefined ? ` r${fmtNum(n.rx)}` : ""} ${tail}`.trimEnd()
        );
        break;
      case "ellipse":
        lines.push(
          `ellipse ${fmtNum(n.cx)},${fmtNum(n.cy)} ${fmtNum(n.rx)}x${fmtNum(n.ry)} ${tail}`.trimEnd()
        );
        break;
      case "polygon":
        lines.push(
          `polygon ${n.points.map((p) => `${fmtNum(p.x)},${fmtNum(p.y)}`).join(" ")} ${tail}`.trimEnd()
        );
        break;
      case "path":
        lines.push(
          `path${n.closed ? "*" : ""} ${n.segments.map(fmtSeg).join(" ")} ${tail}`.trimEnd()
        );
        break;
      case "text":
        lines.push(
          `text ${fmtNum(n.x)},${fmtNum(n.y)} ${n.anchor} ${fmtNum(n.fontSize)}/${n.fontWeight} ` +
            `${tail} ${JSON.stringify(n.text)}`.replace(/\s+/g, " ").trimEnd()
        );
        break;
    }
  }
  return `${lines.join("\n")}\n`;
}
