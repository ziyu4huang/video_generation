import { describe, expect, test } from "bun:test";
import { addShapeIrToSlide, labelWidthEms, type Box } from "../lib/pptx-shapes.ts";
import { textEms } from "../lib/text-extent.ts";
import { spySlide, type SpyCall } from "./helpers/spy-slide.ts";
import type { ShapeIR, ShapeNode, Style } from "../lib/shape-ir.ts";

const BLACK: Style = { fill: { r: 0, g: 0, b: 0, a: 1 } };
const STROKE: Style = { stroke: { r: 17, g: 34, b: 51, a: 1 }, strokeWidth: 2, fill: null };

function ir(nodes: ShapeNode[], w = 100, h = 100): ShapeIR {
  return { width: w, height: h, theme: "light", nodes };
}

/** 10in x 10in box at the origin over a 100x100 viewBox ⇒ scale 0.1 in/unit. */
const BOX: Box = { x: 0, y: 0, w: 10, h: 10 };

describe("layout", () => {
  test("uses a uniform scale and centres, never stretching", () => {
    const slide = spySlide();
    // 200x100 content into a 10x10 box ⇒ scale 0.05, vertically centred.
    const r = addShapeIrToSlide(
      slide,
      ir([{ kind: "rect", x: 0, y: 0, w: 200, h: 100, style: BLACK }], 200, 100),
      BOX
    );
    expect(r.scale).toBeCloseTo(0.05, 10);
    const o = slide.calls[0]!.opts;
    expect(o["w"]).toBeCloseTo(10, 10);
    expect(o["h"]).toBeCloseTo(5, 10);
    expect(o["x"]).toBeCloseTo(0, 10);
    expect(o["y"]).toBeCloseTo(2.5, 10); // (10 - 5) / 2
  });

  test("honours the box offset", () => {
    const slide = spySlide();
    addShapeIrToSlide(slide, ir([{ kind: "rect", x: 0, y: 0, w: 100, h: 100, style: BLACK }]), {
      x: 1,
      y: 2,
      w: 10,
      h: 10,
    });
    expect(slide.calls[0]!.opts["x"]).toBeCloseTo(1, 10);
    expect(slide.calls[0]!.opts["y"]).toBeCloseTo(2, 10);
  });

  test("a degenerate viewBox emits nothing instead of dividing by zero", () => {
    const slide = spySlide();
    const r = addShapeIrToSlide(slide, ir([{ kind: "rect", x: 0, y: 0, w: 1, h: 1, style: BLACK }], 0, 0), BOX);
    expect(r).toEqual({ shapes: 0, texts: 0, scale: 0 });
    expect(slide.calls).toEqual([]);
  });
});

