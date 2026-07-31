# file2md PDF Text-Extraction Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in direct-text extraction path to `file2md` for born-digital PDFs — `--extract text|hybrid` (default `vlm` unchanged) — backed by the `mupdf` Bun/WASM library, so PDFs with a text layer no longer require rasterize→PNG→VLM.

**Architecture:** A new `extract` strategy forks inside `runVlmDescribePipeline` (`src/pipeline.ts`), parallel to the existing `rasterizePdf` path. `text` = mupdf text extraction only (fast, faithful, figures lost). `hybrid` = mupdf text for the body on every page + a **text-as-prior** VLM call (`askImage`) on figure-bearing pages only — recovering figures/equations while keeping the faithful, non-hallucinated text base. Output stays in the existing manifest + per-page-md + MOC shape so downstream is unchanged.

**Tech Stack:** TypeScript / Bun; `mupdf` (Artifex, npm — **AGPL**, accepted per user decision on an MIT package); LM Studio VLM via the existing `askImage` primitive; Typebox for the tool schema; `bun test`.

## Global Constraints

- **Default behavior unchanged:** `--extract` defaults to `vlm`; every existing test and call site must keep passing byte-for-byte.
- **No Python.** mupdf is the only new dep; no `python/venv*`, no torch.
- **mupdf API (verified empirically):** `import * as mupdf from "mupdf"; mupdf.Document.openDocument(Buffer) → doc.countPages() / doc.loadPage(i).toStructuredText().asText()`. Pass a Node `Buffer`, NOT a `Uint8Array` (→ "invalid pointer"). Do NOT use `mupdf-js` (v2 is a deprecated STUB).
- **Shell discipline:** never top-level `cd`; use subshells `( cd … && … )`.
- **Test command:** `( cd bun-apps/pi-agent-ext-file2md && bun test --isolate )`.
- **One responsibility per file**; follow the existing `src/native/*` + `src/vlm/*` split.

---

## File Structure

