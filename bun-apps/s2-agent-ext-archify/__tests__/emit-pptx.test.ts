import { describe, expect, test } from "bun:test";
import { PALETTES, TYPE_SCALE } from "../lib/deck-theme.ts";
import { emitPptxSlide, type EmitPptxCtx } from "../lib/emit-pptx.ts";
import { layoutFor } from "../lib/layouts.ts";
import type { ShapeIR } from "../lib/shape-ir.ts";
import { toInches, type LayoutCtx, type PlacedBlock, type Slide } from "../lib/slide-model.ts";
import { allText, spySlide, textCalls, type SpySlide } from "./helpers/spy-slide.ts";

const CTX: LayoutCtx = { index: 0, total: 3, tag: "deck" };

const DIAGRAM: ShapeIR = {
  width: 100,
  height: 50,
  theme: "light",
  nodes: [
    {
      kind: "rect",
      x: 0,
      y: 0,
      w: 100,
      h: 50,
      style: { fill: { r: 1, g: 2, b: 3, a: 1 } },
    },
  ],
};

function ctx(diagrams: Map<string, ShapeIR> = new Map()): EmitPptxCtx {
  return { palette: PALETTES.light, theme: "light", font: "PingFang TC", diagrams };
}

function emit(blocks: PlacedBlock[], c: EmitPptxCtx = ctx()): SpySlide {
  const slide = spySlide();
  emitPptxSlide(slide, blocks, c);
  return slide;
}

describe("text is a real, wrapping PowerPoint text box", () => {
  test("no text block is ever emitted with wrap disabled", () => {
    // `pptx-shapes.ts` deliberately uses `wrap: false` for diagram labels whose
    // line breaks the renderer already chose. Prose is the opposite case, and
    // this is the assertion that keeps the two from being confused.
    const blocks = layoutFor("bullets")(
      { title: "Latency is dominated by the cold path", bullets: ["a", "b"] },
      CTX
    );
    for (const call of textCalls(emit(blocks))) {
      expect(call.opts["wrap"]).not.toBe(false);
    }
  });

  test("content roles autofit; fixed chrome does not", () => {
    const slide = emit(
      layoutFor("statement")({ title: "T", statement: "A long claim about latency" }, CTX)
    );
    const byRole = new Map(textCalls(slide).map((c) => [c.text, c.opts]));
    expect(byRole.get("A long claim about latency")!["fit"]).toBe("shrink");
    // The tag chip is a fixed short label; shrinking it would be a defect, not
    // a rescue, so it must NOT carry an autofit.
    expect(byRole.get("deck")!["fit"]).toBeUndefined();
  });

  test("`left` alignment is left implicit — it is the OOXML default", () => {
    const slide = emit(layoutFor("bullets")({ title: "T", bullets: ["a"] }, CTX));
    const title = textCalls(slide).find((c) => c.text === "T")!;
    expect(title.opts["align"]).toBeUndefined();
    const page = textCalls(slide).find((c) => c.text === "1 / 3")!;
    expect(page.opts["align"]).toBe("right");
  });

  test("sizes and colours come from the type scale, never a literal", () => {
    const slide = emit(layoutFor("bullets")({ title: "T", bullets: ["a"] }, CTX));
    const title = textCalls(slide).find((c) => c.text === "T")!;
    expect(title.opts["fontSize"]).toBe(TYPE_SCALE.title.sizePt);
    expect(title.opts["color"]).toBe(PALETTES.light[TYPE_SCALE.title.color]);
    expect(title.opts["bold"]).toBe(true);
  });
});