describe("shape mapping", () => {
  test("a plain rect becomes prstGeom rect", () => {
    const slide = spySlide();
    addShapeIrToSlide(slide, ir([{ kind: "rect", x: 10, y: 20, w: 30, h: 40, style: BLACK }]), BOX);
    expect(slide.calls[0]!.type).toBe("rect");
    expect(slide.calls[0]!.opts).toMatchObject({ x: 1, y: 2, w: 3, h: 4 });
  });

  /**
   * `rectRadius` is a LENGTH IN INCHES, not a fraction of the smaller side.
   *
   * Both of these tests previously asserted the fraction — the second even
   * named the failure mode it was supposed to prevent ("a pill, not an invalid
   * adjust") while passing on output that emitted `adj val="269169"`, five times
   * ECMA-376's 50000 ceiling. They asserted what archify SENT; pptxgenjs's
   * formula is `adj = rectRadius * 914400 * 100000 / min(cx, cy)`, so a
   * fraction passed as inches is scaled by the shape's own size and explodes on
   * small shapes. That is P1 of archify-deck-visual-fidelity.
   *
   * The invariant that actually matters is asserted on the emitted XML, by
   * `ooxml-lint`'s `shape-adjust-range` rule — a unit test on the argument can
   * never see the defect.
   */
  test("a rounded rect becomes roundRect with its radius in INCHES", () => {
    const slide = spySlide();
    // rx 5 on a 40x20 rect ⇒ 5/20 = 0.25 of the smaller side. The 100x100 IR
    // maps into a 10x10 in box, so the smaller side is 20 * 0.1 = 2 in and the
    // radius is 0.25 * 2 = 0.5 in.
    addShapeIrToSlide(
      slide,
      ir([{ kind: "rect", x: 0, y: 0, w: 40, h: 20, rx: 5, style: BLACK }]),
      BOX
    );
    expect(slide.calls[0]!.type).toBe("roundRect");
    expect(slide.calls[0]!.opts["rectRadius"]).toBeCloseTo(0.5, 3);
  });

  test("an over-large rx clamps at half the smaller side (a pill, not a burst)", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([{ kind: "rect", x: 0, y: 0, w: 40, h: 20, rx: 999, style: BLACK }]),
      BOX
    );
    // Clamped fraction 0.5 of a 2 in side ⇒ 1 in, i.e. adj = 50000 exactly.
    expect(slide.calls[0]!.opts["rectRadius"]).toBeCloseTo(1.0, 3);
  });

  test("an ellipse is placed by its bounding box", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([{ kind: "ellipse", cx: 50, cy: 50, rx: 10, ry: 5, style: BLACK }]),
      BOX
    );
    expect(slide.calls[0]!.type).toBe("ellipse");
    expect(slide.calls[0]!.opts).toMatchObject({ x: 4, y: 4.5, w: 2, h: 1 });
  });

  test("a polygon becomes a closed custGeom with rebased points", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        {
          kind: "polygon",
          points: [
            { x: 10, y: 10 },
            { x: 30, y: 10 },
            { x: 20, y: 30 },
          ],
          style: BLACK,
        },
      ]),
      BOX
    );
    const c = slide.calls[0]!;
    expect(c.type).toBe("custGeom");
    // Points are RELATIVE to the shape box (measured pptxgenjs semantics).
    expect(c.opts["x"]).toBeCloseTo(1, 10);
    expect(c.opts["y"]).toBeCloseTo(1, 10);
    expect(c.opts["points"]).toEqual([
      { x: 0, y: 0, moveTo: true },
      { x: 2, y: 0 },
      { x: 1, y: 2 },
      { close: true },
    ]);
  });
});

