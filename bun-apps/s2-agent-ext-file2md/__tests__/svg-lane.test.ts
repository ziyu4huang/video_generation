/**
 * svg-lane.test.ts — standalone .svg end-to-end (effort
 * 2026-09-08-file2md-svg-pptx-vision, ticket 02).
 *
 * Same discipline as smart-mode.test.ts: the REAL pipeline runs; the
 * machine-bound leaves (raster/svg.ts WebView, ocr wasm) and the vision
 * leaves (sessions.ts, vision-inference.ts) are mocked so every mode matrix
 * cell is deterministic regardless of the host.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIGURE_SKIP_NOTICE } from "../src/core/figure.ts";

const raster = { file: 0, ok: true };
const visionState = { available: false };
const visionCalls = { calls: 0, lastTask: "", lastSystemPrompt: "" };
const visionReply = { ok: true as boolean, output: "", error: "" };

const TINY_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

mock.module("../src/raster/svg.ts", () => ({
  renderSvgFileToPng: async () => {
    raster.file++;
    return raster.ok ? { png: TINY_PNG, width: 64, height: 48 } : null;
  },
  renderSvgTextToPng: async () => {
    return raster.ok ? { png: TINY_PNG, width: 64, height: 48 } : null;
  },
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
    visionCalls.lastTask = opts.task;
    visionCalls.lastSystemPrompt = opts.systemPrompt ?? "";
    if (visionReply.ok) return { output: visionReply.output, ok: true };
    return { output: "", ok: false, error: visionReply.error };
  },
}));

const { runFile2mdPipeline } = await import("../src/pipeline.ts");
const { detectKind } = await import("../src/core/sniff.ts");
const { svgToMarkdown } = await import("../src/core/svg-text.ts");

const SAMPLE_SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
  <title>Pipeline Diagram</title>
  <desc>Three-stage pipeline</desc>
  <rect x="20" y="20" width="100" height="40"/>
  <text x="40" y="40">Ingest</text>
  <text x="140" y="40">Convert</text>
  <circle cx="300" cy="40" r="10"/>
</svg>`;

let tmp: string;
let out: string;
let abort: AbortController;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "file2md-svg-test-"));
  out = join(tmp, "out");
  raster.file = 0;
  raster.ok = true;
  visionState.available = false;
  visionCalls.calls = 0;
  visionCalls.lastTask = "";
  visionCalls.lastSystemPrompt = "";
  visionReply.ok = true;
  visionReply.output = "A three-stage flow diagram.";
  visionReply.error = "";
  abort = new AbortController();
});
afterEach(async () => {
  abort.abort();
  await rm(tmp, { recursive: true, force: true });
});

async function writeSvg(name = "diagram.svg", content = SAMPLE_SVG): Promise<string> {
  const p = join(tmp, name);
  await writeFile(p, content, "utf8");
  return p;
}

function pageMd(): string {
  return readFileSync(join(out, "diagram", "pages", "page-001.md"), "utf8");
}
function manifestJson(): {
  pages: Array<{ png: string | null; status: string; figure?: { detected: boolean; enhanced: boolean } }>;
} {
  return JSON.parse(readFileSync(join(out, "diagram", "manifest.json"), "utf8"));
}

describe("sniff — svg kind (D13 precedence)", () => {
  test(".svg extension and bare svg content claim kind svg", async () => {
    expect((await detectKind(new TextEncoder().encode(SAMPLE_SVG), "diagram.svg")).kind).toBe("svg");
    expect((await detectKind(new TextEncoder().encode(SAMPLE_SVG), "noext")).kind).toBe("svg");
  });

  test("html markers win over an early inline <svg> (routes to the html lane)", async () => {
    const html = `<!doctype html><html><body><svg width="10" height="10"><rect/></svg></body></html>`;
    const sniffed = await detectKind(new TextEncoder().encode(html), "page.html");
    expect(sniffed.kind).toBe("text");
    expect(sniffed.textKind).toBe("html");
  });
});

describe("svgToMarkdown — structural extraction", () => {
  test("title, desc, labels, census, and the loss notice", () => {
    const md = svgToMarkdown("diagram.svg", SAMPLE_SVG);
    expect(md).toContain("# Pipeline Diagram");
    expect(md).toContain("- Ingest");
    expect(md).toContain("- Convert");
    expect(md).toContain("| rect | 1 |");
    expect(md).toContain("geometry, styling, and layout are lost");
  });
});

describe("runSvg — mode matrix", () => {
  test("text mode: structural only, no raster, no png, provenance text", async () => {
    const svg = await writeSvg();
    await runFile2mdPipeline({ inputs: [svg], outRoot: out, mode: "text" });
    const md = pageMd();
    expect(md).toContain("## Labels");
    expect(md).not.toContain("![[page-001.png]]");
    expect(existsSync(join(out, "diagram", "pages", "page-001.png"))).toBe(false);
    expect(raster.file).toBe(0);
    expect(manifestJson().pages[0]!.png).toBeNull();
    expect(md).toContain("provenance: text");
  });

  test("auto (ocr): raster once, embed stored, no vision call", async () => {
    const svg = await writeSvg();
    await runFile2mdPipeline({ inputs: [svg], outRoot: out, mode: "auto" });
    const md = pageMd();
    expect(raster.file).toBe(1);
    expect(visionCalls.calls).toBe(0);
    expect(md).toContain("![[page-001.png]]");
    expect(existsSync(join(out, "diagram", "pages", "page-001.png"))).toBe(true);
    expect(md).toContain("## Labels"); // structural ground truth stays the body (D19)
  });

  test("smart + server: Figure (vision) appended, enhanced flag, manifest figure record", async () => {
    visionState.available = true;
    const svg = await writeSvg();
    await runFile2mdPipeline({ inputs: [svg], outRoot: out, mode: "smart" });
    const md = pageMd();
    expect(visionCalls.calls).toBe(1);
    expect(visionCalls.lastSystemPrompt).not.toContain("title：本頁標題"); // figure variant: no page-note envelope
    expect(md).toContain("## Figure (vision)");
    expect(md).toContain("A three-stage flow diagram.");
    expect(md).toContain("enhanced: vision");
    expect(manifestJson().pages[0]!.figure).toEqual({ detected: true, enhanced: true });
  });

  test("smart no server: skip notice, enhanced false, page still done, embed kept", async () => {
    const svg = await writeSvg();
    await runFile2mdPipeline({ inputs: [svg], outRoot: out, mode: "smart" });
    const md = pageMd();
    expect(visionCalls.calls).toBe(0);
    expect(md).toContain(FIGURE_SKIP_NOTICE);
    expect(md).toContain("![[page-001.png]]");
    expect(manifestJson().pages[0]!.figure).toEqual({ detected: true, enhanced: false });
    expect(manifestJson().pages[0]!.status).toBe("done");
  });

  test("raster unavailable: notice, no png, structural body, doc done", async () => {
    raster.ok = false;
    const svg = await writeSvg();
    await runFile2mdPipeline({ inputs: [svg], outRoot: out, mode: "auto" });
    const md = pageMd();
    expect(md).toContain("rasterization unavailable");
    expect(md).not.toContain("![[page-001.png]]");
    expect(md).toContain("## Labels");
  });
});