describe("bullets", () => {
  const blocks = layoutFor("bullets")(
    {
      title: "Cold-path latency is what users feel",
      bullets: ["p99 is 4.2 s", { text: "3.1 s of it is DNS", level: 1 }, "p50 unchanged"],
    },
    CTX
  );

  test("become ONE text box holding a run per item", () => {
    const slide = emit(blocks);
    const runs = slide.calls.filter((c) => c.fn === "addText" && Array.isArray(c.text));
    expect(runs).toHaveLength(1);
    expect((runs[0]!.text as { text: string }[]).map((r) => r.text)).toEqual([
      "p99 is 4.2 s",
      "3.1 s of it is DNS",
      "p50 unchanged",
    ]);
  });

  test("nesting maps to indentLevel and a smaller size", () => {
    const slide = emit(blocks);
    const runs = (slide.calls.find((c) => Array.isArray(c.text))!.text as {
      options: Record<string, unknown>;
    }[]);
    expect(runs.map((r) => r.options["indentLevel"])).toEqual([0, 1, 0]);
    expect(runs[1]!.options["fontSize"]).toBeLessThan(runs[0]!.options["fontSize"] as number);
    for (const r of runs) expect(r.options["breakLine"]).toBe(true);
  });

  test("an empty bullet list emits nothing rather than an empty box", () => {
    const slide = emit([
      { box: { x: 0, y: 0, w: 1, h: 1 }, content: { kind: "bullets", role: "bullet", items: [] } },
    ]);
    expect(slide.calls).toHaveLength(0);
  });
});

describe("diagrams", () => {
  const slide: Slide = { title: "T", ir: "/abs/x.json", bullets: ["a"] };

  test("are placed through the existing ShapeIR path, into the block's box", () => {
    const blocks = layoutFor("split")(slide, CTX);
    const box = toInches(blocks.find((b) => b.content.kind === "diagram")!.box);
    const spy = emit(blocks, ctx(new Map([["/abs/x.json", DIAGRAM]])));
    // Found by its fill, not by size: the accent rule is also a wide `rect`.
    // The diagram's single 100x50 node, scaled uniformly into the split column
    // and centred — confining a diagram to 60 % is a different box, not
    // different code.
    const placed = spy.calls.find(
      (c) =>
        c.fn === "addShape" &&
        (c.opts["fill"] as { color?: string } | undefined)?.color === "010203"
    )!;
    expect(placed).toBeDefined();
    expect(placed.opts["w"] as number).toBeLessThanOrEqual(box.w + 1e-9);
    expect(placed.opts["h"] as number).toBeLessThanOrEqual(box.h + 1e-9);
  });

  test("a split's diagram column is ~60 % of the content width", () => {
    const blocks = layoutFor("split")(slide, CTX);
    const d = toInches(blocks.find((b) => b.content.kind === "diagram")!.box);
    expect(d.w / 12.333).toBeGreaterThan(0.5);
    expect(d.w / 12.333).toBeLessThan(0.65);
  });

  test("an unresolved diagram throws — it must never silently vanish", () => {
    const blocks = layoutFor("diagram")(slide, CTX);
    expect(() => emit(blocks, ctx())).toThrow(/no rendered diagram/);
  });
});

describe("nothing is ever rasterized", () => {
  test("no layout reaches addImage", () => {
    // The package's central acceptance property, asserted at the emitter rather
    // than only on the finished file.
    for (const name of ["title", "section", "bullets", "split", "diagram", "statement"] as const) {
      const blocks = layoutFor(name)(
        { title: "T", ir: "/abs/x.json", bullets: ["a"], statement: "s" },
        CTX
      );
      const spy = emit(blocks, ctx(new Map([["/abs/x.json", DIAGRAM]])));
      expect(spy.calls.filter((c) => c.fn === "addImage"), name).toHaveLength(0);
    }
  });
});

describe("counts", () => {
  test("every authored string reaches the slide", () => {
    const blocks = layoutFor("split")(
      {
        title: "Cold-path latency is what users feel",
        takeaway: "Cache the resolver",
        source: "prod traces",
        bullets: ["p99 is 4.2 s"],
        ir: "/abs/x.json",
      },
      CTX
    );
    const said = allText(emit(blocks, ctx(new Map([["/abs/x.json", DIAGRAM]]))));
    for (const s of [
      "Cold-path latency is what users feel",
      "Cache the resolver",
      "prod traces",
      "p99 is 4.2 s",
      "deck",
    ]) {
      expect(said, s).toContain(s);
    }
  });
});
