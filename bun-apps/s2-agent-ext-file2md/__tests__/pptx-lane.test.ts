/**
 * pptx-lane.test.ts — rendered slide notes end-to-end (effort
 * 2026-09-08-file2md-svg-pptx-vision, ticket 05).
 *
 * The REAL pipeline + vendored reader run against a JSZip-built minimal
 * deck; the machine-bound leaves are mocked: raster/deck.ts gets a fake
 * renderer (writes tiny pngs, counts calls) + a canned readZipText for the
 * smart heuristic's raw slide-XML flags; sessions + vision-inference follow
 * the smart-mode.test.ts pattern.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";

const rendererState = { available: true, renderCalls: 0, lastOpts: null as null | { limit?: number; size?: number } };
const slideXmlParts: Record<string, string> = {};
const visionState = { available: false };
const visionCalls = { calls: 0, perPage: [] as number[], figureVariant: [] as boolean[] };
const visionReply = { ok: true as boolean, output: "", error: "" };

const TINY_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

mock.module("../src/raster/deck.ts", () => ({
  pickRenderer: () =>
    rendererState.available
      ? {
          id: "quicklook",
          available: () => true,
          renderSlides: async (_pptx: string, outDir: string, opts?: { limit?: number; size?: number }) => {
            rendererState.renderCalls++;
            rendererState.lastOpts = opts ?? null;
            const written: string[] = [];
            for (let n = 1; n <= (opts?.limit ?? 20); n++) {
              const p = join(outDir, `slide-${n}.png`);
              await writeFile(p, TINY_PNG);
              written.push(p);
            }
            return written;
          },
        }
      : null,
  readZipText: (_bytes: Uint8Array) => slideXmlParts,
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
  runVisionInference: async (opts: { task: string; systemPrompt?: string }) => {
    visionCalls.calls++;
    const pageM = /這是第 (\d+) 頁/.exec(opts.task);
    visionCalls.perPage.push(pageM ? Number(pageM[1]) : 0);
    visionCalls.figureVariant.push(opts.systemPrompt?.includes("描述") ?? false);
    if (visionReply.ok) return { output: visionReply.output, ok: true };
    return { output: "", ok: false, error: visionReply.error };
  },
}));

const { runFile2mdPipeline } = await import("../src/pipeline.ts");

/** Slide 1: a picture-bearing diagram slide (short label text). */
const SLIDE1_XML =
  `<p:sld><p:cSld><p:spTree>` +
  `<p:pic><p:cNvPr id="9" name="Pic"/><a:blip r:embed="rId5"/></p:pic>` +
  `<p:sp><p:cNvPr id="2"/><p:txBody><a:p><a:r><a:t>Architecture</a:t></a:r></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld></p:sld>`;
/** Slide 2: prose-only slide (comfortably above the 120-char threshold). */
const SLIDE2_TEXT =
  "This slide carries a long prose block of explanatory text that comfortably exceeds the diagram threshold so the smart heuristic must not fire on it.";
const SLIDE2_XML =
  `<p:sld><p:cSld><p:spTree>` +
  `<p:sp><p:cNvPr id="3"/><p:txBody><a:p><a:r><a:t>${SLIDE2_TEXT}</a:t></a:r></a:p></p:txBody></p:sp>` +
  `</p:spTree></p:cSld></p:sld>`;