describe("paths and connectors", () => {
  test("a straight two-point path becomes a native line", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        {
          kind: "path",
          closed: false,
          segments: [
            { c: "M", x: 10, y: 10 },
            { c: "L", x: 50, y: 10 },
          ],
          style: STROKE,
        },
      ]),
      BOX
    );
    const c = slide.calls[0]!;
    expect(c.type).toBe("line");
    expect(c.opts).toMatchObject({ x: 1, y: 1, w: 4, h: 0 });
    expect(c.opts["flipH"]).toBeUndefined();
  });

  test("a right-to-left line flips so its direction survives", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        {
          kind: "path",
          closed: false,
          segments: [
            { c: "M", x: 50, y: 40 },
            { c: "L", x: 10, y: 10 },
          ],
          style: STROKE,
        },
      ]),
      BOX
    );
    expect(slide.calls[0]!.opts).toMatchObject({ flipH: true, flipV: true });
  });

  test("marker-end on a straight run uses a NATIVE arrowhead (stays one shape)", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        {
          kind: "path",
          closed: false,
          markerEnd: "arrowhead",
          segments: [
            { c: "M", x: 10, y: 10 },
            { c: "L", x: 50, y: 10 },
          ],
          style: STROKE,
        },
      ]),
      BOX
    );
    expect(slide.calls).toHaveLength(1);
    expect((slide.calls[0]!.opts["line"] as Record<string, unknown>)["endArrowType"]).toBe("triangle");
  });

  test("a curved path becomes custGeom with a quadratic curve point", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        {
          kind: "path",
          closed: false,
          segments: [
            { c: "M", x: 0, y: 0 },
            { c: "Q", x1: 50, y1: 0, x: 50, y: 50 },
          ],
          style: STROKE,
        },
      ]),
      BOX
    );
    const pts = slide.calls[0]!.opts["points"] as Record<string, unknown>[];
    expect(slide.calls[0]!.type).toBe("custGeom");
    expect(pts[1]!["curve"]).toEqual({ type: "quadratic", x1: 5, y1: 0 });
  });

  test("a cubic path carries both control points", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        {
          kind: "path",
          closed: false,
          segments: [
            { c: "M", x: 0, y: 0 },
            { c: "C", x1: 10, y1: 0, x2: 20, y2: 10, x: 30, y: 10 },
          ],
          style: STROKE,
        },
      ]),
      BOX
    );
    const pts = slide.calls[0]!.opts["points"] as Record<string, unknown>[];
    expect(pts[1]!["curve"]).toEqual({ type: "cubic", x1: 1, y1: 0, x2: 2, y2: 1 });
  });

  test("a closepath emits a close point", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        {
          kind: "path",
          closed: true,
          segments: [
            { c: "M", x: 0, y: 0 },
            { c: "L", x: 10, y: 0 },
            { c: "Z" },
          ],
          style: BLACK,
        },
      ]),
      BOX
    );
    const pts = slide.calls[0]!.opts["points"] as Record<string, unknown>[];
    expect(pts[pts.length - 1]).toEqual({ close: true });
  });

  test("marker-end on a MULTI-segment route emits a separate arrowhead shape", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        {
          kind: "path",
          closed: false,
          markerEnd: "arrowhead",
          segments: [
            { c: "M", x: 0, y: 0 },
            { c: "L", x: 20, y: 0 },
            { c: "L", x: 20, y: 40 },
          ],
          style: STROKE,
        },
      ]),
      BOX
    );
    expect(slide.calls).toHaveLength(2);
    expect(slide.calls[1]!.type).toBe("custGeom");
    const pts = slide.calls[1]!.opts["points"] as { x: number; y: number }[];
    expect(pts).toHaveLength(4); // 3 corners + close
    // The tip sits at the route's terminal point (20,40) ⇒ 2in, 4in.
    const tip = pts.slice(0, 3).map((p) => ({
      x: (slide.calls[1]!.opts["x"] as number) + p.x,
      y: (slide.calls[1]!.opts["y"] as number) + p.y,
    }));
    expect(Math.max(...tip.map((p) => p.y))).toBeCloseTo(4, 6);
  });
});

describe("style", () => {
  test("translucent fills are composited onto the theme background", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        {
          kind: "rect",
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          style: { fill: { r: 0, g: 0, b: 0, a: 0.5 } },
        },
      ]),
      BOX
    );
    // 50% black over the light theme's white page ⇒ mid grey, opaque.
    expect((slide.calls[0]!.opts["fill"] as Record<string, unknown>)["color"]).toBe("808080");
  });

  /**
   * A no-fill shape OMITS `fill` — it does not pass `{ type: "none" }`.
   *
   * The previous spelling of this test asserted `toEqual({ type: "none" })`,
   * which is what archify SENT and never what pptxgenjs EMITTED. Measured
   * against pptxgenjs@4.0.1 (2026-08-22), `{ type: "none" }` produces no fill
   * element at all in `<p:spPr>`, and DrawingML reads an absent fill as
   * "inherit from the shape style" — so every stroke-only icon was painted by
   * the theme. Omitting the key is what produces `<a:noFill/>`.
   *
   * This is P1 of `.planning/2026-08-21-archify-deck-visual-fidelity`. A test
   * that asserts the argument rather than the artifact cannot catch it, which
   * is why `ooxml-noFill` below asserts the emitted XML instead.
   */
  test("a fill-less shape omits `fill` so pptxgenjs emits <a:noFill/>", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([{ kind: "rect", x: 0, y: 0, w: 10, h: 10, style: { fill: null } }]),
      BOX
    );
    expect(slide.calls[0]!.opts).not.toHaveProperty("fill");
  });

  test("stroke width converts to points and honours a hairline floor", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        { kind: "rect", x: 0, y: 0, w: 10, h: 10, style: { ...STROKE, strokeWidth: 2 } },
        { kind: "rect", x: 0, y: 0, w: 10, h: 10, style: { ...STROKE, strokeWidth: 0.01 } },
      ]),
      BOX
    );
    // 2 units * 0.1 in/unit * 72 pt/in = 14.4pt
    expect((slide.calls[0]!.opts["line"] as Record<string, unknown>)["width"]).toBeCloseTo(14.4, 6);
    expect((slide.calls[1]!.opts["line"] as Record<string, unknown>)["width"]).toBe(0.5);
  });

  test("dasharrays map onto PowerPoint's preset dashes", () => {
    const slide = spySlide();
    const dashes = [[1, 3], [4, 4], [6, 6], [12, 4]];
    addShapeIrToSlide(
      slide,
      ir(
        dashes.map((dash) => ({
          kind: "rect" as const,
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          style: { ...STROKE, dash },
        }))
      ),
      BOX
    );
    expect(
      slide.calls.map((c) => (c.opts["line"] as Record<string, unknown>)["dashType"])
    ).toEqual(["sysDot", "dash", "sysDash", "lgDash"]);
  });
});

