/**
 * table-primitive.test.ts — the `table` drawing primitive (effort decision D5).
 *
 * The one BlockContent.kind added this effort, so it lands in BOTH emitters and
 * carries the acceptance properties with it:
 *
 *   - the pptx is a native `<a:tbl>` inside a graphicFrame, never an image;
 *   - `autoPage: false` is set EXPLICITLY (an over-long table must overflow
 *     one slide rather than spawn generated ones) and asserted at both the
 *     option level and the emitted-package level;
 *   - the HTML twin agrees on column count, header text and cell order.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PptxGenJS from "pptxgenjs";
import { lintDeck } from "../lib/deck-lint.ts";
import { PALETTES, type TypeSpec } from "../lib/deck-theme.ts";
import { emitHtmlSlide, type EmitHtmlCtx } from "../lib/emit-html.ts";
import { emitPptxSlide, type EmitPptxCtx } from "../lib/emit-pptx.ts";
import { lintPptx, formatDiagnostics } from "../lib/ooxml-lint.ts";
import { countSlides } from "../lib/deck-render.ts";
import { readZipText } from "../lib/read-zip.ts";
import { formatBlocks, type PlacedBlock } from "../lib/slide-model.ts";
import { allText, spySlide, tableCalls } from "./helpers/spy-slide.ts";

const TABLE: PlacedBlock["content"] = {
  kind: "table",
  columns: ["指標", "p99", "p50"],
  rows: [
    ["冷啟動", "4.2 s", "1.8 s"],
    ["熱路徑", "210 ms", "180 ms"],
  ],
  role: "body",
  headerRole: "title",
};

const BOX = { x: 0.5, y: 1.5, w: 8.0, h: 3.0 };

function pptxCtx(roleOf?: (role: string) => TypeSpec): EmitPptxCtx {
  return { palette: PALETTES.light, theme: "light", font: "PingFang TC", diagrams: new Map(), ...(roleOf ? { roleOf } : {}) };
}

function htmlCtx(): EmitHtmlCtx {
  return {
    palette: PALETTES.light,
    font: "PingFang TC",
    title: "slide",
    theme: "light",
    diagramSrc: new Map(),
  };
}

function emitTable(content: PlacedBlock["content"] = TABLE) {
  const slide = spySlide();
  emitPptxSlide(slide, [{ box: { x: 0.05, y: 0.2, w: 0.6, h: 0.4 }, content }], pptxCtx());
  return slide;
}

describe("pptx — a native table, placed like any other block", () => {
  test("one addTable call whose first row is the header", () => {
    const tables = tableCalls(emitTable());
    expect(tables).toHaveLength(1);
    expect(tables[0]!.opts["x"]).toBeCloseTo(0.6667, 3); // inches, from the frac box
    const rows = tables[0]!.rows as { text: string; options: Record<string, unknown> }[][];
    expect(rows).toHaveLength(3); // header + 2 body
    expect(rows[0]!.map((c) => c.text)).toEqual(["指標", "p99", "p50"]);
    expect(rows[1]!.map((c) => c.text)).toEqual(["冷啟動", "4.2 s", "1.8 s"]);
  });

  test("`autoPage` is set EXPLICITLY to false — never relied on as a library default", () => {
    const { opts } = tableCalls(emitTable())[0]!;
    expect("autoPage" in opts && opts["autoPage"] === false).toBe(true);
  });

  test("the header row takes its weight and colour from headerRole, the body from role", () => {
    const tables = tableCalls(emitTable())[0]!;
    const rows = tables.rows as { text: string; options: Record<string, unknown> }[][];
    // headerRole "title" → TYPE_SCALE.title: bold, palette.title colour.
    for (const head of rows[0]!) {
      expect(head.options["bold"]).toBe(true);
      expect(head.options["color"]).toBe(PALETTES.light.title);
    }
    // role "body" → not bold, palette.body.
    for (const cell of rows[1]!) {
      expect(cell.options["bold"]).toBeUndefined();
      expect(cell.options["color"]).toBe(PALETTES.light.body);
    }
  });

  test("template roles flow through roleOf — sizes follow the merged scale", () => {
    const roleOf = (role: string): TypeSpec =>
      role === "bigHead" ? { sizePt: 20, bold: true, color: "accent" } : { sizePt: 11, color: "body" };
    const slide = spySlide();
    emitPptxSlide(
      slide,
      [
        {
          box: { x: 0.05, y: 0.2, w: 0.6, h: 0.4 },
          content: { ...TABLE, role: "smallBody", headerRole: "bigHead" },
        },
      ],
      pptxCtx(roleOf)
    );
    const rows = tableCalls(slide)[0]!.rows as { text: string; options: Record<string, unknown> }[][];
    expect(rows[0]![0]!.options["fontSize"]).toBe(20);
    expect(rows[0]![0]!.options["color"]).toBe(PALETTES.light.accent);
    expect(rows[1]![0]!.options["fontSize"]).toBe(11);
  });

  test("even column widths spanning the declared box", () => {
    const colW = tableCalls(emitTable())[0]!.opts["colW"] as number[];
    expect(colW).toHaveLength(3);
    for (const w of colW) expect(w).toBeCloseTo(colW[0]!, 9);
    expect(colW.reduce((a, w) => a + w, 0)).toBeCloseTo(0.6 * 13.333, 3); // the box's stage fraction, back in inches
  });

  test("nothing is rasterized — a table reaches addImage zero times", () => {
    expect(emitTable().calls.filter((c) => c.fn === "addImage")).toHaveLength(0);
  });

  test("formatBlocks prints it so a golden can pin columns and cell order", () => {
    const out = formatBlocks([{ box: { x: 0.05, y: 0.2, w: 0.6, h: 0.4 }, content: TABLE }]);
    expect(out).toContain(`table:body/title ${JSON.stringify(TABLE.columns)}`);
    expect(out).toContain(JSON.stringify(["冷啟動", "4.2 s", "1.8 s"]));
  });
});

describe("html — the twin paints the same grid from the same two roles", () => {
  function twin(content: PlacedBlock["content"] = TABLE): string {
    return emitHtmlSlide([{ box: { x: 0.05, y: 0.2, w: 0.6, h: 0.4 }, content }], htmlCtx());
  }

  test("<th>/<td> carry the header text and cell order", () => {
    const html = twin();
    // `\s` so `<thead>` is not mistaken for an opening <th>.
    const ths = [...html.matchAll(/<th\s[^>]*>(.*?)<\/th>/g)].map((m) => m[1]);
    expect(ths).toEqual(["指標", "p99", "p50"]);
    const tds = [...html.matchAll(/<td>(.*?)<\/td>/g)].map((m) => m[1]);
    expect(tds).toEqual(["冷啟動", "4.2 s", "1.8 s", "熱路徑", "210 ms", "180 ms"]);
  });

  test("agrees with the pptx on column count, header text and cell order", () => {
    // The property both emitters exist for: driven by one PlacedBlock[], so
    // they cannot drift. Compare what each actually said, word for word.
    const slide = emitTable();
    const rows = tableCalls(slide)[0]!.rows as { text: string }[][];
    const pptxSaid = rows.flat().map((c) => c.text);
    const html = twin();
    const htmlSaid = [...html.matchAll(/<t[hd](\s[^>]*)?>(.*?)<\/t[hd]>/g)].map(
      (m) => m[2]!
    );
    expect(htmlSaid).toEqual(pptxSaid);
    // And every string that reached the pptx reached the page.
    for (const s of allText(slide)) if (s !== "") expect(html).toContain(s);
  });

  test("authored copy is escaped, roles are painted from the theme", () => {
    const html = twin({
      ...TABLE,
      columns: ["<b>欄</b>", "p99", "p50"],
      rows: [["a & b", "1", "2"]],
    });
    expect(html).not.toContain("<b>欄</b>");
    expect(html).toContain("&lt;b&gt;欄&lt;/b&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).toMatch(/<table class="tbl"/);
  });
});

describe("deck-lint — over-long tables are a LINT note, not an emitter behaviour", () => {
  test("more body rows than fit is a warn naming the never-split property", () => {
    const rows = Array.from({ length: 13 }, () => ["列", "1", "2"]);
    const notes = lintDeck({
      slides: [
        { title: "表格列數超過一頁能容納的數量", layout: "bullets", bullets: ["a"], columns: ["a"], rows } as never,
      ],
    });
    const hit = notes.find((n) => n.code === "too-many-table-rows");
    expect(hit?.severity).toBe("warn");
    expect(hit!.message).toMatch(/never split/);
    // At the threshold and below: silent.
    expect(
      lintDeck({
        slides: [
          { title: "T", layout: "bullets", columns: ["a"], rows: rows.slice(1) } as never,
        ],
      }).some((n) => n.code === "too-many-table-rows")
    ).toBe(false);
  });

  test("table copy joins the inline-colour sweep", () => {
    const notes = lintDeck({
      slides: [
        { title: "T", layout: "bullets", columns: ["#FF0000"], rows: [["ok"]] } as never,
      ],
    });
    expect(notes.some((n) => n.code === "inline-color")).toBe(true);
  });
});

describe("emitted XML — the acceptance properties on a real package", () => {
  const workDir = mkdtempSync(join(tmpdir(), "archify-table-"));
  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Build a REAL single-slide .pptx carrying one table, return its XML parts. */
  async function buildOne(rowsN: number): Promise<{ parts: Record<string, string>; path: string }> {
    const pptx = new PptxGenJS();
    pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
    pptx.layout = "WIDE";
    const s = pptx.addSlide() as unknown as Parameters<typeof emitPptxSlide>[0] & {
      background?: unknown;
    };
    s.background = { color: PALETTES.light.slideBg };
    const longRows = Array.from({ length: rowsN }, (_, i) => [`列 ${i + 1}`, `${i}`, `${i * 2}`]);
    emitPptxSlide(
      s,
      [
        {
          box: { x: 0.04, y: 0.2, w: 0.92, h: 0.6 },
          content: { kind: "table", columns: ["項目", "數量", "倍數"], rows: longRows, role: "body", headerRole: "title" },
        },
      ],
      pptxCtx()
    );
    const path = join(workDir, `table-${rowsN}.pptx`);
    await Bun.write(path, (await pptx.write({ outputType: "nodebuffer" })) as Uint8Array);
    return { parts: await readZipText(await Bun.file(path).bytes()), path };
  }

  test("a 3x3 CJK table emits <a:tbl>, zero <a:blip>, and passes lintPptx", async () => {
    const { parts } = await buildOne(2);
    const xml = parts["ppt/slides/slide1.xml"]!;
    expect(xml).toContain("<a:tbl>");
    expect(xml).toContain("<p:graphicFrame>");
    expect(/<a:blip\b/.test(xml)).toBe(false);
    expect(formatDiagnostics(await lintPptx(parts))).toBe("");
  });

  test("an over-long table yields exactly ONE slide — autoPage never splits it", async () => {
    // 60 body rows cannot fit 7.5 in of stage. If autoPage were ever truthy,
    // pptxgenjs would generate continuation slides here.
    const { parts } = await buildOne(60);
    expect(countSlides(parts)).toBe(1);
    const xml = parts["ppt/slides/slide1.xml"]!;
    expect(xml).toContain("<a:tbl>");
    expect(/<a:blip\b/.test(xml)).toBe(false);
    expect(formatDiagnostics(await lintPptx(parts))).toBe("");
  });
});
