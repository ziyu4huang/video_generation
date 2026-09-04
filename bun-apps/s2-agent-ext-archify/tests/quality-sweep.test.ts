import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lintDeck } from "../src/deck-lint.ts";
import { loadTemplate } from "../src/layout-template.ts";
import type { PlacedBlock } from "../src/slide-model.ts";

/**
 * Renderer-free geometry pins from the t40 quality sweep — the measured defects
 * (aspice4-chip-v5 slide 13, library deck slides 7/10/19) become assertions on
 * the placed-block model, per the fidelity effort's D1: the renderer sees, it
 * never gates.
 */

function load(name: string) {
  return loadTemplate(JSON.parse(readFileSync(new URL(`../templates/${name}.layout.json`, import.meta.url), "utf8")), `${name}.layout.json`);
}

function textBlocks(blocks: PlacedBlock[]): { x: number; y: number; w: number; h: number; text: string }[] {
  return blocks
    .filter((b) => b.content.kind === "text")
    .map((b) => {
      const content = b.content as { kind: "text"; text: string };
      return {
        x: b.box.x,
        y: b.box.y,
        w: b.box.w,
        h: b.box.h,
        text: content.text,
      };
    });
}

const CTX = { index: 0, total: 1, tag: "sweep" } as const;

describe("t40 — compare renders two side-by-side 50/50 columns", () => {
  test("side headings occupy disjoint, equal-width x-ranges", () => {
    const tpl = load("compare");
    const slide = {
      layout: "compare",
      title: "Self-built beats managed by year two",
      sides: [
        { heading: "Self-built", bullets: [{ text: "p99 4.2 s → 1.8 s" }] },
        { heading: "Managed service", bullets: [{ text: "Zero ops" }] },
      ],
    } as never;
    const blocks = textBlocks(tpl.render(slide, CTX));
    const headings = blocks.filter((b) => b.text === "Self-built" || b.text === "Managed service");
    expect(headings).toHaveLength(2);
    const [left, right] = headings.sort((a, b) => a.x - b.x);
    expect(left!.text).toBe("Self-built");
    expect(right!.x).toBeGreaterThanOrEqual(left!.x + left!.w); // disjoint columns
    expect(Math.abs(left!.w - right!.w)).toBeLessThan(0.01); // 50/50
  });
});

describe("t40 — timeline stations straddle the rule, never under it", () => {
  test("dates sit above the rule; labels and notes below it", () => {
    const tpl = load("timeline");
    const slide = {
      layout: "timeline",
      title: "Q2 is the only hard gate",
      milestones: [
        { date: "Q1", label: "Requirements frozen", note: "RFQ answered" },
        { date: "Q2", label: "Architecture ratified", note: "PPAP sample" },
        { date: "Q3", label: "Production proof", note: "bought off" },
      ],
    } as never;
    const blocks = textBlocks(tpl.render(slide, CTX));
    const notes = blocks.filter((b) => b.text === "RFQ answered");
    expect(notes).toHaveLength(1);
    // Fraction boxes (13.333 × 7.5 stage): the note band starts below the label
    // band, and the station bands sit inside the content well (top 1.4 in → 0.187).
    const label = blocks.find((b) => b.text === "Architecture ratified");
    const date = blocks.find((b) => b.text === "Q2");
    expect(label).toBeDefined();
    expect(date).toBeDefined();
    expect(notes[0]!.y).toBeGreaterThanOrEqual(label!.y + label!.h * 0.99);
    expect(date!.y).toBeGreaterThanOrEqual(0.186);
  });
});

describe("t40 — agenda note sits to the right of its title", () => {
  test("note column x-range starts at or after the title column's end", () => {
    const tpl = load("agenda");
    const slide = {
      layout: "agenda",
      title: "Today's decision",
      items: [
        { title: "Where the 4.2 s goes", note: "10 min" },
        { title: "Decision and next steps", note: "5 min" },
        { title: "Migration plan", note: "20 min" },
      ],
    } as never;
    const blocks = textBlocks(tpl.render(slide, CTX));
    const title = blocks.find((b) => b.text === "Where the 4.2 s goes")!;
    const note = blocks.find((b) => b.text === "10 min")!;
    expect(title).toBeDefined();
    expect(note).toBeDefined();
    expect(note!.x).toBeGreaterThanOrEqual(title!.x + title!.w - 0.01); // same row, right side
    expect(Math.abs(note!.y - title!.y)).toBeLessThan(0.3); // same band
  });
});

describe("t40 — statement-overflows gate", () => {
  const slideWith = (quote: string): unknown => ({
    layout: "quote",
    title: "A borrowed voice",
    attribution: "someone",
    quote,
  });

  test("a six-line quotation is refused (error)", () => {
    const long = Array.from({ length: 60 }, () => "derived requirement words").join(" ");
    const notes = lintDeck({ slides: [slideWith(long) as never] });
    const hit = notes.find((x) => x.code === "statement-overflows");
    expect(hit?.severity).toBe("error");
  });

  test("a short quotation stays clean", () => {
    const notes = lintDeck({ slides: [slideWith("Short and sharp.") as never] });
    expect(notes.find((x) => x.code === "statement-overflows")).toBeUndefined();
  });
});
