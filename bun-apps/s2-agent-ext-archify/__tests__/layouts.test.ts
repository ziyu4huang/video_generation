import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { clampRatio, layoutFor } from "../lib/layouts.ts";
import {
  formatBlocks,
  toInches,
  type LayoutCtx,
  type PlacedBlock,
  type Slide,
  type SlideLayout,
} from "../lib/slide-model.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "layouts");
const CTX: LayoutCtx = { index: 1, total: 5, tag: "archify deck" };

/** One authored slide carrying every field, so a golden shows all of them. */
const SLIDE: Slide = {
  title: "Cold-path latency, not the hot path, is what users feel",
  subtitle: "measured over 30 days of production traces",
  takeaway: "Cache the resolver and p99 halves",
  source: "Source: prod traces, 2026-07-01..07-30",
  bullets: ["p99 is 4.2 s", { text: "of which 3.1 s is DNS", level: 1 }, "p50 is unchanged"],
  ir: "/abs/slide.json",
  statement: "One resolver call is costing us three seconds",
  eyebrow: "PLATFORM REVIEW",
  attribution: "— the trace, not an opinion",
  date: "2026-08-21",
  sectionNumber: "02",
};

const CASES: SlideLayout[] = ["title", "section", "bullets", "split", "diagram", "statement"];

describe("goldens", () => {
  for (const name of CASES) {
    test(`${name} layout`, async () => {
      const blocks = layoutFor(name)(SLIDE, CTX);
      const got = `${formatBlocks(blocks)}\n`;
      const path = join(FIXTURES, `${name}.txt`);
      if (process.env["UPDATE_LAYOUT_GOLDENS"] === "1" || !existsSync(path)) {
        mkdirSync(FIXTURES, { recursive: true });
        await Bun.write(path, got);
      }
      expect(got).toBe(await Bun.file(path).text());
    });
  }
});

describe("invariants", () => {
  for (const name of CASES) {
    test(`${name}: every box is inside the stage`, () => {
      // Fractions, not inches. A box at x=0.5 meaning "half an inch" would land
      // mid-stage and look plausible; this catches the mix-up immediately.
      for (const b of layoutFor(name)(SLIDE, CTX)) {
        const label = `${name} ${JSON.stringify(b.content)}`;
        expect(b.box.x, label).toBeGreaterThanOrEqual(0);
        expect(b.box.y, label).toBeGreaterThanOrEqual(0);
        expect(b.box.w, label).toBeGreaterThan(0);
        expect(b.box.h, label).toBeGreaterThan(0);
        expect(b.box.x + b.box.w, label).toBeLessThanOrEqual(1.0001);
        expect(b.box.y + b.box.h, label).toBeLessThanOrEqual(1.0001);
      }
    });
  }

  test("no layout emits a diagram block for a slide without an `ir`", () => {
    const noIr: Slide = { ...SLIDE, ir: undefined };
    for (const name of CASES) {
      const kinds = layoutFor(name)(noIr, CTX).map((b) => b.content.kind);
      expect(kinds, name).not.toContain("diagram");
    }
  });

  test("an unknown layout name throws rather than rendering a blank slide", () => {
    expect(() => layoutFor("kpi" as SlideLayout)).toThrow(/Unknown slide layout/);
  });
});

