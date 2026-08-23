import { describe, expect, test } from "bun:test";
import {
  bulletSizePt,
  CONTENT,
  PALETTES,
  STAGE,
  TYPE_SCALE,
  type Role,
} from "../src/deck-theme.ts";
import {
  CONTENT_FRAC,
  formatBlocks,
  fromInches,
  normalizeBullets,
  resolveLayout,
  SLIDE_LAYOUTS,
  toInches,
  type PlacedBlock,
} from "../src/slide-model.ts";

describe("resolveLayout", () => {
  test("a slide with `ir` and no `layout` IS a diagram slide", () => {
    // The entire backward-compatibility story: every manifest written before
    // layouts existed says what it is by its shape, so it needs no edit and
    // there is no version field to bump.
    expect(resolveLayout({ title: "t", ir: "a.json" })).toBe("diagram");
  });

  test("an explicit layout always wins", () => {
    expect(resolveLayout({ title: "t", ir: "a.json", layout: "split" })).toBe("split");
  });

  test("falls back by content when neither is given", () => {
    expect(resolveLayout({ title: "t", statement: "s" })).toBe("statement");
    expect(resolveLayout({ title: "t", bullets: ["a"] })).toBe("bullets");
    expect(resolveLayout({ title: "t" })).toBe("title");
  });
});

describe("normalizeBullets", () => {
  test("plain strings are level 0", () => {
    expect(normalizeBullets(["a", { text: "b", level: 1 }])).toEqual([
      { text: "a", level: 0 },
      { text: "b", level: 1 },
    ]);
  });

  test("absent bullets are an empty list, not undefined", () => {
    expect(normalizeBullets(undefined)).toEqual([]);
  });
});

describe("stage conversion", () => {
  test("round-trips inches through fractions", () => {
    const box = { x: 0.5, y: 1.18, w: 12.333, h: 5.7 };
    const back = toInches(fromInches(box));
    for (const k of ["x", "y", "w", "h"] as const) {
      expect(back[k]).toBeCloseTo(box[k], 10);
    }
  });

  test("CONTENT_FRAC is the content well, in fractions", () => {
    expect(toInches(CONTENT_FRAC).w).toBeCloseTo(CONTENT.w, 10);
    expect(toInches(CONTENT_FRAC).y).toBeCloseTo(CONTENT.y, 10);
  });

  test("the stage is 16:9", () => {
    expect(STAGE.w / STAGE.h).toBeCloseTo(16 / 9, 3);
  });
});

describe("theme tokens", () => {
  test("every Role has a type spec", () => {
    // An exhaustive record, checked at runtime as well as by tsc: a Role added
    // without a size is a silently unstyled block, not a compile error, once
    // someone widens the type with a cast.
    const roles: Role[] = [
      "coverTitle",
      "coverSubtitle",
      "eyebrow",
      "date",
      "sectionNumber",
      "sectionTitle",
      "title",
      "takeaway",
      "body",
      "bullet",
      "statement",
      "attribution",
      "source",
      "pageNumber",
      "tag",
    ];
    for (const r of roles) {
      expect(TYPE_SCALE[r], r).toBeDefined();
      expect(TYPE_SCALE[r]!.sizePt, r).toBeGreaterThan(0);
    }
    expect(Object.keys(TYPE_SCALE).sort()).toEqual([...roles].sort());
  });

  test("every type spec paints with a real palette key", () => {
    for (const [role, spec] of Object.entries(TYPE_SCALE)) {
      expect(PALETTES.light[spec.color], role).toMatch(/^[0-9A-F]{6}$/);
      expect(PALETTES.dark[spec.color], role).toMatch(/^[0-9A-F]{6}$/);
    }
  });

  test("the six original palette keys are frozen", () => {
    // These are what a `diagram` slide paints with. Changing one silently
    // rewrites every deck built before composition existed.
    expect(PALETTES.light.slideBg).toBe("FFFFFF");
    expect(PALETTES.light.title).toBe("0F2740");
    expect(PALETTES.light.accent).toBe("2563EB");
    expect(PALETTES.light.subtitle).toBe("6B7280");
    expect(PALETTES.light.tagBg).toBe("EFF4FA");
    expect(PALETTES.light.tagBorder).toBe("CBD5E1");
    expect(PALETTES.dark.slideBg).toBe("0B1220");
    expect(PALETTES.dark.title).toBe("E2E8F0");
    expect(PALETTES.dark.accent).toBe("60A5FA");
    expect(PALETTES.dark.subtitle).toBe("94A3B8");
    expect(PALETTES.dark.tagBg).toBe("1E293B");
    expect(PALETTES.dark.tagBorder).toBe("334155");
  });

  test("the chrome type sizes match the pre-composition builder", () => {
    expect(TYPE_SCALE.title.sizePt).toBe(26);
    expect(TYPE_SCALE.title.bold).toBe(true);
    expect(TYPE_SCALE.tag.sizePt).toBe(10);
    expect(TYPE_SCALE.source.sizePt).toBe(11);
    expect(TYPE_SCALE.pageNumber.sizePt).toBe(11);
  });

  test("a nested bullet steps down but never below 10 pt", () => {
    expect(bulletSizePt(0)).toBe(16);
    expect(bulletSizePt(1)).toBe(14);
    expect(bulletSizePt(99)).toBe(10);
  });
});

describe("formatBlocks", () => {
  test("one readable line per block, in order", () => {
    const blocks: PlacedBlock[] = [
      { box: { x: 0, y: 0, w: 1, h: 0.1 }, content: { kind: "rule" } },
      {
        box: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 },
        content: { kind: "text", role: "title", text: "hi" },
        align: "center",
        valign: "middle",
      },
    ];
    expect(formatBlocks(blocks)).toBe(
      '[0 0 1 0.1] left/top rule\n[0.1 0.2 0.5 0.25] center/middle text:title "hi"'
    );
  });
});

test("SLIDE_LAYOUTS lists exactly the six shipped layouts", () => {
  expect([...SLIDE_LAYOUTS].sort()).toEqual([
    "bullets",
    "diagram",
    "section",
    "split",
    "statement",
    "title",
  ]);
});