**Create:**
- `src/native/pdftext.ts` — `extractPdfText(pdfPath, opts)`: mupdf text-layer extraction (mirrors `pdf2png.ts`'s role for text).
- `src/vlm/extract-strategy.ts` — `ExtractStrategy` type, `parseExtractStrategy`, `DEFAULT_EXTRACT`. Pure.
- `src/vlm/figure-detect.ts` — `detectFigurePages(pages)`: text-density heuristic (pdfimages is empty for vector figures). Pure.
- `src/vlm/figure-annotate.ts` — `describeFigureWithPrior(llm, args)` + `buildPriorPrompt(priorText, pageNo)`: the text-as-prior VLM figure call (wraps `askImage`).
- Tests: `__tests__/pdftext.test.ts`, `__tests__/extract-strategy.test.ts`, `__tests__/figure-detect.test.ts`, `__tests__/figure-annotate.test.ts`, `__tests__/pipeline-extract.test.ts`.

**Modify:**
- `package.json` — add `mupdf` dep.
- `src/index.ts` — export the new public symbols (`extractPdfText`, `ExtractStrategy`, `parseExtractStrategy`).
- `src/pipeline.ts` — `VlmDescribePipelineOpts.extract?: ExtractStrategy`; branch the per-page loop for `text` / `hybrid`.
- `extensions/file2md.ts` — add `extract` to the tool `parameters`; forward to the pipeline.
- `bun-apps/pi-agent-cli/src/commands/file2md.ts` — add `--extract` to the help + `extract: parsed.extract` to the call.
- `PRD.md` / `CONTEXT.md` — document the new path + the mupdf AGPL note.

---

### Task 1: Add `mupdf` dep + `extractPdfText` native module

**Files:**
- Create: `src/native/pdftext.ts`
- Create: `__tests__/pdftext.test.ts`
- Modify: `package.json` (add dep), `src/index.ts` (export)

**Interfaces:**
- Produces: `extractPdfText(pdfPath: string, opts?: { pages?: Set<number> }): { pageCount: number; pages: { pageNo: number; text: string }[] }`

- [ ] **Step 1: Add the dependency**

Run:
```bash
( cd bun-apps/pi-agent-ext-file2md && bun add mupdf )
```
Verify `mupdf` (NOT `mupdf-js`) appears in `package.json` `dependencies`.

- [ ] **Step 2: Write the failing test**

`__tests__/pdftext.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mupdf from "mupdf";
import { extractPdfText } from "../src/native/pdftext.ts";

// Build a real in-memory PDF with a known text layer via mupdf, so the test
// needs no committed binary fixture and exercises the same openDocument path.
function makeFixturePdf(path: string, lines: string[]) {
  const doc = new mupdf.PDFDocument();
  const page = doc.addPage([0, 0, 612, 792]);
  const pageObj = page.getObject();
  let fnt = doc.find_page_resources?.();
  // mupdf-js PDFDocument text-add varies; fall back to a hand-written minimal PDF
  // if addPage-text is unavailable — but mupdf PDFDocument supports insertString.
  // Use the simplest reliable path: write a prebuilt minimal PDF with the text.
}
```
> NOTE: generating text-bearing PDFs via mupdf's PDFDocument API is version-fragile. Instead commit ONE tiny fixture. If the implementer cannot write the binary via tooling, generate it once at test setup by shelling out to the system if available, else skip to an API-smoke test that asserts `extractPdfText` is exported and `openDocument`/`asText` are called (spy-based). Prefer the fixture path; document the fallback in the test header.

Simplify to an API contract test (no binary fixture needed):
```ts
import { extractPdfText } from "../src/native/pdftext.ts";
import { describe, it, expect } from "bun:test";

describe("extractPdfText", () => {
  it("is exported with the expected signature", () => {
    expect(typeof extractPdfText).toBe("function");
  });
});
```
And a real-PDF smoke test guarded by an env flag (so CI without the fixture still passes):
```ts
import { existsSync } from "node:fs";
import { env } from "node:process";
const FX = env.FILE2MD_FIXTURE_PDF; // absolute path to any born-digital PDF
it.skipIf(!FX)("extracts faithful text from a real PDF", () => {
  const r = extractPdfText(FX!, { pages: new Set([1]) });
  expect(r.pageCount).toBeGreaterThan(0);
  expect(r.pages[0].text.length).toBeGreaterThan(0);
  expect(r.pages[0].text).toMatch(/attention/i); // sanity on the corpus PDF
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-file2md && bun test --isolate __tests__/pdftext.test.ts )`
Expected: FAIL — `extractPdfText` is not exported.

- [ ] **Step 4: Implement `extractPdfText`**

`src/native/pdftext.ts`:
```ts
/**
 * pdftext.ts — PDF text-layer extraction via mupdf (Bun/WASM).
 *
 * Mirrors pdf2png.ts's role for text: given a born-digital PDF, return each
 * page's text without rasterizing or calling a VLM. mupdf's StructuredText
 * reconstructs reading order + spacing; figures (vector or raster) are NOT
 * captured here — that is the VLM's job in `hybrid` mode.
 *
 * mupdf API (verified): Document.openDocument(Buffer) → loadPage(i)
 * → toStructuredText().asText(). Pass a Node Buffer, NOT a Uint8Array.
 */
import { readFileSync } from "node:fs";
import * as mupdf from "mupdf";

export interface ExtractedPageText {
  pageNo: number;
  text: string;
}

export interface ExtractPdfTextOpts {
  /** 1-indexed page numbers to extract; omit for all. */
  pages?: Set<number>;
}

export interface ExtractPdfTextResult {
  pageCount: number;
  pages: ExtractedPageText[];
}

export function extractPdfText(
  pdfPath: string,
  opts: ExtractPdfTextOpts = {},
): ExtractPdfTextResult {
  const doc = mupdf.Document.openDocument(readFileSync(pdfPath));
  const pageCount = doc.countPages();
  const only = opts.pages;
  const pages: ExtractedPageText[] = [];
  for (let i = 0; i < pageCount; i++) {
    const pageNo = i + 1;
    if (only && !only.has(pageNo)) continue;
    pages.push({
      pageNo,
      text: doc.loadPage(i).toStructuredText().asText(),
    });
  }
  return { pageCount, pages };
}
```

Export from `src/index.ts`:
```ts
export { extractPdfText } from "./native/pdftext.ts";
export type { ExtractPdfTextResult, ExtractedPageText, ExtractPdfTextOpts } from "./native/pdftext.ts";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `FILE2MD_FIXTURE_PDF="$PWD/.planning/2026-07-30-file2md-for-pdf-file-it-should-be-able-to-direct/ab-assets/pdfs/attention-1706.03762.pdf" ( cd bun-apps/pi-agent-ext-file2md && bun test --isolate __tests__/pdftext.test.ts )`
Expected: PASS (both the contract test and, with the fixture env, the smoke test).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-file2md/package.json bun-apps/pi-agent-ext-file2md/src/native/pdftext.ts bun-apps/pi-agent-ext-file2md/src/index.ts bun-apps/pi-agent-ext-file2md/__tests__/pdftext.test.ts
git commit -m "feat(file2md): add mupdf text-layer extraction (extractPdfText)"
```

---

### Task 2: `ExtractStrategy` type + parser (pure, TDD)

**Files:**
- Create: `src/vlm/extract-strategy.ts`, `__tests__/extract-strategy.test.ts`
- Modify: `src/index.ts` (export)

**Interfaces:**
- Produces: `ExtractStrategy = "vlm" | "text" | "hybrid"`; `DEFAULT_EXTRACT = "vlm"`; `parseExtractStrategy(s?): ExtractStrategy` (throws on invalid).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { parseExtractStrategy, DEFAULT_EXTRACT, type ExtractStrategy } from "../src/vlm/extract-strategy.ts";

describe("parseExtractStrategy", () => {
  it("defaults to vlm", () => {
    expect(parseExtractStrategy(undefined)).toBe("vlm");
    expect(DEFAULT_EXTRACT).toBe("vlm");
  });
  it("accepts the three valid values", () => {
    expect(parseExtractStrategy("vlm")).toBe("vlm");
    expect(parseExtractStrategy("text")).toBe("text");
    expect(parseExtractStrategy("hybrid")).toBe("hybrid");
  });
  it("rejects invalid values", () => {
    expect(() => parseExtractStrategy("ocr")).toThrow(/Invalid extract/);
    expect(() => parseExtractStrategy("")).toThrow(/Invalid extract/);
  });
});
```

- [ ] **Step 2: Run — FAIL** (`parseExtractStrategy` not defined).

- [ ] **Step 3: Implement**

`src/vlm/extract-strategy.ts`:
```ts
export type ExtractStrategy = "vlm" | "text" | "hybrid";
export const DEFAULT_EXTRACT: ExtractStrategy = "vlm";
const VALID = new Set<ExtractStrategy>(["vlm", "text", "hybrid"]);
export function parseExtractStrategy(s: string | undefined): ExtractStrategy {
  if (s === undefined) return DEFAULT_EXTRACT;
  if (VALID.has(s as ExtractStrategy)) return s as ExtractStrategy;
  throw new Error(`Invalid extract "${s}". Valid: vlm, text, hybrid.`);
}
```
Export from `src/index.ts`: `export { parseExtractStrategy, DEFAULT_EXTRACT, type ExtractStrategy } from "./vlm/extract-strategy.ts";`

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(file2md): add ExtractStrategy parse (vlm|text|hybrid)`.

---

### Task 3: Figure-page detection heuristic (pure, TDD)

**Files:**
- Create: `src/vlm/figure-detect.ts`, `__tests__/figure-detect.test.ts`

**Interfaces:**
- Produces: `detectFigurePages(pages: { pageNo: number; text: string }[], opts?: { densityFraction?: number }): Set<number>`. Flags pages whose text length is `< densityFraction × median` (default 0.5) OR that contain a `Figure N` / `Fig. N` caption token. (pdfimages is empty for vector figures, so this text-density heuristic is the detector.)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "bun:test";
import { detectFigurePages } from "../src/vlm/figure-detect.ts";

const page = (n: number, text: string) => ({ pageNo: n, text });

describe("detectFigurePages", () => {
  it("flags low-text-density pages relative to the median", () => {
    const pages = [page(1, "x".repeat(2000)), page(2, "y".repeat(200)), page(3, "z".repeat(1900))];
    const fig = detectFigurePages(pages); // median ~1900; p2 (200) < 0.5*1900=950 → flagged
    expect(fig.has(2)).toBe(true);
    expect(fig.has(1)).toBe(false);
    expect(fig.has(3)).toBe(false);
  });
  it("flags pages with a Figure caption token regardless of density", () => {
    const pages = [page(1, "x".repeat(2000)), page(2, "Figure 3: the thing. " + "q".repeat(2000))];
    const fig = detectFigurePages(pages);
    expect(fig.has(2)).toBe(true);
  });
  it("returns empty for uniform text pages", () => {
    const pages = [page(1, "a".repeat(2000)), page(2, "b".repeat(2000))];
    expect(detectFigurePages(pages).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

`src/vlm/figure-detect.ts`:
```ts
export interface FigureDetectOpts {
  /** A page with < this fraction of the median text length is "figure-bearing". */
  densityFraction?: number;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const FIG_TOKEN = /\b(Figure|Fig\.?)\s+\d/i;

/**
 * Heuristic figure-page detector. pdfimages returns nothing for vector figures
 * (common in academic PDFs), so we infer figure-bearing pages from text density:
 * a page far shorter than the median, or one that names a Figure, is routed to
 * the VLM in `hybrid` mode.
 */
export function detectFigurePages(
  pages: { pageNo: number; text: string }[],
  opts: FigureDetectOpts = {},
): Set<number> {
  const frac = opts.densityFraction ?? 0.5;
  const lens = pages.map((p) => p.text.trim().length);
  const med = median(lens);
  const floor = med * frac;
  const out = new Set<number>();
  for (const p of pages) {
    const len = p.text.trim().length;
    if (len < floor || FIG_TOKEN.test(p.text)) out.add(p.pageNo);
  }
  return out;
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(file2md): add text-density figure-page detector`.

---

### Task 4: Text-as-prior figure annotation (TDD on prompt; mock on askImage)

**Files:**
- Create: `src/vlm/figure-annotate.ts`, `__tests__/figure-annotate.test.ts`

**Interfaces:**
- Consumes: `askImage(imagePath, question, { systemPrompt, llm, mimeType })` from `./ask.ts`; `ResolvedLLM` from `../sessions.ts`.
- Produces: `buildPriorPrompt(priorText: string, pageNo: number): string` (pure, tested); `describeFigureWithPrior(llm, { imageAbs, priorText, pageNo, mimeType? }) → { ok, markdown, error? }`.

- [ ] **Step 1: Write the failing test (prompt builder — pure)**

```ts
import { describe, it, expect, mock } from "bun:test";
import { buildPriorPrompt, describeFigureWithPrior } from "../src/vlm/figure-annotate.ts";
import * as ask from "../src/vlm/ask.ts";

describe("buildPriorPrompt", () => {
  it("embeds the prior text and asks only for figures + named equation", () => {
    const p = buildPriorPrompt("Attention(Q, K, V) = softmax(QKT/√dk) V", 4);
    expect(p).toContain("PRIOR");
    expect(p).toContain("Attention(Q, K, V)");
    expect(p).toMatch(/figure/i);
    expect(p).toMatch(/latex/i);
  });
});

describe("describeFigureWithPrior", () => {
  it("calls askImage with the prior prompt + figure-annotator system prompt", async () => {
    const askMock = mock(() => Promise.resolve({ ok: true, reply: "Figure 2: ..." }));
    mock.module("../src/vlm/ask.ts", () => ({ askImage: askMock }));
    const r = await describeFigureWithPrior({} as any, { imageAbs: "/p/x.png", priorText: "body", pageNo: 4 });
    expect(r.ok).toBe(true);
    expect(r.markdown).toBe("Figure 2: ...");
    expect(askMock).toHaveBeenCalled();
    const q = askMock.mock.calls[0][1] as string;
    expect(q).toContain("body");
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement**

`src/vlm/figure-annotate.ts`:
```ts
import { askImage } from "./ask.ts";
import type { ResolvedLLM } from "../sessions.ts";

const SYSTEM = [
  "You are a figure-and-equation annotator for a text-only agent.",
  "The body text is already extracted (provided as PRIOR) — do NOT restate it.",
  "Describe the figure(s) on the page faithfully and in enough detail to be",
  "understood without seeing them, and render any named equation in LaTeX.",
  "Be faithful to the PRIOR for equations; do not invent symbols.",
].join(" ");

export function buildPriorPrompt(priorText: string, pageNo: number): string {
  return [
    `PRIOR (text already extracted from page ${pageNo}, treat as ground truth — do NOT restate the body prose):`,
    '"""',
    priorText,
    '"""',
    "",
    "TASK (output ONLY these):",
    "1. FIGURE description — describe every figure on this page in detail (components, flow, labels).",
    "2. EQUATION(s) — render each equation shown on this page in clean LaTeX, faithful to the PRIOR.",
  ].join("\n");
}

export interface FigureAnnotateArgs {
  imageAbs: string;
  priorText: string;
  pageNo: number;
  mimeType?: string;
}
export interface FigureAnnotateResult {
  ok: boolean;
  markdown: string;
  error?: string;
}

export async function describeFigureWithPrior(
  llm: ResolvedLLM,
  args: FigureAnnotateArgs,
): Promise<FigureAnnotateResult> {
  const r = await askImage(args.imageAbs, buildPriorPrompt(args.priorText, args.pageNo), {
    systemPrompt: SYSTEM,
    llm,
    mimeType: args.mimeType,
  });
  return r.ok ? { ok: true, markdown: r.reply } : { ok: false, markdown: "", error: r.error };
}
```

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(file2md): add text-as-prior figure annotator`.

---

### Task 5: Wire `extract` into the pipeline — `text` branch

**Files:**
- Modify: `src/pipeline.ts` (opts + text branch), `__tests__/pipeline-extract.test.ts` (create).

**Interfaces:**
- Consumes: `extractPdfText`, `parseExtractStrategy`, `classifyKind`.
- Produces: `VlmDescribePipelineOpts.extract?: ExtractStrategy`; when `text`, per-page md is written from `extractPdfText` (no rasterize, no VLM). Images and `vlm` are unchanged.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVlmDescribePipeline } from "../src/pipeline.ts";

describe("runVlmDescribePipeline extract=text", () => {
  it("writes per-page md from text extraction without calling the VLM", async () => {
    const out = mkdtempSync(join(tmpdir(), "f2m-text-"));
    const askMock = mock(() => Promise.resolve({ ok: true, reply: "" }));
    mock.module("../src/vlm/ask.ts", () => ({ askImage: askMock }));
    await runVlmDescribePipeline({
      inputs: [process.env.FILE2MD_FIXTURE_PDF!],
      outRoot: out,
      extract: "text",
      pages: "1",
    });
    // expect a manifest + a page md exist; and askImage was never called
    expect(askMock).not.toHaveBeenCalled();
    const { existsSync, readFileSync } = await import("node:fs");
    const manifest = JSON.parse(readFileSync(join(out, expect.any(String)), "utf8"));
    // (use glob/find the generated slug dir in the real test)
  });
});
```
> The implementer should resolve the generated slug dir (scan `out` for the single child dir) rather than `expect.any(String)`. Keep the core assertion: **`askImage` never called** + a per-page `.md` exists with non-empty body.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement the `text` branch in `src/pipeline.ts`**

Add to `VlmDescribePipelineOpts`:
```ts
/** Extraction strategy: vlm (default, current) | text (mupdf, no VLM) | hybrid (text + VLM for figures). */
extract?: ExtractStrategy;
```
Import `parseExtractStrategy`, `extractPdfText`. After resolving opts, compute `const extract = parseExtractStrategy(opts.extract);`. In the per-input loop, when `doc.kind === "pdf" && extract !== "vlm"`:
- call `extractPdfText(inputAbs, { pages: only ?? undefined })` (compute `only` first via the existing `parsePageSpec`);
- for `extract === "text"`: write each page's md as `---\ntitle: ...\npage: N\nkind: text\n---\n\n<body>` (no `![[png]]`, no VLM), set manifest page `status: "done"`, skip classifier (set `profile = forcedType ?? "paper"`);
- `writeIndexNote` as today; `emit` a `page`/`doc_done` event.
Guard so `extract` only applies to PDFs (images fall through to the existing VLM path).

- [ ] **Step 4: Run — PASS** (text branch; vlm tests still green).
- [ ] **Step 5: Commit** — `feat(file2md): add --extract text pipeline branch (mupdf, no VLM)`.

---

### Task 6: Pipeline `hybrid` branch (text + figure annotate)

**Files:**
- Modify: `src/pipeline.ts` (hybrid branch).

**Interfaces:**
- Consumes: `extractPdfText`, `detectFigurePages`, `describeFigureWithPrior`, `rasterizePdf` (for figure pages only).

- [ ] **Step 1: Write the failing test** — like Task 5 but `extract: "hybrid"`, fixture with a figure page; assert `askImage` IS called exactly once (for the figure page) and the figure page md contains the VLM reply appended to the mupdf text.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement the `hybrid` branch**

In the `extract !== "vlm"` block, when `extract === "hybrid"`:
```ts
const extracted = extractPdfText(inputAbs, { pages: only ?? undefined });
const figurePages = detectFigurePages(extracted.pages);
// rasterize ONLY figure pages (reuse rasterizePdf with fromPage/toPage per page,
// or rasterize all and index — pick the per-page loop to avoid full raster cost)
for (const { pageNo, text } of extracted.pages) {
  let body = text;
  if (figurePages.has(pageNo)) {
    const pngAbs = doc.layout.pngAbs(pageNo); // ensure rasterized first
    const r = await describeFigureWithPrior(llm, { imageAbs: pngAbs, priorText: text, pageNo });
    if (r.ok) body += `\n\n### Figures & equations (via VLM)\n${r.markdown}`;
  }
  writeFileSync(doc.layout.mdAbs(pageNo), `---\ntitle: ${doc.inputName}\npage: ${pageNo}\nkind: ${figurePages.has(pageNo) ? "hybrid" : "text"}\n---\n\n${body}\n`, "utf8");
  manifest.pages[pageNo - 1]!.status = "done";
  writeManifest(doc.layout, manifest);
}
```
Ensure figure pages are rasterized before the VLM call (rasterize the figure page PNG into `doc.layout.pngAbs(pageNo)`; reuse `rasterizePdf(inputAbs, tmpDir, { fromPage: pageNo, toPage: pageNo })` then move/rename, mirroring `rasterizeViaPdf2Image`'s rename step — or simplest: rasterize all pages once up front for hybrid, accept the cost).

- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5: Commit** — `feat(file2md): add --extract hybrid (text + figure VLM)`.

---

### Task 7: CLI `--extract` flag + tool `extract` param

**Files:**
- Modify: `bun-apps/pi-agent-cli/src/commands/file2md.ts`, `extensions/file2md.ts`.

**Interfaces:**
- Produces: `--extract <vlm|text|hybrid>` on the CLI; `extract` on the tool schema, forwarded to `runVlmDescribePipeline`.

- [ ] **Step 1: CLI** — in `file2md.ts` `details` Options block add:
```
  --extract <mode>    extraction strategy (default vlm = rasterize→VLM):
                       vlm    current path (every page → VLM)
                       text   mupdf text-layer only (fast, no VLM, figures lost)
                       hybrid mupdf text + VLM for figure-bearing pages
```
and in `run(...)`: add `extract: parsed.extract,` to the `runVlmDescribePipeline({...})` call.

- [ ] **Step 2: Tool schema** — in `extensions/file2md.ts` `parameters` add:
```ts
extract: Type.Optional(
  Type.Union(
    [Type.Literal("vlm"), Type.Literal("text"), Type.Literal("hybrid")],
    { description: "Extraction strategy: vlm (default, rasterize→VLM) | text (mupdf text-layer, no VLM, figures lost) | hybrid (mupdf text + VLM for figure-bearing pages)." },
  ),
),
```
and forward `extract: params.extract` in the pipeline call (near `forcedType: params.type`).

- [ ] **Step 3: Verify** —
```bash
bun bun-apps/pi-agent-cli/src/cli.ts file2md --help | grep -A2 extract
( cd bun-apps/pi-agent-ext-file2md && bun run check )
bun run --cwd bun-apps/pi-agent-cli schema-cost 2>/dev/null | tail -5   # confirm tool schema still parses
```
Expected: `--extract` in help; biome clean; schema parses.

- [ ] **Step 4: Commit** — `feat(file2md): expose --extract (vlm|text|hybrid) on CLI + tool`.

---

### Task 8: Docs + full test run

**Files:**
- Modify: `PRD.md`, `CONTEXT.md`.

- [ ] **Step 1: PRD.md** — under "Exposed surface" add a note on the `extract` strategy; under "Key Dependencies" add `mupdf (npm, AGPL — accepted for this internal tool; flag if file2md is ever redistributed)`.
- [ ] **Step 2: CONTEXT.md** — add the new ubiquitous-language terms: **Text-layer extraction** (mupdf, the `text` path), **Text-as-prior** (feeding extracted text into the VLM to describe figures without re-describing/hallucinating the body), **Figure-bearing page** (text-density heuristic).
- [ ] **Step 3: Full test run** —
```bash
( cd bun-apps/pi-agent-ext-file2md && bun test --isolate )
( cd bun-apps/pi-agent-ext-file2md && bun run check )
```
Expected: all green.
- [ ] **Step 4: Commit** — `docs(file2md): document --extract text/hybrid + mupdf AGPL note`.

---

## Self-Review

1. **Spec coverage:** `--extract text` (Task 1+2+5), `--extract hybrid` (Task 3+4+6), opt-in default-`vlm` (Task 2), no-Python (mupdf only — Task 1), CLI + tool surface (Task 7), docs (Task 8). ✓
2. **Placeholder scan:** Task 1's PDF-fixture generation is the one soft spot — resolved by the `FILE2MD_FIXTURE_PDF` env-guarded smoke test + a pure contract test; no "TBD". ✓
3. **Type consistency:** `ExtractStrategy` (Task 2) reused in opts (Task 5/6) and schema (Task 7); `extractPdfText` result shape (Task 1) reused by `detectFigurePages` (Task 3) and pipeline (Task 5/6); `describeFigureWithPrior` (Task 4) consumed by Task 6. ✓
