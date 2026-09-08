/**
 * Core file2md v2 pipeline: sniff → extract → (OCR / vision on demand) →
 * markdown → manifest.
 *
 * v2 is bun-only and text-first:
 *   - PDF text layer: pdfjs-dist (pure TS) — no mupdf.
 *   - Scanned PDF pages / images: vendored tesseract-wasm OCR — no Swift CLI.
 *   - PDF page images: vendored pdfium wasm — no PDFKit/ghostscript.
 *   - vision (LM Studio via the tier config) is an OPTIONAL layer (`mode: vlm`),
 *     never a hard prerequisite.
 *   - docx/xlsx/pptx/ipynb: vendored dsh-cowork-core bounded windows.
 *
 * Shared by the CLI (s2-agent cli file2md) and the pi extension (file2md tool),
 * unchanged in spirit from v1: per-page md under output/<slug>/pages/ +
 * manifest.json (resumability) + <slug>.md index note.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readDocument } from "../vendored/dsh-cowork-core@0.1.0/src/read/index.ts";
import { renderMarkdown } from "../vendored/dsh-cowork-core@0.1.0/src/render/markdown.ts";
import { FIGURE_SKIP_NOTICE, type FigureRecord, isScanFigure, isTextFigure } from "./core/figure.ts";
import { openPdf, type PdfHandle } from "./core/pdf-text.ts";
import { detectKind } from "./core/sniff.ts";
import { svgToMarkdown } from "./core/svg-text.ts";
import {
  DEFAULT_CAPS,
  type File2mdCaps,
  type File2mdMode,
  type File2mdPipelineOptions,
  type PageNoteStyle,
  type SniffedFile,
} from "./core/types.ts";
import { askImageDescribe } from "./image/extract-image.ts";
import { OcrSession, ocrImageFile } from "./ocr/ocr.ts";
import { pickRenderer, readZipText } from "./raster/deck.ts";
import { rasterPage } from "./raster/pdf.ts";
import { bgraToPng } from "./raster/png.ts";
import { renderSvgFileToPng, renderSvgTextToPng } from "./raster/svg.ts";
import { type ResolvedLLM, resolveVisionLLM } from "./sessions.ts";
import { type ExplainMode, explainPage } from "./vlm/agents.ts";
import { ALL_PROFILES, type DocProfile } from "./vlm/classify.ts";
import { classifyProfileFromPages } from "./vlm/classify-vlm.ts";
import {
  createManifest,
  type DocLayout,
  ensureLayout,
  layoutFor,
  loadManifest,
  type Manifest,
  type PageStatus,
  pageLabel,
  slugify,
  writeManifest,
} from "./vlm/manifest.ts";
import { withRetry } from "./vlm/retry.ts";
import { validatePageMarkdown } from "./vlm/validate.ts";

/** Below this many chars a page has no usable text layer → OCR/vision. */
export const OCR_TEXT_MIN_CHARS = 8;

/** Run `fn` over `items` with at most `limit` concurrent invocations (T2). */
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  if (limit < 1) limit = 1;
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

/** Parse a "1,3-5" page spec into a sorted set of 1-indexed page numbers. */
export function parsePageSpec(spec: string, total: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(t);
    if (m) {
      const a = Math.max(1, +m[1]!);
      const b = Math.min(total, +m[2]!);
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      const n = +t;
      if (Number.isFinite(n) && n >= 1 && n <= total) out.add(n);
    }
  }
  return out;
}

/** v2 mode validation, with v1's same throw semantics. `auto` converges on `ocr`. */
export function parseMode(mode: string | undefined): File2mdMode {
  const m = (mode ?? "auto") as File2mdMode;
  if (m !== "auto" && m !== "text" && m !== "ocr" && m !== "vlm" && m !== "smart") {
    throw new Error(`Invalid mode "${mode}". Valid: auto, text, ocr, vlm, smart.`);
  }
  return m === "auto" ? "ocr" : m;
}

interface PageRecord {
  page: number;
  body: string;
  provenance: "text" | "ocr" | "vision";
  /** PNG bytes when the page was rasterized for vision (else undefined). */
  png?: Uint8Array;
  pngW?: number;
  pngH?: number;
  /** Smart-mode figure detection record (manifests as `figure` on the page). */
  figure?: FigureRecord;
  /** Frontmatter `enhanced:` flag — set when a vision figure description appended. */
  enhanced?: "vision";
}

/**
 * Run the full file2md v2 pipeline for one or more input documents.
 * Shared implementation for the CLI command and the pi extension tool.
 */
export async function runFile2mdPipeline(opts: File2mdPipelineOptions): Promise<void> {
  const { inputs, relpath = false, emit } = opts;
  const mode = parseMode(opts.mode);
  const note: PageNoteStyle = opts.note ?? "hybrid";
  const scale = opts.scale ?? 2;
  const lang = opts.lang ?? "en";
  const caps: File2mdCaps = { ...DEFAULT_CAPS };

  if (inputs.length === 0) throw new Error("No input files given.");

  const cwd = process.cwd();
  const outRoot = isAbsolute(opts.outRoot) ? opts.outRoot : resolve(cwd, opts.outRoot);
  const displayPath = (abs: string) => (relpath ? relative(cwd, abs) || abs : abs);

  if (opts.forcedType && !ALL_PROFILES.includes(opts.forcedType as DocProfile)) {
    throw new Error(`Invalid type "${opts.forcedType}". Valid: ${ALL_PROFILES.join(", ")}`);
  }
  const forcedType = opts.forcedType as DocProfile | undefined;

  // Vision is resolved eagerly ONLY for mode vlm (text/ocr are VLM-free —
  // resolveVisionLLM throws when no vision capability / PI_MODEL is set,
  // exactly the users v1 text mode exists for). Smart resolves softly (D4):
  // no vision server → one warning line per run, figure pages flag and
  // continue — a page never fails because enhancement did not.
  let llm: ResolvedLLM | undefined;
  if (mode === "vlm") {
    llm = resolveVisionLLM({ model: opts.model, provider: opts.provider, thinking: opts.thinking });
  } else if (mode === "smart") {
    try {
      llm = resolveVisionLLM({ model: opts.model, provider: opts.provider, thinking: opts.thinking });
    } catch {
      console.error("  smart: vision unavailable — figure pages flagged, enhancement skipped");
    }
  }

  console.error("file2md (v2)");
  console.error(`  out:   ${displayPath(outRoot)}`);
  console.error(`  mode:  ${mode}`);
  if (mode === "vlm") console.error(`  model: ${llm?.provider}/${llm?.modelId}`);
  console.error(`  scale: ${scale}  lang: ${lang}`);
  console.error();

  for (const input of inputs) {
    const inputAbs = isAbsolute(input) ? input : resolve(cwd, input);
    console.error(`▶ ${displayPath(inputAbs)}`);
    const inputName = basename(inputAbs);
    // Missing inputs fail with the CLI's Input-not-found convention, not a raw
    // ENOENT from readFileSync (e2e asserts the message; zk-* commands do the same).
    if (!existsSync(inputAbs)) throw new Error(`Input not found: ${displayPath(inputAbs)} (resolved: ${inputAbs})`);
    const bytes = new Uint8Array(readFileSync(inputAbs));
    checkInputData(bytes, caps);
    const sniffed = await detectKind(bytes, inputName);
    await runDocument({
      inputAbs,
      inputName,
      bytes,
      sniffed,
      outRoot,
      mode,
      note,
      scale,
      lang,
      pages: opts.pages,
      forcedType,
      concurrency: opts.concurrency ?? Number(process.env.PI_VLM_CONCURRENCY ?? 1),
      llm,
      caps,
      displayPath,
      emit,
      signal: opts.signal,
    });
  }
}