describe("text", () => {
  test("a middle-anchored label is centred on its SVG anchor point", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        {
          kind: "text",
          x: 50,
          y: 50,
          text: "hi",
          anchor: "middle",
          fontSize: 10,
          fontWeight: 400,
          style: BLACK,
        },
      ]),
      BOX
    );
    const o = slide.calls[0]!.opts;
    expect(slide.calls[0]!.fn).toBe("addText");
    expect(o["align"]).toBe("center");
    expect((o["x"] as number) + (o["w"] as number) / 2).toBeCloseTo(5, 6);
  });

  test("start and end anchors extend the box the right way", () => {
    const slide = spySlide();
    const base = { kind: "text" as const, x: 50, y: 50, text: "hi", fontSize: 10, fontWeight: 400, style: BLACK };
    addShapeIrToSlide(
      slide,
      ir([
        { ...base, anchor: "start" },
        { ...base, anchor: "end" },
      ]),
      BOX
    );
    const [s, e] = slide.calls;
    expect(s!.opts["align"]).toBe("left");
    expect(s!.opts["x"]).toBeCloseTo(5, 6);
    expect(e!.opts["align"]).toBe("right");
    expect((e!.opts["x"] as number) + (e!.opts["w"] as number)).toBeCloseTo(5, 6);
  });

  test("the box straddles the baseline (SVG y is a baseline, PPTX y is a top)", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        {
          kind: "text",
          x: 50,
          y: 50,
          text: "hi",
          anchor: "start",
          fontSize: 10,
          fontWeight: 400,
          style: BLACK,
        },
      ]),
      BOX
    );
    const o = slide.calls[0]!.opts;
    const top = o["y"] as number;
    const bottom = top + (o["h"] as number);
    const baseline = 5; // y=50 * 0.1 in/unit
    expect(top).toBeLessThan(baseline);
    expect(bottom).toBeGreaterThan(baseline);
    expect(o["valign"]).toBe("middle");
  });

  test("font size scales, weight >= 600 is bold, wrapping is off", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        { kind: "text", x: 0, y: 50, text: "a", anchor: "start", fontSize: 10, fontWeight: 600, style: BLACK },
        { kind: "text", x: 0, y: 50, text: "b", anchor: "start", fontSize: 10, fontWeight: 400, style: BLACK },
      ]),
      BOX,
      { fontFace: "PingFang TC" }
    );
    expect(slide.calls[0]!.opts).toMatchObject({
      fontSize: 72, // 10 units * 0.1 in * 72 pt
      bold: true,
      wrap: false,
      margin: 0,
      fontFace: "PingFang TC",
    });
    expect(slide.calls[1]!.opts["bold"]).toBe(false);
  });
});

/**
 * The width contract (P3 of archify-deck-visual-fidelity).
 *
 * `wrap: false` asks the renderer not to break the line, and PowerPoint obeys —
 * but the deck also has to survive renderers that do not, so the reserved box
 * must be at least as wide as the string actually sets. The old estimate was
 * one Latin advance times `.length`, which is 0.837 em per character: right
 * enough for Latin, 16 % short for every ideograph, and that shortfall is what
 * broke the connector label `系統需求` into `系統需 / 求`.
 *
 * These assertions compute the expectation from `textEms()` — the same
 * calibrated model `deck-lint` uses for titles — and never render anything
 * (effort decision D1).
 */