describe("diagram layout reproduces the pre-composition chrome", () => {
  /** The literal inch coordinates the old private `addChrome()` used. */
  const LEGACY = {
    tag: { x: 9.7, y: 0.28, w: 3.13, h: 0.4 },
    title: { x: 0.5, y: 0.22, w: 9.0, h: 0.75 },
    rule: { x: 0.5, y: 1.02, w: 12.333, h: 0.035 },
    footer: { x: 0.5, y: 7.0, w: 11.4, h: 0.4 },
    page: { x: 11.9, y: 7.0, w: 0.94, h: 0.4 },
    content: { x: 0.5, y: 1.18, w: 12.333, h: 5.7 },
  };

  /** A legacy slide: `ir` + `title` + `subtitle`, and nothing else. */
  const legacySlide: Slide = { title: "T", subtitle: "S", ir: "/abs/x.json" };
  const blocks = layoutFor("diagram")(legacySlide, CTX);

  function inches(b: PlacedBlock) {
    return toInches(b.box);
  }

  test("emits exactly six blocks, in the order the old builder added them", () => {
    expect(blocks.map((b) => b.content.kind)).toEqual([
      "panel",
      "text",
      "text",
      "rule",
      "text",
      "text",
      "diagram",
    ]);
  });

  test.each([
    ["tag panel", 0, LEGACY.tag],
    ["tag text", 1, LEGACY.tag],
    ["title", 2, LEGACY.title],
    ["accent rule", 3, LEGACY.rule],
    ["footer", 4, LEGACY.footer],
    ["page number", 5, LEGACY.page],
    ["diagram", 6, LEGACY.content],
  ])("%s sits at the legacy coordinates", (_label, i, expected) => {
    const got = inches(blocks[i as number]!);
    for (const k of ["x", "y", "w", "h"] as const) {
      expect(got[k]).toBeCloseTo((expected as Record<string, number>)[k]!, 9);
    }
  });

  test("the footer text run exists even when there is no subtitle", () => {
    // The old builder wrote `opts.subtitle ?? ""` unconditionally, so the
    // text-run count is part of the compatibility surface.
    const bare = layoutFor("diagram")({ title: "T", ir: "/abs/x.json" }, CTX);
    const texts = bare.filter((b) => b.content.kind === "text");
    expect(texts).toHaveLength(4);
    expect((texts[2]!.content as { text: string }).text).toBe("");
  });

  test("`source` takes the footer when both it and `subtitle` are set", () => {
    const both = layoutFor("diagram")(
      { title: "T", subtitle: "S", source: "SRC", ir: "/abs/x.json" },
      CTX
    );
    const footer = both.filter((b) => b.content.kind === "text")[2]!;
    expect((footer.content as { text: string }).text).toBe("SRC");
  });
});

describe("split", () => {
  test("defaults to a 60/40 asymmetry, not an even split", () => {
    const blocks = layoutFor("split")(SLIDE, CTX);
    const diagram = blocks.find((b) => b.content.kind === "diagram")!;
    const bullets = blocks.find((b) => b.content.kind === "bullets")!;
    const ratio = diagram.box.w / (diagram.box.w + bullets.box.w);
    expect(ratio).toBeCloseTo(0.6, 6);
  });

  test("the two columns do not overlap", () => {
    const blocks = layoutFor("split")(SLIDE, CTX);
    const diagram = blocks.find((b) => b.content.kind === "diagram")!;
    const bullets = blocks.find((b) => b.content.kind === "bullets")!;
    expect(bullets.box.x).toBeGreaterThan(diagram.box.x + diagram.box.w);
  });

  test("ratio is clamped so neither column collapses", () => {
    expect(clampRatio(undefined)).toBe(0.6);
    expect(clampRatio(0.01)).toBe(0.35);
    expect(clampRatio(0.99)).toBe(0.8);
    expect(clampRatio(Number.NaN)).toBe(0.6);
    expect(clampRatio(0.5)).toBe(0.5);
  });
});

describe("takeaway band", () => {
  test("appears only when authored, and pushes nothing off the stage", () => {
    const without = layoutFor("bullets")({ ...SLIDE, takeaway: undefined }, CTX);
    const with_ = layoutFor("bullets")(SLIDE, CTX);
    expect(with_.length).toBe(without.length + 1);
    const band = with_.find(
      (b) => b.content.kind === "text" && b.content.role === "takeaway"
    )!;
    const rule = with_.find((b) => b.content.kind === "rule")!;
    expect(band.box.y + band.box.h).toBeLessThanOrEqual(rule.box.y + 1e-9);
  });
});

describe("statement", () => {
  test("does not also print the title — the statement IS the title", () => {
    const blocks = layoutFor("statement")(SLIDE, CTX);
    const roles = blocks
      .filter((b) => b.content.kind === "text")
      .map((b) => (b.content as { role: string }).role);
    expect(roles).not.toContain("title");
    expect(roles).toContain("statement");
  });

  test("falls back to the title when no statement is authored", () => {
    const blocks = layoutFor("statement")({ title: "Only a title" }, CTX);
    const s = blocks.find(
      (b) => b.content.kind === "text" && b.content.role === "statement"
    )!;
    expect((s.content as { text: string }).text).toBe("Only a title");
  });
});
