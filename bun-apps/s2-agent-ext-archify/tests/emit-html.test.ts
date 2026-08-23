import { describe, expect, test } from "bun:test";
import { PALETTES } from "../src/deck-theme.ts";
import { emitHtmlSlide, type EmitHtmlCtx } from "../src/emit-html.ts";
import { emitPptxSlide } from "../src/emit-pptx.ts";
import { layoutFor } from "../src/layouts.ts";
import type { ShapeIR } from "../src/shape-ir.ts";
import type { LayoutCtx, Slide, SlideLayout } from "../src/slide-model.ts";
import { allText, spySlide } from "./helpers/spy-slide.ts";

const CTX: LayoutCtx = { index: 2, total: 7, tag: "deck" };

const DIAGRAM: ShapeIR = { width: 10, height: 10, theme: "light", nodes: [] };

function htmlCtx(over: Partial<EmitHtmlCtx> = {}): EmitHtmlCtx {
  return {
    palette: PALETTES.light,
    font: "PingFang TC",
    title: "slide",
    theme: "light",
    diagramSrc: new Map(),
    ...over,
  };
}

const SLIDE: Slide = {
  title: "Cold-path latency, not the hot path, is what users feel",
  takeaway: "Cache the resolver and p99 halves",
  source: "Source: prod traces",
  bullets: ["p99 is 4.2 s", { text: "3.1 s of it is DNS", level: 1 }],
  statement: "One resolver call costs three seconds",
  eyebrow: "PLATFORM REVIEW",
  subtitle: "30 days of traces",
  attribution: "— the trace",
  ir: "/abs/x.json",
};

/** The composed layouts. `diagram` never reaches this emitter — see D4. */
const COMPOSED: SlideLayout[] = ["title", "section", "bullets", "split", "statement"];

describe("self-contained", () => {
  test.each(COMPOSED)("%s references nothing off the machine", (name) => {
    const html = emitHtmlSlide(layoutFor(name)(SLIDE, CTX), htmlCtx());
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<script/i);
    // One inline stylesheet, no <link>.
    expect(html).not.toMatch(/<link\b/i);
    expect(html.match(/<style>/g) ?? []).toHaveLength(1);
  });

  test("escapes authored copy rather than interpolating it", () => {
    const html = emitHtmlSlide(
      layoutFor("bullets")({ title: '<img src=x onerror="boom">', bullets: ["a & b"] }, CTX),
      htmlCtx()
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("a &amp; b");
  });
});

describe("cross-emitter consistency", () => {
  test.each(COMPOSED)("%s says the same words in HTML as in PPTX", (name) => {
    // A block dropped by one emitter only is the failure this catches — the two
    // are driven by the same PlacedBlock[] precisely so they cannot drift.
    const blocks = layoutFor(name)(SLIDE, CTX);
    const slide = spySlide();
    emitPptxSlide(slide, blocks, {
      palette: PALETTES.light,
      theme: "light",
      font: "PingFang TC",
      diagrams: new Map([["/abs/x.json", DIAGRAM]]),
    });
    const html = emitHtmlSlide(blocks, htmlCtx());
    for (const s of allText(slide)) {
      if (s === "") continue;
      expect(html, `${name}: ${JSON.stringify(s)}`).toContain(
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
      );
    }
  });
});

describe("diagram blocks", () => {
  test("become an iframe at the sibling artifact when one is known", () => {
    const blocks = layoutFor("split")(SLIDE, CTX);
    const html = emitHtmlSlide(
      blocks,
      htmlCtx({ diagramSrc: new Map([["/abs/x.json", { file: "slide-3.diagram.html", aspect: 2.5 }]]) })
    );
    expect(html).toContain('<iframe src="slide-3.diagram.html?embed=1&amp;theme=light"');
  });

  test("render as an empty area, not a broken frame, when unknown", () => {
    const html = emitHtmlSlide(layoutFor("split")(SLIDE, CTX), htmlCtx());
    expect(html).not.toContain("<iframe");
    expect(html).toContain('class="b frame"');
  });
});

describe("geometry", () => {
  test("boxes become percentages of a 16:9 stage", () => {
    const html = emitHtmlSlide(layoutFor("section")(SLIDE, CTX), htmlCtx());
    expect(html).toContain("aspect-ratio:16/9");
    // The section panel is full bleed.
    expect(html).toContain("left:0%;top:0%;width:100%;height:100%");
  });

  test("one typographic point is expressed once, in --pt", () => {
    // 13.333 in = 960 pt. Both emitters can then use deck-theme's point sizes
    // unchanged, which is why they cannot disagree about type size.
    const html = emitHtmlSlide(layoutFor("bullets")(SLIDE, CTX), htmlCtx());
    expect(html).toContain("--pt:calc(100cqw / 960)");
    expect(html).toMatch(/font-size:calc\(var\(--pt\) \* 26\)/);
  });
});