async function buildDeck(
  name = "deck.pptx",
  slides: Array<{ xml: string }> = [{ xml: SLIDE1_XML }, { xml: SLIDE2_XML }],
): Promise<string> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<Types><Override PartName="/ppt/slides/slide1.xml"/></Types>`);
  zip.file(
    "ppt/presentation.xml",
    `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>`,
  );
  slides.forEach((s, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, s.xml);
    slideXmlParts[`ppt/slides/slide${i + 1}.xml`] = s.xml;
  });
  const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
  const p = join(tmp, name);
  await writeFile(p, bytes);
  return p;
}

let tmp: string;
let out: string;
let abort: AbortController;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "file2md-pptx-test-"));
  out = join(tmp, "out");
  rendererState.available = true;
  rendererState.renderCalls = 0;
  rendererState.lastOpts = null;
  for (const k of Object.keys(slideXmlParts)) delete slideXmlParts[k];
  visionState.available = false;
  visionCalls.calls = 0;
  visionCalls.perPage = [];
  visionCalls.figureVariant = [];
  visionReply.ok = true;
  visionReply.output = "";
  abort = new AbortController();
});
afterEach(async () => {
  abort.abort();
  await rm(tmp, { recursive: true, force: true });
});

function pageMd(n: number, slug = "deck"): string {
  return readFileSync(join(out, slug, "pages", `page-${String(n).padStart(3, "0")}.md`), "utf8");
}
function manifestJson(slug = "deck"): {
  pageCount: number;
  pages: Array<{ png: string | null; status: string; figure?: { detected: boolean; enhanced: boolean } }>;
} {
  return JSON.parse(readFileSync(join(out, slug, "manifest.json"), "utf8"));
}

describe("runPptx — mode matrix", () => {
  test("text mode: runOffice delegation — index note with slide bullets, no pages, no render", async () => {
    const deck = await buildDeck();
    await runFile2mdPipeline({ inputs: [deck], outRoot: out, mode: "text" });
    const note = readFileSync(join(out, "deck", "deck.md"), "utf8");
    expect(note).toContain("## Slide 1/2");
    expect(note).toContain("- [2] Architecture");
    expect(existsSync(join(out, "deck", "pages", "page-001.md"))).toBe(false);
    expect(rendererState.renderCalls).toBe(0);
    expect(manifestJson().pages[0]!.md).toBeNull();
  });

  test("auto (ocr): renders once, per-slide notes with embeds + text-run bodies, no vision", async () => {
    const deck = await buildDeck();
    await runFile2mdPipeline({ inputs: [deck], outRoot: out, mode: "auto" });
    expect(rendererState.renderCalls).toBe(1);
    expect(rendererState.lastOpts?.limit).toBe(2);
    expect(visionCalls.calls).toBe(0);
    const m = manifestJson();
    expect(m.pageCount).toBe(2);
    for (const pg of m.pages) {
      expect(pg.status).toBe("done");
      expect(pg.png).toMatch(/pages\/page-00\d\.png/);
    }
    expect(pageMd(1)).toContain("![[page-001.png]]");
    expect(pageMd(1)).toContain("- [2] Architecture");
    expect(pageMd(1)).toContain("provenance: text");
    expect(pageMd(2)).toContain("- [3] " + SLIDE2_TEXT.slice(0, 20));
  });

  test("smart + server: vision on the pic slide only, appended as Slide (vision)", async () => {
    visionState.available = true;
    visionReply.output = "An architecture diagram with boxes and arrows.";
    const deck = await buildDeck();
    await runFile2mdPipeline({ inputs: [deck], outRoot: out, mode: "smart" });
    expect(visionCalls.calls).toBe(1);
    expect(visionCalls.perPage).toEqual([1]);
    const md1 = pageMd(1);
    expect(md1).toContain("## Slide (vision)");
    expect(md1).toContain("enhanced: vision");
    expect(md1).toContain("- [2] Architecture"); // ground-truth text body kept
    expect(manifestJson().pages[0]!.figure).toEqual({ detected: true, enhanced: true });
    const md2 = pageMd(2);
    expect(md2).not.toContain("## Slide (vision)");
    expect(manifestJson().pages[1]!.figure).toBeUndefined();
  });

  test("vlm + server: describes ALL slides as validated page notes", async () => {
    visionState.available = true;
    visionReply.output = [
      "---",
      "title: deck.pptx — Page 1",
      "page: 1",
      "kind: slides",
      "---",
      "",
      "![[page-001.png]]",
      "",
      "Vision-described slide body with enough characters to pass the gate.",
    ].join("\n");
    const deck = await buildDeck();
    await runFile2mdPipeline({ inputs: [deck], outRoot: out, mode: "vlm" });
    expect(visionCalls.calls).toBe(2);
    const md1 = pageMd(1);
    expect(md1).toContain("provenance: vision");
    expect(md1).toContain("Vision-described slide body");
  });

  test("renderer null: today's text-only output + honest in-note notice", async () => {
    rendererState.available = false;
    const deck = await buildDeck();
    await runFile2mdPipeline({ inputs: [deck], outRoot: out, mode: "auto" });
    const note = readFileSync(join(out, "deck", "deck.md"), "utf8");
    expect(note).toContain("## Slide 1/2");
    expect(note).toContain("Slide renders unavailable");
    expect(existsSync(join(out, "deck", "pages", "page-001.md"))).toBe(false);
    expect(manifestJson().pages[0]!.png).toBeNull();
  });

  test("--pages 2 processes slide 2 only; slide 1 stays pending", async () => {
    const deck = await buildDeck();
    await runFile2mdPipeline({ inputs: [deck], outRoot: out, mode: "auto", pages: "2" });
    expect(existsSync(join(out, "deck", "pages", "page-002.md"))).toBe(true);
    expect(manifestJson().pages[0]!.status).toBe("pending");
    expect(manifestJson().pages[1]!.status).toBe("done");
  });

  test("--pages out of range refuses loudly", async () => {
    const deck = await buildDeck();
    await expect(runFile2mdPipeline({ inputs: [deck], outRoot: out, mode: "auto", pages: "9" })).rejects.toThrow(
      /matched no slides/,
    );
  });

  test("25-slide deck caps at the 20-slide window with a truncation notice", async () => {
    const slides = Array.from({ length: 25 }, (_, i) => ({
      xml: `<p:sld><p:cSld><p:spTree><p:sp><p:cNvPr id="${i + 2}"/><p:txBody><a:p><a:r><a:t>Slide ${i + 1} text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    }));
    const deck = await buildDeck("big.pptx", slides);
    await runFile2mdPipeline({ inputs: [deck], outRoot: out, mode: "auto" });
    expect(rendererState.lastOpts?.limit).toBe(20);
    expect(manifestJson("big").pageCount).toBe(20);
    expect(pageMd(1, "big")).toContain("Truncated: rendering first 20 of 25 slides");
  });
});
