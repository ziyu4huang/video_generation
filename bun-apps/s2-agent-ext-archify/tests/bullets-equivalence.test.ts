import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadTemplate } from "../src/layout-template.ts";
import { layoutFor } from "../src/layouts.ts";
import {
  formatBlocks,
  type LayoutCtx,
  type Slide,
} from "../src/slide-model.ts";

const FIXTURE = join(import.meta.dir, "fixtures", "bullets-equiv.layout.json");
const CTX: LayoutCtx = { index: 1, total: 5, tag: "archify deck" };

/**
 * The effort's frontier (spec §5): `bullets` was designed BEFORE the template
 * vocabulary existed. Rebuilding it in the vocabulary alone and getting
 * line-for-line identical `formatBlocks` output is the honest proof that the
 * primitives are sufficient, not merely convenient for the layouts designed
 * alongside them.
 *
 * The capped width is the interesting part: bullets stops at 10.5 in, not the
 * full 12.333 content well — expressed as a right inset of 1.833, a constant,
 * because a template file may never carry a number that depends on a count.
 */
const tpl = loadTemplate(JSON.parse(await Bun.file(FIXTURE).text()), FIXTURE);

const BASE: Slide = {
  title: "Cold-path latency, not the hot path, is what users feel",
};

/** The six input shapes ticket 03 names. */
const SHAPES: [string, Slide][] = [
  ["with a takeaway", { ...BASE, takeaway: "Cache the resolver and p99 halves" }],
  ["without a takeaway", { ...BASE }],
  ["with source", { ...BASE, source: "Source: prod traces, 2026-07-01..07-30" }],
  [
    "subtitle only",
    { ...BASE, subtitle: "measured over 30 days of production traces" },
  ],
  ["zero bullets", { ...BASE, takeaway: "Cache the resolver" }],
  [
    "level-1 nesting",
    {
      ...BASE,
      bullets: ["p99 is 4.2 s", { text: "of which 3.1 s is DNS", level: 1 }, "p50 is unchanged"],
    },
  ],
];

describe("bullets equivalence — the vocabulary reaches a pre-vocabulary layout", () => {
  for (const [label, slide] of SHAPES) {
    test(label, () => {
      const fromTemplate = formatBlocks(tpl.render(slide, CTX));
      const fromCode = formatBlocks(layoutFor("bullets")(slide, CTX));
      expect(fromTemplate).toBe(fromCode);
    });
  }

  test("the fixture is absent from the catalog — it is not on any search path", async () => {
    const { loadRegistry } = await import("../src/layout-registry.ts");
    const catalog = loadRegistry({}).catalog();
    expect(catalog.map((c) => c.name)).not.toContain("bullets-equiv");
  });

  test("a test that cannot fail is the failure mode this repo has been burned by", async () => {
    // Deliberate mutation: shift one inset by 0.1. The equivalence must break.
    const raw = JSON.parse(await Bun.file(FIXTURE).text());
    raw.body[0].box.inset[2] += 0.1;
    const mutated = loadTemplate(raw, `${FIXTURE} (mutated)`);
    const slide: Slide = { ...BASE, bullets: ["a", "b"] };
    expect(formatBlocks(mutated.render(slide, CTX))).not.toBe(
      formatBlocks(layoutFor("bullets")(slide, CTX))
    );
  });
});
