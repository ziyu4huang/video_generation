/**
 * svg-model.ts — the ONLY place in this package that knows SVG-as-markup.
 *
 * Turns a rendered archify `.html` artifact into an ordered, transform-resolved
 * node list (`SvgDoc`). Everything downstream (shape-ir.ts, pptx-shapes.ts)
 * consumes that list and never touches markup.
 *
 * ## Why HTMLRewriter and not Bun.XML (effort archify-view-pptx-bun, D2)
 *
 * `Bun.XML.parse` is disqualified for this job, measured 2026-08-21 on bun 1.4.0:
 *
 *   1. It collapses REPEATED sibling tags into one array, so their interleaving
 *      with other tags is lost:
 *        parse('<svg><rect id=r1/><path id=p1/><rect id=r2/></svg>')
 *          -> {"svg":{"rect":[{"@id":"r1"},{"@id":"r2"}],"path":{"@id":"p1"}}}
 *      In SVG, document order IS paint order. Losing it means background plates
 *      cover nodes and labels get occluded. Four `preserveOrder`-style option
 *      spellings were probed; all are silently accepted no-ops.
 *
 *      Note the precise shape of the flaw, corrected 2026-08-21 (effort
 *      archify-slide-composition): order across DISTINCT sibling tags DOES
 *      survive, as object key insertion order. It is repetition that destroys
 *      it. That distinction is why `lib/ooxml-lint.ts` can use `Bun.XML` for its
 *      `spPr` child-sequence rule (all-distinct children) while still needing
 *      `HTMLRewriter` for its path-segment rule — and why the disqualification
 *      here stands unchanged: an SVG's siblings repeat constantly.
 *   2. archify emits HTML-style boolean attributes inside its SVG
 *      (`data-detail-anchor` on <text>, `data-legend-bridge` on <g>), which are
 *      not legal XML — it fails to parse the input at all. (OOXML has no such
 *      problem, which is the other half of why the two modules differ.)
 *
 * HTMLRewriter is a STREAMING parser, so document order is a structural
 * guarantee rather than a promise. Measured on the committed 629 KB artifact
 * `ir/s2-agent-ext-webui-v31.architecture.html`: 359 element nodes in 2.31 ms,
 * matching an independent census exactly.
 *
 * ## The one quirk
 *
 * HTMLRewriter lowercases ATTRIBUTE NAMES (`viewBox` -> `viewbox`,
 * `markerWidth` -> `markerwidth`); values are untouched. We read a small fixed
 * attribute set, so lowercase lookups absorb it completely — but every read must
 * go through `attr()` below so the normalization has exactly one home.
 */

