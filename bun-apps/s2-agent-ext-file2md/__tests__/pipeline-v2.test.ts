/**
 * pipeline-v2.test.ts — runFile2mdPipeline end-to-end (v2, bun-only paths).
 *
 * The ONLY stubbed boundary is the wasm/worker pair (raster/pdf.ts +
 * ocr/ocr.ts) — everything else runs REAL: pdfjs text extraction (pdf-lib
 * fixtures), dsh-cowork-core office reads, the manifest, the filesystem.
 * The real pdfium raster is covered by raster.test.ts; real tesseract OCR by
 * the scan smoke (spike + manual).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const calls = { raster: 0, ocr: 0 };

mock.module("../src/raster/pdf.ts", () => ({
  rasterPage: async () => {
    calls.raster++;
    return { bmp: new Uint8Array(8 * 8 * 4), bgra: new Uint8Array(8 * 8 * 4), width: 8, height: 8 };
  },
}));

// The vlm path's profile classifier calls the vision leaf with a REAL
// LM Studio roundtrip (measured 2026-08-24: a single qwen 27B pass on this
// fixture page scales with the machine's queue — a 5s-capped suite test must
// never depend on it). Mock the seam identically to smart-mode.test.ts so the
// mode gates stay offline-deterministic.
mock.module("../src/sessions.ts", () => ({
  resolveVisionLLM: () => ({ provider: "lm-studio", modelId: "mock-vlm", thinkingLevel: "off" as const }),
}));
mock.module("../src/vlm/vision-inference.ts", () => ({
  runVisionInference: async () => ({ output: "paper", ok: true }),
}));

mock.module("../src/ocr/ocr.ts", () => ({
  OcrSession: class {
    constructor(public lang = "eng") {}
    async recognize(): Promise<{ text: string; width: number; height: number; format: string }> {
      calls.ocr++;
      return { text: "OCR TEXT 42", width: 8, height: 8, format: "ocr" };
    }
    async terminate(): Promise<void> {}
  },
  ocrImageFile: async () => {
    calls.ocr++;
    return { text: "IMG OCR", width: 8, height: 8, format: "ocr" };
  },
  normalizeOcrLang: (l?: string) => {
    const m = (l ?? "en").toLowerCase();
    return m === "chi_sim" || m === "zh" ? "chi_sim" : "eng";
  },
  imageDims: () => ({ width: 8, height: 8 }),
}));

const { runFile2mdPipeline } = await import("../src/pipeline.ts");
const { textPdf, scannedPdf, workbookXlsx, notebookIpynb } = await import("./helpers/docs.ts");

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "file2md-test-"));
  calls.raster = 0;
  calls.ocr = 0;
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function writeFixture(name: string, bytes: Uint8Array): Promise<string> {
  const p = join(tmp, name);
  await writeFile(p, bytes);
  return p;
}

describe("pdf (text layer)", () => {
  test("mode text extracts the text layer with zero raster/OCR calls", async () => {
    const pdf = await writeFixture("paper.pdf", await textPdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp });
    expect(calls.raster).toBe(0);
    expect(calls.ocr).toBe(0);
    const pageMd = join(tmp, "paper", "pages", "page-001.md");
    expect(existsSync(pageMd)).toBe(true);
    const md = readFileSync(pageMd, "utf8");
    expect(md).toContain("Hello from file2md v2");
    expect(md).toContain("provenance: text");
    expect(readFileSync(join(tmp, "paper", "manifest.json"), "utf8")).toContain('"status": "done"');
    expect(existsSync(join(tmp, "paper", "paper.md"))).toBe(true);
  });

  test("resume: re-running skips an already-done page (status preserved)", async () => {
    const pdf = await writeFixture("paper.pdf", await textPdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp });
    const before = readFileSync(join(tmp, "paper", "pages", "page-001.md"), "utf8");
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp });
    expect(readFileSync(join(tmp, "paper", "pages", "page-001.md"), "utf8")).toBe(before);
  });

  test("out-of-range page spec fails loudly", async () => {
    const pdf = await writeFixture("paper.pdf", await textPdf());
    await expect(runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, pages: "99" })).rejects.toThrow(/matched no pages/);
  });
});

describe("pdf (scan-shaped, OCR path)", () => {
  test("mode ocr rasters thin pages and writes the OCR text with provenance", async () => {
    const pdf = await writeFixture("scan.pdf", await scannedPdf());
    await runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "ocr" });
    expect(calls.raster).toBeGreaterThan(0);
    expect(calls.ocr).toBeGreaterThan(0);
    const md = readFileSync(join(tmp, "scan", "pages", "page-001.md"), "utf8");
    expect(md).toContain("OCR TEXT 42");
    expect(md).toContain("provenance: ocr");
    // OCR pages keep no page PNG (only the vision path stores one).
    expect(existsSync(join(tmp, "scan", "pages", "page-001.png"))).toBe(false);
  });
});

describe("image input", () => {
  test("mode text refuses images (no text layer)", async () => {
    const { tinyPng } = await import("./helpers/docs.ts");
    const png = await writeFixture("pic.png", tinyPng());
    await expect(runFile2mdPipeline({ inputs: [png], outRoot: tmp, mode: "text" })).rejects.toThrow(/no text layer/);
  });

  test("mode ocr: OCR text + source copied as page-001.png", async () => {
    const { tinyPng } = await import("./helpers/docs.ts");
    const png = await writeFixture("pic.png", tinyPng());
    await runFile2mdPipeline({ inputs: [png], outRoot: tmp });
    const md = readFileSync(join(tmp, "pic", "pages", "page-001.md"), "utf8");
    expect(md).toContain("IMG OCR");
    expect(existsSync(join(tmp, "pic", "pages", "page-001.png"))).toBe(true);
  });
});

describe("office formats", () => {
  test("xlsx → markdown table with cell references + manifest", async () => {
    const xlsx = await writeFixture("wb.xlsx", await workbookXlsx());
    await runFile2mdPipeline({ inputs: [xlsx], outRoot: tmp });
    const md = readFileSync(join(tmp, "wb", "wb.md"), "utf8");
    expect(md).toContain("# XLSX · wb.xlsx");
    expect(md).toContain("| A2 |");
    expect(existsSync(join(tmp, "wb", "manifest.json"))).toBe(true);
  });

  test("ipynb → fenced cells", async () => {
    const nb = await writeFixture("nb.ipynb", notebookIpynb());
    await runFile2mdPipeline({ inputs: [nb], outRoot: tmp });
    const md = readFileSync(join(tmp, "nb", "nb.md"), "utf8");
    expect(md).toContain("print(42)");
  });
});

describe("text passthrough + mode gates", () => {
  test("csv → markdown table", async () => {
    const csv = await writeFixture("t.csv", new TextEncoder().encode("a,b\n1,2\n"));
    await runFile2mdPipeline({ inputs: [csv], outRoot: tmp });
    const md = readFileSync(join(tmp, "t", "t.md"), "utf8");
    expect(md).toContain("| a | b |");
  });

  test("mode vlm on born-digital pages completes without OCR (text pages skip the vision path)", async () => {
    const pdf = await writeFixture("paper.pdf", await textPdf());
    await expect(runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "vlm" })).resolves.toBeUndefined();
    // The profile classifier rasters page 1 exactly once; no OCR ever runs.
    expect(calls.raster).toBe(1);
    expect(calls.ocr).toBe(0);
    const md = readFileSync(join(tmp, "paper", "pages", "page-001.md"), "utf8");
    expect(md).toContain("Hello from file2md v2");
  });

  test("invalid mode rejects", async () => {
    const pdf = await writeFixture("paper.pdf", await textPdf());
    await expect(runFile2mdPipeline({ inputs: [pdf], outRoot: tmp, mode: "bogus" as never })).rejects.toThrow(
      /Invalid mode/,
    );
  });
});