function checkInputData(data: Uint8Array, caps: File2mdCaps): void {
  if (data.byteLength > caps.maxInputBytes) {
    throw new Error(`Input exceeds the ${caps.maxInputBytes}-byte cap (${data.byteLength} bytes).`);
  }
}

// ---------------------------------------------------------------------------
// per-document dispatch
// ---------------------------------------------------------------------------

interface RunDocumentArgs {
  inputAbs: string;
  inputName: string;
  bytes: Uint8Array;
  sniffed: SniffedFile;
  outRoot: string;
  mode: File2mdMode;
  note: PageNoteStyle;
  scale: number;
  lang: string;
  pages?: string;
  forcedType?: DocProfile;
  concurrency: number;
  llm?: ResolvedLLM;
  caps: File2mdCaps;
  displayPath: (abs: string) => string;
  emit?: (obj: unknown) => void;
  /** Caller's cancel lever for the vision lane (#1948) — see File2mdPipelineOptions.signal. */
  signal?: AbortSignal;
}

async function runDocument(args: RunDocumentArgs): Promise<void> {
  const { inputAbs, inputName, sniffed, forcedType } = args;
  const slug = slugify(inputName);
  const layout = layoutFor(args.outRoot, slug, 1);
  ensureLayout(layout);
  void inputAbs;
  void forcedType;

  if (sniffed.kind === "pdf") return runPdf(args, layout, slug);
  if (sniffed.kind === "image") return runImage(args, layout, slug);
  if (sniffed.kind === "svg") return runSvg(args, layout, slug);
  if (sniffed.kind === "text") {
    // html with svg figures gets a raster lane; plain html stays on the
    // byte-identical passthrough (runHtml falls through when no figure matches)
    if (sniffed.textKind === "html") return runHtml(args, layout, slug);
    return runTextPassthrough(args, layout, slug);
  }
  if (sniffed.kind === "pptx") return runPptx(args, layout, slug);
  return runOffice(args, layout, slug, sniffed.kind);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async function runPdf(args: RunDocumentArgs, _layout: DocLayout, slug: string): Promise<void> {
  const { inputAbs, inputName, bytes, outRoot, mode, note, scale, lang, pages, forcedType } = args;
  const pdf = await openPdf(bytes);
  try {
    const pageCount = pdf.numPages;
    const realLayout = layoutFor(outRoot, slug, pageCount);
    ensureLayout(realLayout);

    const only = pages ? parsePageSpec(pages, pageCount) : null;
    if (pages && only && only.size === 0) {
      throw new Error(
        `--pages "${pages}" matched no pages (document has ${pageCount} page(s)). Use 1-indexed ranges like "1,3-5".`,
      );
    }

    const existing = loadManifest(realLayout);
    const manifest =
      existing && existing.pageCount === pageCount
        ? existing
        : createManifest({
            input: inputAbs,
            inputName,
            kind: "pdf",
            profile: forcedType ?? "paper",
            slug,
            pageCount,
            layout: realLayout,
          });
    // v2 rasterizes only when a page needs OCR/vision — start png-null; set when produced.
    for (const mp of manifest.pages) mp.png = null;

    let profile: DocProfile = forcedType ?? "paper";
    if (mode === "vlm" && !forcedType && args.llm) {
      profile = await classifyPdfProfile(bytes, pageCount, args.llm, scale, args.signal);
      console.error(`  profile: ${profile} (vlm classify)`);
    }
    manifest.profile = profile;
    writeManifest(realLayout, manifest);

    // Vision calls (vlm pages, or smart figure enhancement when a server is
    // resolved) run under the per-document pool; VLM-free runs stay serial.
    const concurrency = mode === "vlm" || (mode === "smart" && args.llm) ? Math.max(1, args.concurrency) : 1;
    const ocrSession = new OcrSession(lang);
    const processPage = async (pageNo: number) => {
      const mp = manifest.pages[pageNo - 1]!;
      if (only && !only.has(pageNo)) return;
      if (mp.status === "done" && existsSync(realLayout.mdAbs(pageNo))) return;

      const record = await extractPdfPage(args, pdf, pageNo, mode, note, scale, profile, slug, pageCount, ocrSession);
      if (record.png) {
        writeFileSync(realLayout.pngAbs(pageNo), record.png);
        mp.png = realLayout.pngRel(pageNo);
      } else {
        mp.png = null;
      }
      writeFileSync(realLayout.mdAbs(pageNo), pageNoteMd(inputName, pageNo, pageCount, profile, record), "utf8");
      mp.status = "done" as PageStatus;
      delete mp.error;
      // Smart-mode figure record: present when detected, absent otherwise
      // (additive — old readers ignore it; non-smart runs never write it).
      if (record.figure) mp.figure = record.figure;
      else delete mp.figure;
      writeManifest(realLayout, manifest);
      args.emit?.({
        type: "page",
        slug,
        page: pageNo,
        status: "done",
        chars: record.body.length,
        provenance: record.provenance,
      });
    };
    await runPool(
      Array.from({ length: pageCount }, (_, i) => i + 1),
      concurrency,
      processPage,
    );
    await ocrSession.terminate().catch(() => undefined);

    writeIndexNote(realLayout, manifest, profile, process.cwd());
    console.error(`\n  ✓ ${slug}: manifest + index written → ${args.displayPath(realLayout.dir)}`);
    args.emit?.({ type: "doc_done", slug, profile, pages: pageCount });
  } finally {
    await pdf.destroy();
  }
}

/** Page-1 vision classification (vlm mode only); degrades to "paper". */
async function classifyPdfProfile(
  bytes: Uint8Array,
  _pageCount: number,
  llm: ResolvedLLM,
  scale: number,
  signal?: AbortSignal,
): Promise<DocProfile> {
  try {
    const rendered = await rasterPage(bytes, 1, scale);
    if (!rendered) return "paper";
    const png = bgraToPng(rendered.bgra, rendered.width, rendered.height);
    const tmp = joinTempPng(1);
    writeFileSync(tmp, png);
    try {
      const { profile } = await withRetry(
        () => classifyProfileFromPages([{ path: tmp, mimeType: "image/png" }], llm, signal),
        { signal },
      );
      return profile;
    } finally {
      await safeUnlink(tmp);
    }
  } catch (e) {
    console.error(`  (profile classify skipped: ${e instanceof Error ? e.message : e})`);
    return "paper";
  }
}

/**
 * Extract one PDF page to { body, provenance } following the mode:
 *   text → text layer only; ocr → text, OCR when thin; vlm → text, then
 *   vision for thin pages (OCR as the automatic degrade).
 */
async function extractPdfPage(
  args: RunDocumentArgs,
  pdf: PdfHandle,
  pageNo: number,
  mode: File2mdMode,
  note: PageNoteStyle,
  scale: number,
  profile: DocProfile,
  slug: string,
  pageCount: number,
  ocrSession: OcrSession,
): Promise<PageRecord> {
  const text = (await pdf.getText(pageNo)).trim();
  if (text.length >= OCR_TEXT_MIN_CHARS || mode === "text") {
    // smart: a usable text page is checked for the caption-only-figure shape
    // before stopping (D2) — prose pages never fit the band, and a figure
    // page with no enhancement (ticket 01) just flags + notices.
    if (mode === "smart" && isTextFigure(text)) {
      // No vision server → ticket-01 flag+notice with zero rasterization.
      // With a server the enhancement is attempted (ticket 02): rasterize
      // ONCE — the vision call needs the image — then degrade on failure.
      const llm = args.llm;
      if (!llm) return figureSkipRecord(pageNo, text, "text");
      const rendered = await rasterPage(args.bytes, pageNo, scale);
      if (!rendered) return figureSkipRecord(pageNo, text, "text");
      return await enhanceFigure(llm, args, profile, slug, pageNo, pageCount, rendered, text, "text");
    }
    return { page: pageNo, body: text, provenance: "text" };
  }
  const rendered = await rasterPage(args.bytes, pageNo, scale);
  if (!rendered) {
    return {
      page: pageNo,
      body: `> no text layer on page ${pageNo} and rasterization unavailable (mode: ${mode}).\n`,
      provenance: "ocr",
    };
  }
  if (mode === "vlm" && args.llm) {
    const pngBytes = bgraToPng(rendered.bgra, rendered.width, rendered.height);
    const pngOut = joinTempPng(pageNo);
    writeFileSync(pngOut, pngBytes);
    try {
      const explained = await withRetry(
        () =>
          explainPage(
            args.llm!,
            profile,
            {
              imageAbs: pngOut,
              mimeType: "image/png",
              pngLinkName: `${pageLabel(pageNo, pageCount)}.png`,
              docSlug: slug,
              pageNo,
              pageCount,
              lang: args.lang,
              mode: note as ExplainMode,
            },
            args.signal,
          ),
        { signal: args.signal },
      );
      const validated = validatePageMarkdown(explained.markdown, { page: pageNo, kind: "page" });
      if (explained.ok && validated.ok) {
        return {
          page: pageNo,
          body: explained.markdown,
          provenance: "vision",
          png: pngBytes,
          pngW: rendered.width,
          pngH: rendered.height,
        };
      }
      console.error(`  [${pageNo}] vision output rejected (${explained.error ?? "validation failed"}) — OCR degrade`);
    } catch (e) {
      console.error(`  [${pageNo}] vision failed (${e instanceof Error ? e.message : e}) — OCR degrade`);
    } finally {
      await safeUnlink(pngOut);
    }
  }
  // OCR path (mode ocr, vlm-fallback, or smart's scan step).
  const ocrRes = await ocrSession.recognize(rendered.bmp).catch(() => undefined);
  if (ocrRes) {
    // smart: the OCR-length band decides the scan-page figure flag (D2) — the
    // figure check runs only on real OCR text, never on the degrade bodies.
    if (mode === "smart" && isScanFigure(ocrRes.text)) {
      // Band hit — a scan-shaped figure: describe via vision when a server is
      // resolved, else the ticket-01 flag+notice (the raster for OCR is reused,
      // so the page rasterizes exactly once).
      const llm = args.llm;
      if (!llm) return figureSkipRecord(pageNo, ocrRes.text, "ocr");
      return await enhanceFigure(llm, args, profile, slug, pageNo, pageCount, rendered, ocrRes.text, "ocr");
    }
    return { page: pageNo, body: ocrRes.text, provenance: "ocr" };
  }
  return { page: pageNo, body: `> no text layer on page ${pageNo} (OCR unavailable).\n`, provenance: "ocr" };
}

/** Ticket-01 shape: figure flag + skip notice, no enhancement (no server or degrade). */
function figureSkipRecord(pageNo: number, originalBody: string, provenance: "text" | "ocr"): PageRecord {
  return {
    page: pageNo,
    body: `${originalBody}\n\n${FIGURE_SKIP_NOTICE}\n`,
    provenance,
    figure: { detected: true, enhanced: false },
  };
}

/**
 * Smart-mode figure enhancement (ticket 02, D3/D4): the already-rasterized page
 * image goes to the vision LLM with the figureHint prompt variant. Success: the
 * description appends as `## Figure (vision)` after the untouched body, the png
 * is stored, frontmatter gains `enhanced: vision` (pageNoteMd), the manifest
 * figure record flips `enhanced: true`. Failure — network error, retry
 * exhaustion, or the #1913 empty-output guard rejecting the result — degrades
 * to the ticket-01 skip notice with `enhanced: false` and NO stored png: a page
 * never fails because enhancement did not. Callers narrow `args.llm` before
 * invoking. Deliberately NOT gated by validatePageMarkdown (the description is
 * a body fragment, not a page note — no frontmatter/embed by design).
 */
async function enhanceFigure(
  llm: ResolvedLLM,
  args: RunDocumentArgs,
  profile: DocProfile,
  slug: string,
  pageNo: number,
  pageCount: number,
  rendered: { bmp: Uint8Array; bgra: Uint8Array; width: number; height: number },
  originalBody: string,
  provenance: "text" | "ocr",
): Promise<PageRecord> {
  const pngBytes = bgraToPng(rendered.bgra, rendered.width, rendered.height);
  const pngOut = joinTempPng(pageNo);
  writeFileSync(pngOut, pngBytes);
  try {
    // Mirrors the vlm degrade shape (withRetry + same rejection logs). The
    // #1913 guard returns ok:false rather than throwing, so a rejected output
    // is exactly ONE call — no retry storm on a deterministic no-text outcome.
    const explained = await withRetry(
      () =>
        explainPage(
          llm,
          profile,
          {
            imageAbs: pngOut,
            mimeType: "image/png",
            pngLinkName: `${pageLabel(pageNo, pageCount)}.png`,
            docSlug: slug,
            pageNo,
            pageCount,
            lang: args.lang,
            mode: args.note as ExplainMode,
            figure: true,
          },
          args.signal,
        ),
      { signal: args.signal },
    );
    const description = explained.markdown.trim();
    if (explained.ok && description !== "") {
      return {
        page: pageNo,
        body: `${originalBody}\n\n## Figure (vision)\n\n${description}\n`,
        provenance,
        png: pngBytes,
        pngW: rendered.width,
        pngH: rendered.height,
        figure: { detected: true, enhanced: true },
        enhanced: "vision",
      };
    }
    console.error(
      `  [${pageNo}] figure vision output rejected (${explained.error ?? "validation failed"}) — skip notice`,
    );
  } catch (e) {
    console.error(`  [${pageNo}] figure vision failed (${e instanceof Error ? e.message : e}) — skip notice`);
  } finally {
    await safeUnlink(pngOut);
  }
  return figureSkipRecord(pageNo, originalBody, provenance);
}

// ---------------------------------------------------------------------------
// image
// ---------------------------------------------------------------------------

async function runImage(args: RunDocumentArgs, layout: DocLayout, slug: string): Promise<void> {
  const { inputAbs, inputName, bytes, forcedType, mode } = args;
  if (mode === "text") {
    throw new Error(`Image "${inputAbs}" has no text layer; use mode ocr/auto/vlm.`);
  }
  const profile: DocProfile = forcedType ?? "image";
  const manifest = createManifest({
    input: inputAbs,
    inputName,
    kind: "image",
    profile,
    slug,
    pageCount: 1,
    layout,
  });

  let body = "";
  let provenance: PageRecord["provenance"] = "ocr";
  if (mode === "vlm" && args.llm) {
    const desc = await askImageDescribe(inputAbs, args.signal);
    if (desc.ok && desc.description) {
      body = desc.description;
      provenance = "vision";
    } else {
      console.error(`  [image] vision unavailable (${desc.error ?? "unknown"}) — OCR degrade`);
    }
  }
  if (body === "") {
    const ocr = await ocrImageFile(inputAbs, args.lang);
    if (ocr) {
      body = ocr.text;
    } else {
      throw new Error(`image extraction failed for ${inputAbs}: no OCR text and no vision description`);
    }
  }
  const md = pageNoteMd(inputName, 1, 1, profile, { page: 1, body, provenance });
  writeFileSync(layout.pngAbs(1), bytes); // page-001.png = the source image (embed target)
  writeFileSync(layout.mdAbs(1), md, "utf8");
  manifest.pages[0]!.png = layout.pngRel(1);
  manifest.pages[0]!.status = "done" as PageStatus;
  writeManifest(layout, manifest);
  writeIndexNote(layout, manifest, profile, process.cwd());
  console.error(`\n  ✓ ${slug}: manifest + index written → ${args.displayPath(layout.dir)}`);
  args.emit?.({ type: "doc_done", slug, profile, pages: 1 });
}

// ---------------------------------------------------------------------------
// svg
// ---------------------------------------------------------------------------

/**
 * Standalone .svg input (effort 2026-09-08-file2md-svg-pptx-vision, ticket 02).
 *
 * The base body is ALWAYS the structural extraction (svgToMarkdown — the XML
 * labels are ground truth, strictly better than OCR on a render). Modes layer
 * on top exactly like the pdf/image lanes:
 *   text            → structural only, no raster, provenance text.
 *   auto/ocr        → + rendered PNG embed (no VLM call — auto stays offline).
 *   vlm             → full vision page note (diagram profile), structural degrade.
 *   smart           → structural + `## Figure (vision)` appended enhancement;
 *                     raster/LLM unavailable → skip notice, figure {detected,
 *                     enhanced:false} (D4 — never fails because enhancement did not).
 */
async function runSvg(args: RunDocumentArgs, layout: DocLayout, slug: string): Promise<void> {
  const { inputAbs, inputName, bytes, mode, note } = args;
  const svgText = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const profile: DocProfile = args.forcedType ?? "diagram";
  const manifest = createManifest({
    input: inputAbs,
    inputName,
    kind: "svg",
    profile,
    slug,
    pageCount: 1,
    layout,
  });

  let record: PageRecord = { page: 1, body: svgToMarkdown(inputName, svgText), provenance: "text" };
  let figure: FigureRecord | undefined;

  if (mode !== "text") {
    const maxEdge = Math.max(800, Math.min(3200, Math.round(800 * args.scale)));
    const raster = await renderSvgFileToPng(inputAbs, { maxEdge }).catch(() => null);
    if (raster) {
      writeFileSync(layout.pngAbs(1), raster.png);
      record.png = raster.png;
      record.pngW = raster.width;
      record.pngH = raster.height;
      if (mode === "smart" && !args.llm) {
        // No vision server → the pdf lane's ticket-01 shape: flag + notice
        // with the embed still stored (D4 — a doc never fails on enhancement).
        record = { ...record, body: `${record.body}\n\n${FIGURE_SKIP_NOTICE}\n` };
        figure = { detected: true, enhanced: false };
      } else if ((mode === "vlm" || mode === "smart") && args.llm) {
        const tmp = joinTempPng(1);
        writeFileSync(tmp, raster.png);
        try {
          if (mode === "vlm") {
            const explained = await withRetry(
              () =>
                explainPage(
                  args.llm!,
                  profile,
                  {
                    imageAbs: tmp,
                    mimeType: "image/png",
                    pngLinkName: `${pageLabel(1, 1)}.png`,
                    docSlug: slug,
                    pageNo: 1,
                    pageCount: 1,
                    lang: args.lang,
                    mode: note as ExplainMode,
                  },
                  args.signal,
                ),
              { signal: args.signal },
            );
            const validated = validatePageMarkdown(explained.markdown, { page: 1, kind: "page" });
            if (explained.ok && validated.ok) {
              record = { ...record, body: explained.markdown, provenance: "vision" };
            } else {
              console.error(
                `  [svg] vision output rejected (${explained.error ?? "validation failed"}) — structural degrade`,
              );
            }
          } else {
            // smart: ONE figure-describe call, appended after the structural body
            const explained = await withRetry(
              () =>
                explainPage(
                  args.llm!,
                  profile,
                  {
                    imageAbs: tmp,
                    mimeType: "image/png",
                    pngLinkName: `${pageLabel(1, 1)}.png`,
                    docSlug: slug,
                    pageNo: 1,
                    pageCount: 1,
                    lang: args.lang,
                    mode: note as ExplainMode,
                    figure: true,
                  },
                  args.signal,
                ),
              { signal: args.signal },
            );
            const description = explained.markdown.trim();
            if (explained.ok && description !== "") {
              record = {
                ...record,
                body: `${record.body}\n## Figure (vision)\n\n${description}\n`,
                enhanced: "vision",
              };
              figure = { detected: true, enhanced: true };
            } else {
              console.error(
                `  [svg] figure vision output rejected (${explained.error ?? "validation failed"}) — skip notice`,
              );
              record = { ...record, body: `${record.body}\n\n${FIGURE_SKIP_NOTICE}\n` };
              figure = { detected: true, enhanced: false };
            }
          }
        } catch (e) {
          console.error(`  [svg] vision failed (${e instanceof Error ? e.message : e}) — degrade`);
          if (mode === "smart") {
            record = { ...record, body: `${record.body}\n\n${FIGURE_SKIP_NOTICE}\n` };
            figure = { detected: true, enhanced: false };
          }
        } finally {
          await safeUnlink(tmp);
        }
      }
    } else {
      console.error("  [svg] rasterization unavailable — structural extraction only");
      record.body += "\n> SVG rasterization unavailable on this machine — structural extraction only.\n";
      if (mode === "smart") {
        record.body += `\n${FIGURE_SKIP_NOTICE}\n`;
        figure = { detected: true, enhanced: false };
      }
    }
  }

  const md = pageNoteMd(inputName, 1, 1, profile, record);
  writeFileSync(layout.mdAbs(1), md, "utf8");
  manifest.pages[0]!.png = record.png ? layout.pngRel(1) : null;
  manifest.pages[0]!.status = "done" as PageStatus;
  if (figure) manifest.pages[0]!.figure = figure;
  writeManifest(layout, manifest);
  writeIndexNote(layout, manifest, profile, process.cwd());
  console.error(`\n  ✓ ${slug}: svg → ${args.displayPath(layout.dir)}`);
  args.emit?.({ type: "doc_done", slug, profile, pages: 1 });
}

// ---------------------------------------------------------------------------
// html with svg figures
// ---------------------------------------------------------------------------

/** Bound on extracted figures per html document (raster cost control). */
export const SVG_FIGURE_MAX = 8;

interface SvgFigure {
  kind: "inline" | "file";
  /** inline: the raw <svg>…</svg> block; file: absolute path to the referenced .svg */
  source: string;
  /** <img alt> for file figures (kept as anchor caption). */
  alt?: string;
}

/**
 * Rewrite svg-bearing html so every convertible figure becomes a
 * `![[figure-NN.png]]` anchor at its document position (D14): inline <svg>
 * blocks (balanced scan — svg-in-svg is legal, so no bare non-greedy regex)
 * and <img src="*.svg"> pointing at a LOCAL file under the input's directory
 * convert (no network fetch, truth rules); everything else is left for the
 * plain html conversion exactly as before. Matches inside <script>/<style>
 * spans are skipped (an svg literal in JS is code, not a figure).
 */
export function extractSvgFigures(html: string, inputDir: string): { html: string; figures: SvgFigure[] } {
  // Off-limits spans: script/style contents and comments never hold figures.
  const offLimits: Array<[number, number]> = [];
  for (const m of html.matchAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi)) {
    offLimits.push([m.index!, m.index! + m[0].length]);
  }
  const blocked = (i: number) => offLimits.some(([a, b]) => i >= a && i < b);

  const figures: SvgFigure[] = [];
  const out: string[] = [];
  let cursor = 0;
  // Iterative scan (a recursive skip over a large JS icon bundle would
  // overflow the stack and take the whole document down with it).
  const findNext = (from: number): { start: number; kind: "svg" | "img"; end: number } | null => {
    let at = from;
    for (;;) {
      const svgAt = html.indexOf("<svg", at);
      const imgAt = html.indexOf("<img", at);
      let idx = -1;
      let kind: "svg" | "img" = "svg";
      if (svgAt !== -1 && (imgAt === -1 || svgAt < imgAt)) {
        idx = svgAt;
        kind = "svg";
      } else if (imgAt !== -1) {
        idx = imgAt;
        kind = "img";
      } else return null;
      if (!blocked(idx)) {
        if (kind === "img") {
          const close = html.indexOf(">", idx);
          if (close !== -1) return { start: idx, kind, end: close + 1 };
        } else if (/<svg[\s>]/.test(html.slice(idx, idx + 5))) {
          // Balanced walk: nested <svg> opens extend the block past the first </svg>.
          let depth = 0;
          const token = /<svg\b|<\/svg\s*>/gi;
          token.lastIndex = idx;
          let end = -1;
          for (let m = token.exec(html); m !== null; m = token.exec(html)) {
            depth += m[0][1] === "/" ? -1 : 1;
            if (depth === 0) {
              end = m.index + m[0].length;
              break;
            }
          }
          if (end !== -1) return { start: idx, kind, end }; // unbalanced — skip
        }
      }
      at = idx + 1;
    }
  };

  let next = findNext(0);
  while (next !== null) {
    const tag = html.slice(next.start, next.end);
    let anchor: string | null = null;
    if (next.kind === "svg") {
      if (figures.length < SVG_FIGURE_MAX) {
        figures.push({ kind: "inline", source: tag });
        anchor = `\n![[figure-${String(figures.length).padStart(2, "0")}.png]]\n`;
      }
    } else {
      const srcMatch = /\ssrc\s*=\s*["']([^"']*)["']/i.exec(tag);
      const src = srcMatch?.[1] ? srcMatch[1].replace(/&amp;/g, "&") : "";
      const convertible =
        /\.svg(\?.*)?(#.*)?$/i.test(src) &&
        figures.length < SVG_FIGURE_MAX &&
        !/^[a-z][a-z0-9+.-]*:/i.test(src) &&
        !src.startsWith("//");
      if (convertible) {
        const abs = resolve(inputDir, src.replace(/^\.?\//, ""));
        const inside = abs === inputDir || abs.startsWith(inputDir + "/"); // stay under the input dir
        if (inside && existsSync(abs)) {
          const altMatch = /\salt\s*=\s*["']([^"']*)["']/i.exec(tag);
          figures.push({ kind: "file", source: abs, alt: altMatch?.[1] || undefined });
          const caption = altMatch?.[1] ? ` — *${altMatch[1]}*` : "";
          anchor = `\n![[figure-${String(figures.length).padStart(2, "0")}.png]]${caption}\n`;
        }
      }
    }
    out.push(html.slice(cursor, next.start));
    out.push(anchor ?? tag);
    cursor = next.end;
    next = findNext(cursor);
  }
  out.push(html.slice(cursor));
  return { html: out.join(""), figures };
}

/**
 * html lane (ticket 03): svg-bearing html gets each figure rasterized to
 * pages/figure-NN.png with an in-place wikilink anchor; smart/vlm append a
 * per-figure vision description under `## Figure (vision) — NN`. html with
 * NO convertible figure falls through to runTextPassthrough — byte-identical
 * to the pre-lane behavior (pinned by test).
 */
async function runHtml(args: RunDocumentArgs, layout: DocLayout, slug: string): Promise<void> {
  const { inputAbs, inputName, bytes, mode } = args;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (mode === "text") return runTextPassthrough(args, layout, slug);
  const { html: rewritten, figures } = extractSvgFigures(text, dirname(inputAbs));
  if (figures.length === 0) return runTextPassthrough(args, layout, slug);

  const maxEdge = Math.max(800, Math.min(3200, Math.round(800 * args.scale)));
  const rendered: { n: number; abs: string }[] = [];
  const failedNs: number[] = [];
  for (let i = 0; i < figures.length; i++) {
    const fig = figures[i]!;
    const raster =
      fig.kind === "inline"
        ? await renderSvgTextToPng(fig.source, { maxEdge }).catch(() => null)
        : await renderSvgFileToPng(fig.source, { maxEdge }).catch(() => null);
    if (raster) {
      const n = i + 1;
      writeFileSync(layout.figureAbs(n), raster.png);
      rendered.push({ n, abs: layout.figureAbs(n) });
    } else {
      failedNs.push(i + 1);
      console.error(`  [html] figure ${i + 1} rasterization failed — anchor degrades to a notice`);
    }
  }
  // A raster failure must not leave a broken ![[figure-NN.png]] embed behind.
  let html = rewritten;
  for (const n of failedNs) {
    html = html.replaceAll(
      `![[figure-${String(n).padStart(2, "0")}.png]]`,
      `*(svg figure ${n} could not be rendered on this machine)*`,
    );
  }

  let body = htmlToMarkdown(html);
  if (rendered.length < figures.length) {
    body += `\n> ${figures.length - rendered.length} of ${figures.length} svg figure(s) could not be rasterized on this machine.\n`;
  }

  if ((mode === "vlm" || mode === "smart") && args.llm && rendered.length > 0) {
    for (const { n, abs } of rendered) {
      try {
        const explained = await withRetry(
          () =>
            explainPage(
              args.llm!,
              "diagram",
              {
                imageAbs: abs,
                mimeType: "image/png",
                pngLinkName: `figure-${String(n).padStart(2, "0")}.png`,
                docSlug: slug,
                pageNo: n,
                pageCount: rendered.length,
                lang: args.lang,
                mode: args.note as ExplainMode,
                figure: true,
              },
              args.signal,
            ),
          { signal: args.signal },
        );
        const description = explained.markdown.trim();
        if (explained.ok && description !== "") {
          body += `\n## Figure (vision) — ${String(n).padStart(2, "0")}\n\n${description}\n`;
        } else {
          body += `\n> Figure ${n} vision enhancement skipped (vision output rejected).\n`;
        }
      } catch (e) {
        console.error(`  [html] figure ${n} vision failed (${e instanceof Error ? e.message : e}) — skipped`);
        body += `\n> Figure ${n} vision enhancement skipped (vision call failed).\n`;
      }
    }
  } else if ((mode === "vlm" || mode === "smart") && rendered.length > 0) {
    body += `\n${FIGURE_SKIP_NOTICE}\n`;
  }

  const cap = args.caps.maxBytes;
  if (body.length > cap) body = `${body.slice(0, cap)}\n> Truncated: output capped at ${cap} bytes.\n`;
  const full = ["---", `title: ${inputName}`, `kind: text`, `format: html`, "---", "", body, ""].join("\n");
  writeFileSync(layout.indexNotePath, full, "utf8");
  const manifest = createManifest({
    input: inputAbs,
    inputName,
    kind: "text",
    profile: "diagram",
    slug,
    pageCount: 1,
    layout,
  });
  manifest.pages[0]!.png = null; // figures are body assets, not page notes
  manifest.pages[0]!.md = null;
  manifest.pages[0]!.status = "done" as PageStatus;
  writeManifest(layout, manifest);
  console.error(
    `\n  ✓ ${slug}: html (${rendered.length}/${figures.length} svg figures) → ${args.displayPath(layout.indexNotePath)}`,
  );
  args.emit?.({ type: "doc_done", slug, profile: "diagram", pages: 1 });
}

// ---------------------------------------------------------------------------
// pptx (rendered slide lane)
// ---------------------------------------------------------------------------

/** Slide text below this many chars looks label-only → diagram candidate (smart). */
export const SLIDE_DIAGRAM_TEXT_MAX_CHARS = 120;

/** A diagram-heavy slide: carries pictures/SmartArt/charts, or has label-thin text. */
export function isDiagramSlide(slideXml: string, shapesText: string): boolean {
  if (/<p:pic[\s>]/.test(slideXml) || /<p:graphicFrame[\s>]/.test(slideXml)) return true;
  return shapesText.replace(/\s+/g, "").length < SLIDE_DIAGRAM_TEXT_MAX_CHARS;
}

/** Per-slide ground-truth body, same shape the vendored markdown renderer emits. */
function slideBody(shapes: Array<{ shapeId: string; text: string }>, slideNo: number, total: number): string {
  const lines = [`## Slide ${slideNo}/${total}`, ""];
  for (const shape of shapes) lines.push(`- [${shape.shapeId}] ${shape.text}`);
  return lines.join("\n");
}

/**
 * pptx lane (ticket 05): the vendored text-run extraction stays the
 * ground-truth body; a probed renderer (qlmanage/soffice, src/raster/deck.ts)
 * rasterizes slides into per-page notes with `![[page-NNN.png]]` embeds —
 * a real multi-page doc like the pdf lane (manifest pageCount = slides,
 * `--pages` filter, resumability). text mode / no renderer → exactly the
 * runOffice output (plus a notice when renders were wanted but unavailable).
 */
async function runPptx(args: RunDocumentArgs, layout: DocLayout, slug: string): Promise<void> {
  const { inputAbs, inputName, bytes, mode } = args;
  const result = await readDocument({ data: bytes, path: inputName });
  const slides = result.pptx?.slides ?? [];
  const total = result.pptx?.totalSlides ?? slides.length;
  const slideCount = slides.length;
  if (slideCount === 0 || mode === "text") return runOffice(args, layout, slug, "pptx");

  const renderer = pickRenderer();
  if (!renderer) {
    // Today's runOffice output shape + an honest notice in the note itself
    // (truth rules: state plainly what the format lost on this machine).
    console.error(
      "  [pptx] no slide renderer on this machine (looked for qlmanage, soffice+pdftoppm) — text-only output",
    );
    const md = renderMarkdown(result, args.caps.maxBytes);
    const notice =
      "\n> Slide renders unavailable on this machine (looked for qlmanage, soffice+pdftoppm) — text runs only; diagrams and images are lost.\n";
    const full = ["---", `title: ${inputName}`, `kind: pptx`, `profile: paper`, "---", "", md + notice, ""].join("\n");
    writeFileSync(layout.indexNotePath, full, "utf8");
    const manifest = createManifest({
      input: inputAbs,
      inputName,
      kind: "pptx",
      profile: "paper",
      slug,
      pageCount: 1,
      layout,
    });
    manifest.pages[0]!.png = null;
    manifest.pages[0]!.md = null;
    manifest.pages[0]!.status = "done" as PageStatus;
    writeManifest(layout, manifest);
    console.error(`\n  ✓ ${slug}: pptx (text-only, no renderer) → ${args.displayPath(layout.indexNotePath)}`);
    args.emit?.({ type: "doc_done", slug, profile: "paper", pages: 1 });
    return;
  }

  // Slide XML flags for the smart diagram heuristic (pic/graphicFrame never
  // survive the text-run reader, so re-read the raw parts here).
  let slideXmls: string[] = [];
  try {
    const parts = readZipText(bytes);
    slideXmls = slides.map((s) => parts[`ppt/slides/slide${s.slide + 1}.xml`] ?? "");
  } catch {
    slideXmls = slides.map(() => "");
  }

  const realLayout = layoutFor(args.outRoot, slug, slideCount);
  ensureLayout(realLayout);
  const only = args.pages ? parsePageSpec(args.pages, slideCount) : null;
  if (args.pages && only && only.size === 0) {
    throw new Error(
      `--pages "${args.pages}" matched no slides (deck has ${slideCount} slide(s)). Use 1-indexed ranges like "1,3-5".`,
    );
  }
  const profile: DocProfile = args.forcedType ?? "slides";
  const existing = loadManifest(realLayout);
  const manifest =
    existing && existing.pageCount === slideCount
      ? existing
      : createManifest({
          input: inputAbs,
          inputName,
          kind: "pptx",
          profile,
          slug,
          pageCount: slideCount,
          layout: realLayout,
        });

  // Render once into the pages dir (resumable: a full render is skipped only
  // when every selected page is already done — the renderer has no page set).
  const needRender = manifest.pages.some(
    (mp, i) => (!only || only.has(i + 1)) && !(mp.status === "done" && existsSync(realLayout.mdAbs(i + 1))),
  );
  if (needRender) {
    const work = mkdtempSync(join(tmpdir(), "file2md-pptx-"));
    try {
      const written = await renderer.renderSlides(inputAbs, work, {
        limit: Math.min(slideCount, args.caps.maxSlides),
        size: Math.max(800, Math.min(3200, Math.round(800 * args.scale))),
      });
      for (const path of written) {
        const n = Number(/slide-(\d+)\.png$/.exec(path)?.[1] ?? 0);
        if (n >= 1 && n <= slideCount) writeFileSync(realLayout.pngAbs(n), new Uint8Array(readFileSync(path)));
      }
    } catch (e) {
      console.error(`  [pptx] slide render failed (${e instanceof Error ? e.message : e}) — text-only pages`);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  const truncatedNotice =
    total > slideCount ? `\n> Truncated: rendering first ${slideCount} of ${total} slides (window cap).\n` : "";

  const processSlide = async (slideNo: number) => {
    const mp = manifest.pages[slideNo - 1]!;
    if (only && !only.has(slideNo)) return;
    if (mp.status === "done" && existsSync(realLayout.mdAbs(slideNo))) return;

    const slide = slides[slideNo - 1]!;
    let record: PageRecord = {
      page: slideNo,
      body: `${slideBody(slide.shapes, slideNo, slideCount)}${truncatedNotice}`,
      provenance: "text",
    };
    const pngPath = realLayout.pngAbs(slideNo);
    const hasPng = existsSync(pngPath);
    if (hasPng) {
      record.png = new Uint8Array(readFileSync(pngPath));
    }

    if (
      hasPng &&
      args.llm &&
      (mode === "vlm" ||
        (mode === "smart" && isDiagramSlide(slideXmls[slideNo - 1] ?? "", slide.shapes.map((s) => s.text).join(" "))))
    ) {
      const pngLinkName = `${pageLabel(slideNo, slideCount)}.png`;
      try {
        if (mode === "vlm") {
          const explained = await withRetry(
            () =>
              explainPage(
                args.llm!,
                profile,
                {
                  imageAbs: pngPath,
                  mimeType: "image/png",
                  pngLinkName,
                  docSlug: slug,
                  pageNo: slideNo,
                  pageCount: slideCount,
                  lang: args.lang,
                  mode: args.note as ExplainMode,
                },
                args.signal,
              ),
            { signal: args.signal },
          );
          const validated = validatePageMarkdown(explained.markdown, { page: slideNo, kind: "page" });
          if (explained.ok && validated.ok) {
            record = { ...record, body: explained.markdown, provenance: "vision" };
          } else {
            console.error(
              `  [slide ${slideNo}] vision output rejected (${explained.error ?? "validation failed"}) — text-run body`,
            );
          }
        } else {
          const explained = await withRetry(
            () =>
              explainPage(
                args.llm!,
                profile,
                {
                  imageAbs: pngPath,
                  mimeType: "image/png",
                  pngLinkName,
                  docSlug: slug,
                  pageNo: slideNo,
                  pageCount: slideCount,
                  lang: args.lang,
                  mode: args.note as ExplainMode,
                  figure: true,
                },
                args.signal,
              ),
            { signal: args.signal },
          );
          const description = explained.markdown.trim();
          if (explained.ok && description !== "") {
            record = {
              ...record,
              body: `${record.body}\n## Slide (vision)\n\n${description}\n`,
              enhanced: "vision",
            };
            mp.figure = { detected: true, enhanced: true };
          } else {
            console.error(`  [slide ${slideNo}] vision output rejected — skip notice`);
            record = { ...record, body: `${record.body}\n\n${FIGURE_SKIP_NOTICE}\n` };
            mp.figure = { detected: true, enhanced: false };
          }
        }
      } catch (e) {
        console.error(`  [slide ${slideNo}] vision failed (${e instanceof Error ? e.message : e}) — degrade`);
        if (mode === "smart") {
          record = { ...record, body: `${record.body}\n\n${FIGURE_SKIP_NOTICE}\n` };
          mp.figure = { detected: true, enhanced: false };
        }
      }
    }

    writeFileSync(realLayout.mdAbs(slideNo), pageNoteMd(inputName, slideNo, slideCount, profile, record), "utf8");
    mp.png = hasPng ? realLayout.pngRel(slideNo) : null;
    mp.status = "done" as PageStatus;
    delete mp.error;
    writeManifest(realLayout, manifest);
    args.emit?.({
      type: "page",
      slug,
      page: slideNo,
      status: "done",
      chars: record.body.length,
      provenance: record.provenance,
    });
  };

  const concurrency = mode === "vlm" || (mode === "smart" && args.llm) ? Math.max(1, args.concurrency) : 1;
  await runPool(
    Array.from({ length: slideCount }, (_, i) => i + 1),
    concurrency,
    processSlide,
  );
  writeIndexNote(realLayout, manifest, profile, process.cwd());
  console.error(
    `\n  ✓ ${slug}: pptx (${slideCount} slides, renderer ${renderer.id}) → ${args.displayPath(realLayout.dir)}`,
  );
  args.emit?.({ type: "doc_done", slug, profile, pages: slideCount });
}

// ---------------------------------------------------------------------------
// office (docx/xlsx/pptx/ipynb) + text passthrough
// ---------------------------------------------------------------------------

async function runOffice(
  args: RunDocumentArgs,
  layout: DocLayout,
  slug: string,
  kind: "docx" | "xlsx" | "pptx" | "ipynb",
): Promise<void> {
  const { inputAbs, inputName, bytes } = args;
  const result = await readDocument({ data: bytes, path: inputName });
  const md = renderMarkdown(result, args.caps.maxBytes);
  const full = ["---", `title: ${inputName}`, `kind: ${kind}`, `profile: paper`, "---", "", md, ""].join("\n");
  writeFileSync(layout.indexNotePath, full, "utf8");
  const manifest = createManifest({
    input: inputAbs,
    inputName,
    kind,
    profile: "paper",
    slug,
    pageCount: 1,
    layout,
  });
  manifest.pages[0]!.png = null;
  manifest.pages[0]!.md = null;
  manifest.pages[0]!.status = "done" as PageStatus;
  writeManifest(layout, manifest);
  console.error(`\n  ✓ ${slug}: ${kind} → ${args.displayPath(layout.indexNotePath)}`);
  args.emit?.({ type: "doc_done", slug, profile: "paper", pages: 1 });
}

async function runTextPassthrough(args: RunDocumentArgs, layout: DocLayout, slug: string): Promise<void> {
  const { inputAbs, inputName, bytes } = args;
  const textKind = args.sniffed.textKind ?? "txt";
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  let body: string;
  if (textKind === "csv") body = csvToMarkdown(text);
  else if (textKind === "html") body = htmlToMarkdown(text);
  else body = text;
  const cap = args.caps.maxBytes;
  const clipped = body.length > cap;
  if (clipped) body = `${body.slice(0, cap)}\n> Truncated: output capped at ${cap} bytes.\n`;
  const full = ["---", `title: ${inputName}`, `kind: text`, `format: ${textKind}`, "---", "", body, ""].join("\n");
  writeFileSync(layout.indexNotePath, full, "utf8");
  const manifest = createManifest({
    input: inputAbs,
    inputName,
    kind: "text",
    profile: "paper",
    slug,
    pageCount: 1,
    layout,
  });
  manifest.pages[0]!.png = null;
  manifest.pages[0]!.md = null;
  manifest.pages[0]!.status = "done" as PageStatus;
  writeManifest(layout, manifest);
  console.error(`\n  ✓ ${slug}: text (${textKind}) → ${args.displayPath(layout.indexNotePath)}`);
  args.emit?.({ type: "doc_done", slug, profile: "paper", pages: 1 });
}

/** Split one CSV line into cells (RFC-4180 quoting: "" escapes a quote). */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQ = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQ = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQ = true;
      i++;
      continue;
    }
    if (c === ",") {
      cells.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  return cells;
}

/** Minimal RFC-4180 CSV → markdown table (quoted cells round-trip, pipe-escaped). */
export function csvToMarkdown(text: string): string {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    rows.push(parseCsvLine(line));
  }
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const norm = rows.map((r) => [...r, ...Array(width - r.length).fill("")].map((c) => c.replace(/\|/g, "\\|")));
  const head = norm[0]!;
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...norm.slice(1).map((r) => `| ${r.join(" | ")} |`),
    "",
  ].join("\n");
}

/** Very small HTML → markdown-lite: title + headings/lists/paragraphs/styles. */
export function htmlToMarkdown(html: string): string {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const title = m?.[1]?.trim();
  let body = html.replace(/<title[\s\S]*?<\/title>/i, " ");
  body = body
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // opening heading tag prefixes the marker; the CLOSING tag must not emit a
    // second one (a lone stray `#` line) — and `<(b|strong)` needs a word
    // boundary or `<body>` opens a `**` (seen live in the html-figure receipt)
    .replace(/<h([1-6])\b[^>]*>/gi, (_cap, level) => `\n${"#".repeat(+level)} `)
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<\/(li)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<(p|div|tr|td)\b[^>]*>/gi, "\n")
    .replace(/<\/?table>/gi, "\n")
    .replace(/<\/?pre>/gi, "\n")
    .replace(/<(b|strong)\b[^>]*>/gi, "**")
    .replace(/<\/(b|strong)>/gi, "**")
    .replace(/<(i|em)[^>]*>/gi, "*")
    .replace(/<\/(i|em)>/gi, "*")
    .replace(/<(code)[^>]*>/gi, "`")
    .replace(/<\/code>/gi, "`")
    .replace(/<a\s[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<a\s[^>]*>([\s\S]*?)<\/a>/gi, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  const out = body.trim();
  return title && !out.startsWith(`# ${title}`) ? `# ${title}\n\n${out}\n` : `${out}\n`;
}

// ---------------------------------------------------------------------------
// note assembly (v1-shaped contract)
// ---------------------------------------------------------------------------

function pageNoteMd(
  inputName: string,
  pageNo: number,
  pageCount: number,
  profile: DocProfile,
  rec: PageRecord,
): string {
  const props = [
    `title: ${inputName}`,
    `page: ${pageNo}`,
    `kind: page`,
    `profile: ${profile}`,
    `provenance: ${rec.provenance}`,
    ...(rec.enhanced ? [`enhanced: ${rec.enhanced}`] : []),
    ...(rec.pngW !== undefined ? [`width: ${rec.pngW}`] : []),
    ...(rec.pngH !== undefined ? [`height: ${rec.pngH}`] : []),
  ];
  const ref = rec.png ? `\n![[page-${pageLabel(pageNo, pageCount)}.png]]\n` : "";
  return `${["---", ...props, "---", "", ref, rec.body, ""].join("\n")}`;
}

function writeIndexNote(layout: DocLayout, manifest: Manifest, profile: DocProfile, cwd: string): void {
  const relInput = isAbsolute(manifest.input) ? relative(cwd, manifest.input) : manifest.input;
  const lines: string[] = [
    "---",
    `title: ${manifest.inputName}`,
    `kind: ${manifest.kind}`,
    `profile: ${profile}`,
    `pages: ${manifest.pageCount}`,
    `source: "${relInput}"`,
    `created: ${manifest.createdAt}`,
    "---",
    "",
    `# ${manifest.inputName}`,
    "",
    `> Source: \`${relInput}\` · kind: ${manifest.kind} / ${profile} · ${manifest.pageCount} page(s)`,
    "",
    "## Page index",
    "",
  ];
  for (const pg of manifest.pages) {
    const mdBase = pg.md ? basename(pg.md) : "";
    const status = pg.status === "done" ? "✅" : pg.status === "error" ? "❌" : "⬜";
    lines.push(`- ${status} [[${manifest.slug}-${mdBase?.replace(/\.md$/, "")} | page ${pg.page}]]`);
  }
  writeFileSync(layout.indexNotePath, `${lines.join("\n")}\n`, "utf8");
}

/** Temp file for VLM-bound page images (never lands in the vault layout). */
function joinTempPng(pageNo: number): string {
  return `/tmp/file2md-page-${pageNo}-${process.pid}.png`;
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await Bun.file(path).delete();
  } catch {
    /* best-effort */
  }
}