/** 2x3 affine matrix [a, b, c, d, e, f] — the SVG transform convention. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** Compose two matrices (`m` applied after `parent`, i.e. parent × m). */
export function multiply(parent: Matrix, m: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = parent;
  const [a2, b2, c2, d2, e2, f2] = m;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

/** Apply a matrix to a point. */
export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/**
 * Parse an SVG `transform` attribute into a single matrix. Supports the four
 * forms archify's renderers emit (translate/scale/rotate/matrix); an unknown
 * function is IGNORED rather than throwing — a decorative transform we do not
 * model must not sink a whole export. Unsupported geometry-bearing commands are
 * caught later, in shape-ir.ts, where dropping them would be silent data loss.
 */
export function parseTransform(value: string | undefined): Matrix {
  if (!value) return IDENTITY;
  let out: Matrix = IDENTITY;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const fn = m[1]!.toLowerCase();
    const args = m[2]!
      .split(/[\s,]+/)
      .map((s) => Number.parseFloat(s))
      .filter((n) => Number.isFinite(n));
    if (fn === "translate") {
      out = multiply(out, [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0]);
    } else if (fn === "scale") {
      const sx = args[0] ?? 1;
      out = multiply(out, [sx, 0, 0, args[1] ?? sx, 0, 0]);
    } else if (fn === "rotate") {
      const rad = ((args[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
      const cx = args[1];
      const cy = args[2];
      if (cx !== undefined && cy !== undefined) {
        // rotate(a, cx, cy) === translate(cx,cy) rotate(a) translate(-cx,-cy)
        out = multiply(out, [1, 0, 0, 1, cx, cy]);
        out = multiply(out, rot);
        out = multiply(out, [1, 0, 0, 1, -cx, -cy]);
      } else {
        out = multiply(out, rot);
      }
    } else if (fn === "matrix" && args.length === 6) {
      out = multiply(out, args.slice(0, 6) as unknown as Matrix);
    }
  }
  return out;
}

/** One element from the SVG subtree, in document (= paint) order. */
export interface SvgNode {
  /** Lowercase tag name, e.g. "rect". */
  tag: string;
  /** Attributes with LOWERCASED names (HTMLRewriter). Read via `attr()`. */
  attrs: Record<string, string>;
  /** Nesting depth; the <svg> root is 0. */
  depth: number;
  /** Concatenated text content of this element's own text children. */
  text: string;
  /** Absolute transform, composed down the ancestor <g transform> chain. */
  ctm: Matrix;
  /** True when this node is inside <defs> — addressable, never painted. */
  defOnly: boolean;
}

export interface SvgDoc {
  /** User-unit width from viewBox (falls back to the width attribute). */
  width: number;
  /** User-unit height from viewBox (falls back to the height attribute). */
  height: number;
  /** Every element in the <svg> subtree, in document order. */
  nodes: SvgNode[];
}

/**
 * Read an attribute case-insensitively. ALL attribute reads in this package go
 * through here — HTMLRewriter's lowercasing then has exactly one home, and a
 * future reader chasing `viewBox` finds the explanation instead of a mystery.
 */
export function attr(node: SvgNode, name: string): string | undefined {
  return node.attrs[name.toLowerCase()];
}

/** Read an attribute as a finite number, or `fallback` when absent/unparseable. */
export function numAttr(node: SvgNode, name: string, fallback = 0): number {
  const raw = attr(node, name);
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Split a `class` attribute into tokens (empty when absent). */
export function classList(node: SvgNode): string[] {
  const raw = attr(node, "class");
  return raw ? raw.split(/\s+/).filter((s) => s !== "") : [];
}

interface Frame {
  ctm: Matrix;
  inDefs: boolean;
  node: SvgNode;
}

/**
 * Parse a rendered archify artifact (or a bare SVG string) into an `SvgDoc`.
 *
 * The WHOLE html is streamed through one HTMLRewriter pass — deliberately NOT
 * pre-sliced with `indexOf("<svg")`, which would break on any artifact that
 * mentions the string before the real element.
 */
export async function parseSvg(html: string): Promise<SvgDoc> {
  const nodes: SvgNode[] = [];
  const stack: Frame[] = [];

  await new HTMLRewriter()
    .on("svg, svg *", {
      element(el) {
        const attrs: Record<string, string> = {};
        for (const [k, v] of el.attributes) attrs[k.toLowerCase()] = v;
        const parent = stack[stack.length - 1];
        const parentCtm = parent ? parent.ctm : IDENTITY;
        const own = parseTransform(attrs["transform"]);
        const tag = el.tagName.toLowerCase();
        const node: SvgNode = {
          tag,
          attrs,
          depth: stack.length,
          text: "",
          ctm: multiply(parentCtm, own),
          defOnly: (parent?.inDefs ?? false) || tag === "defs",
        };
        nodes.push(node);
        // Void/self-closing elements never open a frame, so nothing to pop.
        if (!el.selfClosing) {
          const frame: Frame = { ctm: node.ctm, inDefs: node.defOnly, node };
          stack.push(frame);
          el.onEndTag(() => {
            // Defensive: HTMLRewriter pairs these, but a malformed artifact
            // must not corrupt every subsequent node's depth.
            const i = stack.lastIndexOf(frame);
            if (i >= 0) stack.length = i;
          });
        }
      },
      text(chunk) {
        // Text belongs to the INNERMOST OPEN element (correct nesting
        // semantics), not merely the most recently seen one.
        const top = stack[stack.length - 1];
        if (top) top.node.text += chunk.text;
      },
    })
    .transform(new Response(html))
    .text();

  const root = nodes[0];
  let width = 0;
  let height = 0;
  if (root) {
    const vb = attr(root, "viewBox");
    const parts = vb
      ? vb.split(/[\s,]+/).map((s) => Number.parseFloat(s)).filter((n) => Number.isFinite(n))
      : [];
    if (parts.length === 4) {
      width = parts[2]!;
      height = parts[3]!;
    } else {
      width = numAttr(root, "width");
      height = numAttr(root, "height");
    }
  }
  return { width, height, nodes };
}
