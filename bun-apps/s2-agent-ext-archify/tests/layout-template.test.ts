import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { loadTemplate, TemplateError } from "../src/layout-template.ts";
import { CONTENT, STAGE } from "../src/deck-theme.ts";
import { formatBlocks, type LayoutCtx, type Slide } from "../src/slide-model.ts";

const GOLDENS = join(import.meta.dir, "fixtures", "templates");
const CTX: LayoutCtx = { index: 0, total: 1, tag: "archify deck" };
const SRC = "test.layout.json";

const SLIDE: Slide = {
  title: "Cold-path latency is what users feel",
  takeaway: "Cache the resolver",
  bullets: ["p99 is 4.2 s", { text: "of which 3.1 s is DNS", level: 1 }],
};

/** A minimal valid template, mutated per case. */
function tpl(body: unknown, extra: Record<string, unknown> = {}) {
  return { name: "probe", description: "probe template", chrome: false, body, ...extra };
}

function load(raw: unknown) {
  return () => loadTemplate(raw, SRC);
}

function expectError(raw: unknown, re: RegExp) {
  try {
    loadTemplate(raw, SRC);
  } catch (e) {
    expect(e).toBeInstanceOf(TemplateError);
    // Every error names its source file.
    expect((e as Error).message).toContain(SRC);
    expect((e as Error).message).toMatch(re);
    return;
  }
  throw new Error(`expected loadTemplate to throw for ${JSON.stringify(raw)}`);
}

const BOX = { box: "fill", content: { kind: "rule" } };

const schema = JSON.parse(
  await Bun.file(join(import.meta.dir, "..", "templates", "layout-template.schema.json")).text()
);
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

describe("schema contract", () => {
  test("the schema compiles and accepts a valid template", () => {
    expect(
      validate(tpl([{ region: "content", ...BOX }], { chrome: true }))
    ).toBe(true);
  });

  test.each([
    ["bad name pattern", tpl([BOX], { name: "Bad_Name" }), /name/],
    ["missing description", { name: "x", body: [BOX] }, /description/],
    ["empty body", tpl([]), /body/],
    ["unknown content kind", tpl([{ region: "content", box: "fill", content: { kind: "chart" } }]), /content/],
    ["region without payload", tpl([{ region: "full" }]), /exactly one schema in oneOf|stack|repeat|box/i],
  ])("schema rejects: %s", (_label, raw, re) => {
    expect(validate(raw)).toBe(false);
    expect(JSON.stringify(validate.errors)).toMatch(re as RegExp);
  });
});

describe("load-time errors — each names file + JSON path + expectation", () => {
  test("name matching a code layout is rejected outright (D3)", () => {
    expectError(tpl([{ region: "content", ...BOX }], { name: "diagram" }), /code layout/);
    expectError(tpl([{ region: "content", ...BOX }], { name: "bullets" }), /code layout/);
  });

  test("name not matching ^[a-z][a-z0-9-]*$", () => {
    expectError(tpl([{ region: "content", ...BOX }], { name: "Kpi_Row" }), /a-z/);
    expectError(tpl([{ region: "content", ...BOX }], { name: "9lives" }), /a-z/);
  });

  test("roles.*.color must be a Palette key", () => {
    expectError(
      tpl([{ region: "content", ...BOX }], { roles: { kpiValue: { sizePt: 40, color: "#FF0000" } } }),
      /Palette key/
    );
    // accept
    loadTemplate(
      tpl([{ region: "content", ...BOX }], { roles: { kpiValue: { sizePt: 40, color: "title" } } }),
      SRC
    );
  });

  test("from token outside the enumerated vocabulary", () => {
    expectError(
      tpl([
        {
          region: "content",
          repeat: { over: "kpis", flow: "row", gap: 0.3 },
          cell: [
            { box: "fill", content: { kind: "text", role: "kpiValue", from: "{VALUE}" }, align: "center" },
          ],
        },
      ], { slots: { kpis: { kind: "array", of: ["value"] } } }),
      /unknown binding \{VALUE\}/
    );
    expectError(tpl([{ region: "content", box: "fill", content: { kind: "text", role: "body", from: "x{nope}y" } }]), /unknown binding \{nope\}/);
    // accept: declared field, slide key, index tokens
    loadTemplate(
      tpl(
        [
          {
            region: "content",
            repeat: { over: "kpis", flow: "row", gap: 0.3 },
            cell: [
              {
                box: "fill",
                content: {
                  kind: "text",
                  role: "kpiValue",
                  from: "{value} {index1}/{slide.title}",
                },
                align: "center",
              },
            ],
          },
        ],
        { slots: { kpis: { kind: "array", of: ["value"] } } }
      ),
      SRC
    );
  });

  test("repeat.over naming an undeclared slot", () => {
    expectError(
      tpl([
        {
          region: "content",
          repeat: { over: "ghosts", flow: "row", gap: 0.3 },
          cell: [BOX],
        },
      ]),
      /over/
    );
  });

  test("content.kind no emitter knows", () => {
    expectError(tpl([{ region: "content", box: "fill", content: { kind: "chart" } }]), /chart/);
  });

  test("unknown region", () => {
    expectError(tpl([{ region: "header", box: "fill", content: { kind: "rule" } }]), /unknown region/);
    // CONTENT stays D3-locked: not exposed as a region.
    expectError(tpl([{ region: "CONTENT", box: "fill", content: { kind: "rule" } }]), /unknown region/);
  });

  test("structural errors are loud too", () => {
    expectError(
      tpl([{ region: "content", stack: { dir: "col", weights: [1, 1], gap: 0 }, children: [BOX] }]),
      /one child per weight/
    );
    expectError(
      tpl([{ region: "content", stack: { dir: "col", weights: [1], gap: 0 }, children: [BOX] }]),
      /weights/
    );
    expectError(tpl([{ region: "content", box: { inset: [0, 0, 0] }, content: { kind: "rule" } }]), /four finite numbers/);
    expectError(tpl([{ region: "content", stack: { dir: "col", weights: [1, 1], gap: 0 } }]), /children/);
    expectError({ name: "ok", description: "d", body: [] }, /non-empty array/);
  });
});

