/**
 * html-figures.test.ts — html + svg figures end-to-end (effort
 * 2026-09-08-file2md-svg-pptx-vision, ticket 03).
 *
 * Two layers: unit cases on `extractSvgFigures` (balanced scanner, script/
 * style off-limits, local-ref resolution) and E2E cases through the real
 * pipeline with mocked raster + vision leaves (smart-mode.test.ts pattern).
 * The byte-identity pin (no-svg html → exactly today's passthrough output)
 * is the load-bearing guarantee for existing users.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIGURE_SKIP_NOTICE } from "../src/core/figure.ts";

const rasterState = { failInline: false };
const visionState = { available: false };
const visionCalls = { calls: 0, tasks: [] as string[] };
const visionReply = { ok: true as boolean, output: "A flow diagram.", error: "" };

const TINY_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

mock.module("../src/raster/svg.ts", () => ({
  renderSvgFileToPng: async () => ({ png: TINY_PNG, width: 64, height: 48 }),
  renderSvgTextToPng: async () => (rasterState.failInline ? null : { png: TINY_PNG, width: 64, height: 48 }),
}));

mock.module("../src/ocr/ocr.ts", () => ({
  OcrSession: class {
    constructor(public lang = "eng") {}
    async recognize(): Promise<{ text: string }> {
      return { text: "OCR" };
    }
    async terminate(): Promise<void> {}
  },
  ocrImageFile: async () => null,
  normalizeOcrLang: (l?: string) => l ?? "eng",
  imageDims: () => ({ width: 8, height: 8 }),
}));

mock.module("../src/sessions.ts", () => ({
  resolveVisionLLM: () => {
    if (!visionState.available) throw new Error("no vision capability configured");
    return { provider: "zai", modelId: "glm-5.3-flash", thinkingLevel: "off" as const };
  },
}));

mock.module("../src/vlm/vision-inference.ts", () => ({
  runVisionInference: async (opts: { task: string }) => {
    visionCalls.calls++;
    visionCalls.tasks.push(opts.task);
    if (visionReply.ok) return { output: visionReply.output, ok: true };
    return { output: "", ok: false, error: visionReply.error };
  },
}));

const { runFile2mdPipeline, htmlToMarkdown, extractSvgFigures, SVG_FIGURE_MAX } = await import("../src/pipeline.ts");

let tmp: string;
let out: string;
let abort: AbortController;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "file2md-html-test-"));
  out = join(tmp, "out");
  rasterState.failInline = false;
  visionState.available = false;
  visionCalls.calls = 0;
  visionCalls.tasks = [];
  visionReply.ok = true;
  visionReply.output = "A flow diagram.";
  abort = new AbortController();
});
afterEach(async () => {
  abort.abort();
  await rm(tmp, { recursive: true, force: true });
});

async function writeHtml(html: string, name = "page.html"): Promise<string> {
  const p = join(tmp, name);
  await writeFile(p, html, "utf8");
  return p;
}
function indexNote(): string {
  return readFileSync(join(out, "page", "page.md"), "utf8");
}

const SVG_A = `<svg width="100" height="40" viewBox="0 0 100 40"><rect width="100" height="40"/><text>StageA</text></svg>`;
const SVG_B = `<svg width="100" height="40"><circle r="8"/><text>StageB</text></svg>`;

describe("extractSvgFigures — balanced scanner (D14)", () => {
  test("nested svg-in-svg is consumed whole (one figure, no orphan close tag)", () => {
    const nested = `<svg><rect/><svg><circle/></svg></svg>`;
    const { html, figures } = extractSvgFigures(`<p>before</p>${nested}<p>after</p>`, "/tmp");
    expect(figures).toHaveLength(1);
    expect(figures[0]!.kind).toBe("inline");
    expect(html).not.toContain("</svg>");
    expect(html).toContain("![[figure-01.png]]");
  });

  test("svg inside script/style/comments is not a figure", () => {
    const html = `<script>var s = "<svg><text>x</text></svg>";</script><style>svg{fill:red}</style><!-- <svg><rect/></svg> -->`;
    const r = extractSvgFigures(html, "/tmp");
    expect(r.figures).toHaveLength(0);
    expect(r.html).toBe(html);
  });

  test("img refs: local .svg converts with alt caption; http/missing/non-svg stay", async () => {
    await writeFile(join(tmp, "chart.svg"), SVG_A, "utf8");
    const html = [
      `<img src="chart.svg" alt="The Chart">`,
      `<img src="https://example.com/x.svg">`,
      `<img src="missing.svg">`,
      `<img src="photo.png">`,
    ].join("\n");
    const r = extractSvgFigures(html, tmp);
    expect(r.figures).toHaveLength(1);
    expect(r.figures[0]).toMatchObject({ kind: "file", alt: "The Chart" });
    expect(r.html).toContain("![[figure-01.png]] — *The Chart*");
    expect(r.html).toContain("https://example.com/x.svg");
    expect(r.html).toContain('src="missing.svg"');
    expect(r.html).toContain('src="photo.png"');
  });

  test("figure bound: SVG_FIGURE_MAX extras stay untouched", () => {
    const many = Array.from({ length: SVG_FIGURE_MAX + 3 }, (_, i) => `<svg id="s${i}"><rect/></svg>`).join("");
    const r = extractSvgFigures(many, "/tmp");
    expect(r.figures).toHaveLength(SVG_FIGURE_MAX);
    expect(r.html).toContain("![[figure-08.png]]");
    expect(r.html).toContain('<svg id="s8">'); // the 9th stays a literal tag
  });
});

describe("runHtml — E2E mode matrix", () => {
  test("BYTE-IDENTITY pin: html without svg → exactly the pre-lane passthrough output", async () => {
    const html = `<html><head><title>Plain</title></head><body><h1>Hi</h1><p>words <b>bold</b></p><ul><li>a</li></ul></body></html>`;
    const p = await writeHtml(html);
    await runFile2mdPipeline({ inputs: [p], outRoot: out, mode: "auto" });
    const expected = [
      "---",
      "title: page.html",
      "kind: text",
      "format: html",
      "---",
      "",
      htmlToMarkdown(html),
      "",
    ].join("\n");
    expect(indexNote()).toBe(expected);
  });

  test("two inline figures: two pngs + anchors, no svg label leakage", async () => {
    const html = `<html><body><h1>Report</h1><p>intro</p>${SVG_A}<p>middle</p>${SVG_B}</body></html>`;
    const p = await writeHtml(html);
    await runFile2mdPipeline({ inputs: [p], outRoot: out, mode: "auto" });
    const md = indexNote();
    expect(existsSync(join(out, "page", "pages", "figure-01.png"))).toBe(true);
    expect(existsSync(join(out, "page", "pages", "figure-02.png"))).toBe(true);
    expect(md).toContain("![[figure-01.png]]");
    expect(md).toContain("![[figure-02.png]]");
    expect(md).not.toContain("StageA"); // svg innards replaced by the anchor, not leaked
    expect(visionCalls.calls).toBe(0); // auto never calls a VLM (D1)
  });

  test("img-ref figure resolves against the html's own directory", async () => {
    await writeFile(join(tmp, "chart.svg"), SVG_A, "utf8");
    const html = `<html><body><h1>Q3</h1><img src="chart.svg" alt="Revenue"></body></html>`;
    const p = await writeHtml(html);
    await runFile2mdPipeline({ inputs: [p], outRoot: out, mode: "auto" });
    const md = indexNote();
    expect(md).toContain("![[figure-01.png]] — *Revenue*");
    expect(existsSync(join(out, "page", "pages", "figure-01.png"))).toBe(true);
  });

  test("smart + server: one vision call per rendered figure, descriptions appended", async () => {
    visionState.available = true;
    const html = `<html><body>${SVG_A}${SVG_B}</body></html>`;
    const p = await writeHtml(html);
    await runFile2mdPipeline({ inputs: [p], outRoot: out, mode: "smart" });
    const md = indexNote();
    expect(visionCalls.calls).toBe(2);
    expect(md).toContain("## Figure (vision) — 01");
    expect(md).toContain("## Figure (vision) — 02");
    expect(md).toContain("A flow diagram.");
  });

  test("smart no server: skip notice, figures still embedded", async () => {
    const html = `<html><body>${SVG_A}</body></html>`;
    const p = await writeHtml(html);
    await runFile2mdPipeline({ inputs: [p], outRoot: out, mode: "smart" });
    const md = indexNote();
    expect(visionCalls.calls).toBe(0);
    expect(md).toContain(FIGURE_SKIP_NOTICE);
    expect(md).toContain("![[figure-01.png]]");
  });

  test("one raster failure degrades that figure only, doc still done", async () => {
    rasterState.failInline = true;
    const html = `<html><body>${SVG_A}${SVG_B}</body></html>`;
    const p = await writeHtml(html);
    await runFile2mdPipeline({ inputs: [p], outRoot: out, mode: "auto" });
    const md = indexNote();
    expect(md).toContain("2 of 2 svg figure(s) could not be rasterized");
    expect(md).toContain("*(svg figure 1 could not be rendered on this machine)*");
    expect(md).not.toContain("![[figure-01.png]]"); // no broken embed left behind
    expect(existsSync(join(out, "page", "page.md"))).toBe(true);
  });

  test("text mode skips the pre-pass entirely (byte-identical, no figures)", async () => {
    const html = `<html><body><h1>T</h1>${SVG_A}</body></html>`;
    const p = await writeHtml(html);
    await runFile2mdPipeline({ inputs: [p], outRoot: out, mode: "text" });
    const md = indexNote();
    const expected = [
      "---",
      "title: page.html",
      "kind: text",
      "format: html",
      "---",
      "",
      htmlToMarkdown(html),
      "",
    ].join("\n");
    expect(md).toBe(expected);
    expect(existsSync(join(out, "page", "pages", "figure-01.png"))).toBe(false);
  });
});