describe("label width", () => {
  /** Reserved width of a single label, in ems of its own font size. */
  const reservedEms = (text: string, fontSize = 10): number => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([{ kind: "text", x: 50, y: 50, text, anchor: "middle", fontSize, fontWeight: 400, style: BLACK }]),
      BOX
    );
    // BOX is 10in over a 100-unit viewBox ⇒ 0.1 in/unit.
    return (slide.calls[0]!.opts["w"] as number) / (fontSize * 0.1);
  };

  const FIXTURES = [
    "Message bus", // pure Latin, lowercase-dominant
    "AUDIO APU", // pure Latin, all caps — the worst bucket case (`M`, `A`)
    "MMMM", // the single glyph the model under-estimates most
    "系統需求", // pure CJK — the reported defect
    "來源", // pure CJK, short enough to hit the 1-em floor question
    "SYS.1/2 需求", // mixed
    "≥ 2 GB/s 配額", // mixed with symbols and spaces
    "PG_AUDIO · PG_CAM", // Latin with a CJK-adjacent separator
  ];

  test.each(FIXTURES)("reserves at least the estimated set width: %p", (text) => {
    expect(reservedEms(text)).toBeGreaterThanOrEqual(textEms(text));
  });

  test("an ideograph is reserved a full em, not a Latin advance", () => {
    // The regression itself: 4 ideographs used to get 3.35 em.
    expect(reservedEms("系統需求")).toBeGreaterThanOrEqual(4);
    expect(reservedEms("來源")).toBeGreaterThanOrEqual(2);
  });

  test("the estimate leaves headroom over the model, not just parity", () => {
    // A model with ±1.7 % prose error and a −13 % worst-glyph miss cannot be
    // used at parity; `labelWidthEms` is an upper bound by construction.
    for (const t of FIXTURES) expect(labelWidthEms(t)).toBeGreaterThan(textEms(t));
  });

  test("an empty label still gets a box", () => {
    expect(reservedEms("")).toBeGreaterThanOrEqual(1);
  });

  test("width scales with font size, not with character count", () => {
    // Same character count, different scripts ⇒ different widths. The old
    // formula could not tell these two apart.
    expect(reservedEms("系統需求")).toBeGreaterThan(reservedEms("iiii"));
    expect(reservedEms("ABCD", 20)).toBeCloseTo(reservedEms("ABCD", 10), 6);
  });
});

describe("the shape-design contract", () => {
  test("addImage is NEVER called, for any node kind", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        { kind: "rect", x: 0, y: 0, w: 10, h: 10, style: BLACK },
        { kind: "rect", x: 0, y: 0, w: 10, h: 10, rx: 2, style: BLACK },
        { kind: "ellipse", cx: 5, cy: 5, rx: 2, ry: 2, style: BLACK },
        { kind: "polygon", points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], style: BLACK },
        { kind: "path", closed: false, segments: [{ c: "M", x: 0, y: 0 }, { c: "L", x: 5, y: 5 }], style: STROKE },
        {
          kind: "path",
          closed: false,
          markerEnd: "a",
          segments: [{ c: "M", x: 0, y: 0 }, { c: "L", x: 5, y: 0 }, { c: "L", x: 5, y: 5 }],
          style: STROKE,
        },
        { kind: "text", x: 1, y: 1, text: "t", anchor: "start", fontSize: 8, fontWeight: 400, style: BLACK },
      ]),
      BOX
    );
    expect(slide.calls.some((c) => c.fn === "addImage")).toBe(false);
    expect(slide.calls.filter((c) => c.fn === "addShape").length).toBeGreaterThanOrEqual(6);
  });

  test("emission order matches paint order", () => {
    const slide = spySlide();
    addShapeIrToSlide(
      slide,
      ir([
        { kind: "rect", x: 0, y: 0, w: 10, h: 10, style: BLACK },
        { kind: "path", closed: false, segments: [{ c: "M", x: 0, y: 0 }, { c: "L", x: 5, y: 5 }], style: STROKE },
        { kind: "text", x: 1, y: 1, text: "t", anchor: "start", fontSize: 8, fontWeight: 400, style: BLACK },
      ]),
      BOX
    );
    expect(slide.calls.map((c) => c.type ?? c.fn)).toEqual(["rect", "line", "addText"]);
  });
});