describe("per-primitive geometry goldens", () => {
  test.each([
    [
      "box",
      tpl([{ region: "content", box: { inset: [0.2, 0.3, 0.4, 0.5] }, content: { kind: "text", role: "body", from: "{slide.title}" }, align: "left", valign: "top" }]),
      SLIDE,
    ],
    [
      "stack",
      tpl([
        {
          region: "content",
          stack: { dir: "col", weights: [2, 1], gap: 0.4 },
          children: [
            { box: "fill", content: { kind: "text", role: "body", from: "{slide.title}" } },
            { box: "fill", content: { kind: "bullets", role: "bullet", from: "{slide.bullets}" } },
          ],
        },
      ]),
      SLIDE,
    ],
    [
      "repeat",
      tpl(
        [
          {
            region: "content",
            repeat: { over: "kpis", flow: "row", gap: 0.3, max: 4 },
            cell: [
              {
                box: { inset: [0, 0.4, 0, 1.6] },
                content: { kind: "text", role: "kpiValue", from: "{value} {index1}" },
                align: "center",
                valign: "middle",
              },
            ],
          },
        ],
        { slots: { kpis: { kind: "array", of: ["value"], max: 4 } } }
      ),
      { ...SLIDE, kpis: [{ value: "42%" }, { value: "3.1 s" }, { value: "17 ms" }] } as unknown as Slide,
    ],
    [
      "region-takeaway",
      tpl([{ region: "content", box: "fill", content: { kind: "panel", tone: "section" } }]),
      SLIDE,
    ],
  ])("%s", async (label, raw, slide) => {
    const blocks = loadTemplate(raw, SRC).render(slide, CTX);
    const got = `${formatBlocks(blocks)}\n`;
    const path = join(GOLDENS, `${label}.txt`);
    if (process.env["UPDATE_TEMPLATE_GOLDENS"] === "1" || !existsSync(path)) {
      mkdirSync(GOLDENS, { recursive: true });
      await Bun.write(path, got);
    }
    expect(got).toBe(await Bun.file(path).text());
  });

  test("the content region moves down when a takeaway is present — and back when absent", () => {
    const t = loadTemplate(tpl([{ region: "content", box: "fill", content: { kind: "rule" } }]), SRC);
    const withT = t.render(SLIDE, CTX)[0]!;
    const withoutT = t.render({ ...SLIDE, takeaway: undefined }, CTX)[0]!;
    const yWith = withT.box.y * 7.5;
    const yWithout = withoutT.box.y * 7.5;
    expect(yWith).toBeCloseTo(1.5, 9);
    expect(yWithout).toBeCloseTo(1.4, 9);
  });
});

describe("timeline vocabulary verdict — two siblings may address one region, paint order = document order", () => {
  test("a rule spanning the row renders BEFORE the evenly spaced stations", () => {
    const t = loadTemplate(
      tpl(
        [
          {
            region: "content",
            box: { inset: [0.5, 2.5, 0.5, 4.8] },
            content: { kind: "rule" },
          },
          {
            region: "content",
            repeat: { over: "milestones", flow: "row", gap: 0.3 },
            cell: [
              {
                box: "fill",
                content: { kind: "text", role: "milestoneLabel", from: "{label}" },
                align: "center",
              },
            ],
          },
        ],
        { slots: { milestones: { kind: "array", of: ["date", "label"], min: 3, max: 6 } } }
      ),
      SRC
    );
    const blocks = t.render(
      {
        title: "T",
        milestones: [{ label: "Q1" }, { label: "Q2" }, { label: "Q3" }],
      } as unknown as Slide,
      CTX
    );
    const kinds = blocks.map((b) => b.content.kind);
    // The single rule block comes first → paints behind every station.
    expect(kinds[0]).toBe("rule");
    expect(kinds.slice(1)).toEqual(["text", "text", "text"]);
    // Evenly spaced: equal widths across the full content well.
    const ws = blocks.slice(1).map((b) => b.box.w * STAGE.w);
    const expected = (CONTENT.w - 2 * 0.3) / 3;
    for (const w of ws) expect(w).toBeCloseTo(expected, 6);
  });
});
