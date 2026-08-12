/**
 * Core file2md pipeline: classify → rasterize → VLM extract → manifest.
 *
 * Extracted from pi-agent's `cli` namespace so both the CLI (thin wrapper) and the
 * pi extension (file2md tool) share the same implementation.
 */
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { rasterizePdf } from "./native/pdf2png.ts";
import { extractPdfText } from "./native/pdftext.ts";
import { type ResolvedLLM, resolveVisionLLM } from "./sessions.ts";
import { type ExplainMode, type ExplainResult, explainPage } from "./vlm/agents.ts";
import { ALL_PROFILES, classifyKind, type DocKind, type DocProfile, imageMimeType } from "./vlm/classify.ts";
import { classifyProfileFromPages } from "./vlm/classify-vlm.ts";
import { type ExtractStrategy, parseExtractStrategy } from "./vlm/extract-strategy.ts";
import { describeFigureWithPrior } from "./vlm/figure-annotate.ts";
import { detectFigurePages } from "./vlm/figure-detect.ts";
import {
  createManifest,
  type DocLayout,
  ensureLayout,
  layoutFor,
  loadManifest,
  type Manifest,
  type PageStatus,
  slugify,
  writeManifest,
} from "./vlm/manifest.ts";
import { formatContext, PageContext } from "./vlm/page-context.ts";
import { retryableError, withRetry } from "./vlm/retry.ts";
import { validatePageMarkdown } from "./vlm/validate.ts";

// Read lazily at call time (not module load) so tests / callers can set the env
// vars any time before the pipeline runs — evaluating at load froze the values
// whenever another importer preloaded this module first.
const defaultRetries = () => Number(process.env.PI_VLM_RETRIES ?? 3);
const defaultRetryWaitMs = () => Number(process.env.PI_VLM_RETRY_WAIT_MS ?? 10_000);

export interface VlmDescribePipelineOpts {
  inputs: string[];
  outRoot: string;
  model?: string;
  provider?: string;
  thinking?: string;
  forcedType?: DocProfile;
  pages?: string;
  dpi?: number;
  /** When true, display paths as relative to cwd instead of absolute. Default false (abs). */
  relpath?: boolean;
  /** Max concurrent page extractions (default 1; env PI_VLM_CONCURRENCY).
   *  >1 runs pages in parallel but DISABLES cross-page context (S1), which
   *  requires strict page order. Speed mode for remote / multi-slot providers. */
  concurrency?: number;
  /** Output language for the per-page notes (T3, default zh-TW). */
  lang?: string;
  /** Processing mode (T3, default hybrid). */
  mode?: ExplainMode;
  /** Extraction strategy: `vlm` (default — rasterize + VLM) | `text` (mupdf text
   *  layer, no rasterize, no VLM; PDFs only) | `hybrid` (mupdf text body on
   *  every page + a text-as-prior VLM call on figure-bearing pages only;
   *  PDFs only).
   *
   *  Applies to PDFs only; images always use the vlm path. */
  extract?: ExtractStrategy;
  /** Optional NDJSON emitter (json mode). */
  emit?: (obj: unknown) => void;
}

/** Parse a "1,3-5" page spec into a sorted set of 1-indexed page numbers. */
function parsePageSpec(spec: string, total: number): Set<number> {
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

interface PreparedDoc {
  kind: DocKind;
  inputAbs: string;
  inputName: string;
  slug: string;
  pageCount: number;
  layout: DocLayout;
  pagePngs: string[];
}

/** Step 1–2: classify kind + rasterize/copy into the output layout. */
async function prepareDoc(inputAbs: string, outRoot: string, dpi: number): Promise<PreparedDoc> {
  const classified = classifyKind(inputAbs);
  const inputName = basename(inputAbs);
  const slug = slugify(inputName);
  const tmpLayout = layoutFor(outRoot, slug, 1);
  ensureLayout(tmpLayout);

  let pagePngs: string[];
  let pageCount: number;

  if (classified.kind === "pdf") {
    const r = await rasterizePdf(inputAbs, tmpLayout.pagesDir, { dpi });
    pageCount = r.pageCount;
    pagePngs = r.pages;
  } else {
    pageCount = 1;
    const layout1 = layoutFor(outRoot, slug, 1);
    const dst = layout1.pngAbs(1);
    copyFileSync(inputAbs, dst);
    pagePngs = [dst];
  }

  const layout = layoutFor(outRoot, slug, pageCount);
  ensureLayout(layout);

  return {
    kind: classified.kind,
    inputAbs,
    inputName,
    slug,
    pageCount,
    layout,
    pagePngs,
  };
}

/** Write the doc-level MOC note linking all page notes. */
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
    `> 來源檔案：\`${relInput}\`  ·  類型：${manifest.kind} / ${profile}  ·  共 ${manifest.pageCount} 頁`,
    "",
    "## 頁面索引",
    "",
  ];
  for (const pg of manifest.pages) {
    const mdBase = pg.md ? basename(pg.md) : "";
    const status = pg.status === "done" ? "✅" : pg.status === "error" ? "❌" : "⬜";
    lines.push(`- ${status} [[${manifest.slug}-${mdBase?.replace(/\.md$/, "")} | 第 ${pg.page} 頁]]`);
  }
  writeFileSync(layout.indexNotePath, lines.join("\n") + "\n", "utf8");
}

/**
 * T5 — `extract: "text"` branch for a single born-digital PDF.
 *
 * Extracts the embedded text layer via `extractPdfText` (mupdf) and writes
 * per-page Obsidian markdown directly — NO rasterization, NO VLM call, NO
 * profile classifier. The doc-level profile defaults to `forcedType ?? "paper"`
 * (text extraction is cheap; we don't need a VLM to pick a prompt). The MOC
 * index note is still written so the vault stays consistent with the vlm path.
 *
 * Page selection (`opts.pages`) mirrors the vlm path's `parsePageSpec`
 * semantics: unselected pages are left `pending` in the manifest (and get no
 * md), selected pages are marked `done`. Resume parity: a page already `done`
 * with its md on disk is skipped on re-runs.
 */
async function runTextExtractBranch(opts: {
  inputAbs: string;
  inputName: string;
  outRoot: string;
  forcedType?: DocProfile;
  pages?: string;
  emit?: (obj: unknown) => void;
  displayPath: (abs: string) => string;
}): Promise<void> {
  const { inputAbs, inputName, outRoot, forcedType, pages, emit, displayPath } = opts;

  // One mupdf open gives us both the total page count and every page's text.
  // (Born-digital text extraction is cheap relative to rasterization, so we
  // don't bother with a separate count-only probe.)
  const extracted = extractPdfText(inputAbs);
  const pageCount = extracted.pageCount;

  const slug = slugify(inputName);
  const layout = layoutFor(outRoot, slug, pageCount);
  ensureLayout(layout);
  console.error(`  kind: pdf  pages: ${pageCount}  slug: ${slug}  (extract: text, no VLM)`);

  // Resolve the page filter (1-indexed) AFTER we know the real page count.
  const only = pages ? parsePageSpec(pages, pageCount) : null;
  if (pages && only && only.size === 0) {
    throw new Error(
      `--pages "${pages}" matched no pages (document has ${pageCount} page(s)). Use 1-indexed ranges like "1,3-5".`,
    );
  }

  // Reuse an existing manifest when it matches (resume parity with the vlm
  // path); otherwise create a fresh one.
  const existing = loadManifest(layout);
  let manifest: Manifest;
  if (existing && existing.pageCount === pageCount) {
    manifest = existing;
  } else {
    manifest = createManifest({
      input: inputAbs,
      inputName,
      kind: "pdf",
      profile: forcedType ?? "paper",
      slug,
      pageCount,
      layout,
    });
  }

  // Text extraction never rasterizes → no PNG exists for any page. Keep the
  // manifest honest by nulling the png field (createManifest had set a path).
  for (const mp of manifest.pages) mp.png = null;

  // Skip the VLM classifier entirely; text mode is profile-agnostic.
  const profile: DocProfile = forcedType ?? "paper";
  manifest.profile = profile;
  writeManifest(layout, manifest);

  for (const page of extracted.pages) {
    const pageNo = page.pageNo;
    if (only && !only.has(pageNo)) continue;

    const mp = manifest.pages[pageNo - 1]!;
    // Resume: a page already done with its md on disk is left as-is.
    if (mp.status === "done" && existsSync(layout.mdAbs(pageNo))) {
      continue;
    }

    const body = page.text ?? "";
    const md = ["---", `title: ${inputName}`, `page: ${pageNo}`, "kind: text", "---", "", body].join("\n");
    writeFileSync(layout.mdAbs(pageNo), md + "\n", "utf8");

    mp.status = "done" as PageStatus;
    delete mp.error;
    writeManifest(layout, manifest);

    console.error(`  [${pageNo}/${pageCount}] text extracted (${body.length} chars)`);
    emit?.({ type: "page", slug, page: pageNo, status: "done", chars: body.length });
  }

  writeIndexNote(layout, manifest, profile, process.cwd());
  console.error(`  ✓ ${slug}: manifest + index written → ${displayPath(layout.dir)}\n`);
  emit?.({ type: "doc_done", slug, profile, pages: pageCount });
}

/**
 * T6 — `extract: "hybrid"` branch for a single born-digital PDF.
 *
 * Best of both worlds: mupdf extracts the body text for EVERY page (cheap,
 * faithful for born-digital prose), and a text-as-prior VLM call
 * (`describeFigureWithPrior`) annotates ONLY figure-bearing pages — those a
 * text-density heuristic flags (pdfimages returns nothing for vector figures,
 * so density is the cheapest reliable signal). The VLM never restates the
 * body; it describes figures + renders equations, using the extracted text as
 * PRIOR ground truth.
 *
 * Like the text branch: no profile classifier (profile = forcedType ??
 * "paper"), the MOC index note is still written, and resume parity holds (a
 * page already `done` with its md on disk is skipped). Unlike the text branch,
 * figure pages ARE rasterized (on demand, one page at a time) so the VLM has a
 * PNG to look at, and the manifest records their png path; text-only pages get
 * no PNG (png nulled) since they were never rasterized.
 */
async function runHybridExtractBranch(opts: {
  inputAbs: string;
  inputName: string;
  outRoot: string;
  forcedType?: DocProfile;
  pages?: string;
  dpi: number;
  llm: ResolvedLLM;
  emit?: (obj: unknown) => void;
  displayPath: (abs: string) => string;
}): Promise<void> {
  const { inputAbs, inputName, outRoot, forcedType, pages, dpi, llm, emit, displayPath } = opts;

  // One mupdf open gives us page count + every page's text. We extract ALL
  // pages (no `only` filter here) so detectFigurePages has a stable median
  // baseline; the page-selection filter is applied in the write loop. Figures
  // (vector or raster) are NOT in the text layer — that is the VLM's job below.
  const extracted = extractPdfText(inputAbs);
  const pageCount = extracted.pageCount;

  const slug = slugify(inputName);
  const layout = layoutFor(outRoot, slug, pageCount);
  ensureLayout(layout);
  console.error(`  kind: pdf  pages: ${pageCount}  slug: ${slug}  (extract: hybrid, text + VLM for figures)`);

  const only = pages ? parsePageSpec(pages, pageCount) : null;
  if (pages && only && only.size === 0) {
    throw new Error(
      `--pages "${pages}" matched no pages (document has ${pageCount} page(s)). Use 1-indexed ranges like "1,3-5".`,
    );
  }

  // Reuse an existing manifest when it matches (resume parity); else fresh.
  const existing = loadManifest(layout);
  let manifest: Manifest;
  if (existing && existing.pageCount === pageCount) {
    manifest = existing;
  } else {
    manifest = createManifest({
      input: inputAbs,
      inputName,
      kind: "pdf",
      profile: forcedType ?? "paper",
      slug,
      pageCount,
      layout,
    });
  }

  // Figure pages are rasterized on demand; text-only pages get no PNG. Start
  // every page honest (null) and fill in the png path as we rasterize figures.
  for (const mp of manifest.pages) mp.png = null;

  // Skip the VLM classifier — text-as-prior mode is profile-agnostic (like the
  // text branch). The doc-level profile just labels the MOC note.
  const profile: DocProfile = forcedType ?? "paper";
  manifest.profile = profile;
  writeManifest(layout, manifest);

  // Figure-bearing pages via text-density heuristic, computed over ALL pages
  // (stable median baseline, independent of the --pages selection).
  const figurePages = detectFigurePages(extracted.pages);

  for (const page of extracted.pages) {
    const pageNo = page.pageNo;
    if (only && !only.has(pageNo)) continue;

    const mp = manifest.pages[pageNo - 1]!;
    // Resume: a page already done with its md on disk is left as-is.
    if (mp.status === "done" && existsSync(layout.mdAbs(pageNo))) {
      continue;
    }

    const priorText = page.text ?? "";
    let body = priorText;
    let kind: "text" | "hybrid" = "text";

    if (figurePages.has(pageNo)) {
      kind = "hybrid";
      // Rasterize JUST this figure page into its canonical pages/ slot. Both
      // real backends name it page-NNN.png (NNN = global page index, padded to
      // max(3, pageCount width)), matching layout.pngAbs(pageNo).
      await rasterizePdf(inputAbs, layout.pagesDir, {
        fromPage: pageNo,
        toPage: pageNo,
        dpi,
      });
      const pngAbs = layout.pngAbs(pageNo);
      mp.png = layout.pngRel(pageNo);

      console.error(`  [${pageNo}/${pageCount}] figure page → VLM (text-as-prior)…`);
      const t0 = Date.now();
      const r = await describeFigureWithPrior(llm, {
        imageAbs: pngAbs,
        priorText,
        pageNo,
        mimeType: "image/png",
      });
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      if (r.ok && r.markdown) {
        body += `\n\n### Figures & equations (via VLM)\n${r.markdown}`;
        console.error(`  [${pageNo}/${pageCount}] figure annotated (${dt}s, +${r.markdown.length} chars)`);
      } else {
        // VLM failure is non-fatal — the text body is still written so the
        // page isn't lost. The page is marked done (text succeeded); the
        // figure annotation is simply absent from the md.
        console.error(
          `  [${pageNo}/${pageCount}] figure VLM failed: ${r.error ?? "unknown"} (text body still written)`,
        );
      }
    }

    const md = ["---", `title: ${inputName}`, `page: ${pageNo}`, `kind: ${kind}`, "---", "", body].join("\n");
    writeFileSync(layout.mdAbs(pageNo), md + "\n", "utf8");

    mp.status = "done" as PageStatus;
    delete mp.error;
    writeManifest(layout, manifest);

    console.error(`  [${pageNo}/${pageCount}] hybrid extracted (${body.length} chars)`);
    emit?.({ type: "page", slug, page: pageNo, status: "done", chars: body.length });
  }

  writeIndexNote(layout, manifest, profile, process.cwd());
  console.error(`  ✓ ${slug}: manifest + index written → ${displayPath(layout.dir)}\n`);
  emit?.({ type: "doc_done", slug, profile, pages: pageCount });
}

/**
 * Run the full file2md pipeline for one or more input documents.
 *
 * This is the shared implementation used by both the CLI command wrapper and
 * the pi extension tool.
 */
export async function runVlmDescribePipeline(opts: VlmDescribePipelineOpts): Promise<void> {
  const { inputs, forcedType, pages, emit, relpath = false } = opts;

  // T5 — extraction strategy. `vlm` (default) runs the existing rasterize +
  // VLM path byte-for-byte; `text` short-circuits PDFs through mupdf's text
  // layer (no rasterize, no VLM); `hybrid` runs mupdf text for the body on
  // every page plus a text-as-prior VLM call on figure-bearing pages only.
  const extract = parseExtractStrategy(opts.extract);
  const concurrency = opts.concurrency ?? Number(process.env.PI_VLM_CONCURRENCY ?? 1);

  if (inputs.length === 0) {
    throw new Error("No input files given.");
  }

  const dpi = opts.dpi ?? 150;
  const cwd = process.cwd();

  // Always resolve outRoot to absolute for file operations; display format is controlled by relpath.
  const outRoot = isAbsolute(opts.outRoot) ? opts.outRoot : resolve(cwd, opts.outRoot);
  const displayPath = (abs: string) => (relpath ? relative(cwd, abs) || abs : abs);

  if (forcedType && !ALL_PROFILES.includes(forcedType)) {
    throw new Error(`Invalid type "${forcedType}". Valid: ${ALL_PROFILES.join(", ")}`);
  }

  // T5-fix — resolve the vision LLM eagerly for vlm/hybrid (byte-for-byte:
  // same call, same site, same throw timing). `extract: "text"` is VLM-free
  // and MUST NOT resolve here: resolveVisionLLM throws "[file2md] No model
  // configured…" when no vision capability / PI_MODEL is set — exactly the
  // users text mode exists for. `llm` stays undefined for text mode; the text
  // branch `continue`s before any vlm call site, so `llm!` there is always
  // defined in practice (the text path never reaches them).
  let llm: ResolvedLLM | undefined;
  let label = "";
  if (extract !== "text") {
    llm = resolveVisionLLM({
      model: opts.model,
      provider: opts.provider,
      thinking: opts.thinking,
    });
    label = `${llm.provider}/${llm.modelId}`;
  }
  console.error(`file2md`);
  if (extract !== "text") {
    console.error(`  model: ${label}  thinking: ${llm!.thinkingLevel}`);
  }
  console.error(`  out:   ${displayPath(outRoot)}`);
  console.error(`  dpi:   ${dpi}`);
  if (pages) console.error(`  pages: ${pages}`);
  if (forcedType) console.error(`  type:  ${forcedType} (forced, skip classifier)`);
  if (extract !== "vlm") console.error(`  extract: ${extract}`);
  if (concurrency > 1) console.error(`  concurrency: ${concurrency} (cross-page context off)`);
  console.error();

  for (const input of inputs) {
    const inputAbs = isAbsolute(input) ? input : resolve(cwd, input);
    console.error(`▶ ${displayPath(inputAbs)}`);

    // T5 — `extract: "text"` fast path for born-digital PDFs: pull the text
    // layer via mupdf and write per-page md directly, with NO rasterization
    // and NO VLM call. Branch BEFORE prepareDoc so rasterizePdf is never
    // invoked (prepareDoc classifies AND rasterizes in one step; we only need
    // the cheap classifyKind sniff here). Images and every other strategy
    // (vlm/hybrid) fall through to the existing path unchanged.
    if (extract === "text") {
      const peek = classifyKind(inputAbs);
      if (peek.kind === "pdf") {
        await runTextExtractBranch({
          inputAbs,
          inputName: basename(inputAbs),
          outRoot,
          forcedType,
          pages,
          emit,
          displayPath,
        });
        continue;
      }
      // image / unknown with extract=text → fall through to the vlm path
      // (extract only applies to PDFs).
    }

    // T6 — `extract: "hybrid"` path for born-digital PDFs: mupdf text for the
    // body on every page + a text-as-prior VLM call (`describeFigureWithPrior`)
    // on figure-bearing pages only (detected via text density). Branch BEFORE
    // prepareDoc (same rationale as the text branch: we rasterize figure pages
    // on demand ourselves, so we never want prepareDoc's full-doc rasterize).
    // Images and every other strategy (vlm) fall through unchanged.
    if (extract === "hybrid") {
      const peek = classifyKind(inputAbs);
      if (peek.kind === "pdf") {
        await runHybridExtractBranch({
          inputAbs,
          inputName: basename(inputAbs),
          outRoot,
          forcedType,
          pages,
          dpi,
          llm: llm!,
          emit,
          displayPath,
        });
        continue;
      }
      // image / unknown with extract=hybrid → fall through to the vlm path
      // (hybrid only applies to PDFs).
    }

    const doc = await prepareDoc(inputAbs, outRoot, dpi);
    console.error(`  kind: ${doc.kind}  pages: ${doc.pageCount}  slug: ${doc.slug}`);

    const existing = loadManifest(doc.layout);
    let manifest: Manifest;
    if (existing && existing.pageCount === doc.pageCount) {
      manifest = existing;
    } else {
      manifest = createManifest({
        input: inputAbs,
        inputName: doc.inputName,
        kind: doc.kind,
        profile: forcedType ?? "image",
        slug: doc.slug,
        pageCount: doc.pageCount,
        layout: doc.layout,
      });
    }

    const alreadyProcessed = !!(existing && existing.pages.some((p) => p.status === "done"));
    let profile: DocProfile;
    if (forcedType) {
      profile = forcedType;
      manifest.profile = profile;
    } else if (alreadyProcessed && existing!.profile) {
      profile = existing!.profile as DocProfile;
      manifest.profile = profile;
      console.error(`  profile: ${profile} (reused from existing run)`);
    } else {
      const page1Png = doc.pagePngs[0]!;
      // S4 — sample up to 3 representative pages (first / middle / last) and
      // majority-vote, so a atypical cover page can't misclassify the whole doc.
      const sampleIdx =
        doc.pageCount <= 1 ? [0] : doc.pageCount === 2 ? [0, 1] : [0, Math.floor(doc.pageCount / 2), doc.pageCount - 1];
      const samplePngs = sampleIdx.map((i) => doc.pagePngs[i]!);
      console.error(
        `  classifying profile via VLM (${samplePngs.length} sampled page${samplePngs.length > 1 ? "s" : ""})…`,
      );
      try {
        const { profile: p, replies } = await classifyProfileFromPages(
          samplePngs.map((p) => ({ path: p, mimeType: "image/png" })),
          llm!,
        );
        profile = p;
        manifest.profile = profile;
        console.error(`  → profile: ${profile}  (votes: ${replies.join(" / ")})`);
        emit?.({ type: "classify", slug: doc.slug, profile, reply: replies.join(" / ") });
      } catch (e: any) {
        console.error(`  ! classifier failed: ${e?.message}; defaulting to paper`);
        profile = doc.kind === "pdf" ? "paper" : "image";
        manifest.profile = profile;
      }
    }
    writeManifest(doc.layout, manifest);

    const only = pages ? parsePageSpec(pages, doc.pageCount) : null;
    if (pages && only && only.size === 0) {
      throw new Error(
        `--pages "${pages}" matched no pages (document has ${doc.pageCount} page(s)). Use 1-indexed ranges like "1,3-5".`,
      );
    }

    // S1 — rolling cross-page context (serial mode only; see concurrency note).
    const pageContext = new PageContext();

    // Extract ONE page's extraction into a closure shared by serial + parallel
    // modes. Returns {ok, markdown} so the serial coordinator can feed the
    // rolling context. writeManifest is synchronous, so concurrent calls are
    // safe under the single-threaded event loop (no mutex needed).
    const runPage = async (
      pageNo: number,
      priorContext: string | undefined,
    ): Promise<{ ok: boolean; markdown: string }> => {
      const i = pageNo - 1;
      const mp = manifest.pages[i]!;
      if (mp.status === "done" && existsSync(doc.layout.mdAbs(pageNo))) {
        return { ok: true, markdown: "" };
      }

      const pngAbs = doc.pagePngs[i]!;
      const pngLinkName = basename(pngAbs);
      const mt = imageMimeType({ kind: doc.kind, path: inputAbs });

      mp.status = "in_progress";
      writeManifest(doc.layout, manifest);

      console.error(`  [${pageNo}/${doc.pageCount}] explaining…`);
      const t0 = Date.now();
      let res: ExplainResult;
      try {
        res = await withRetry(
          async () => {
            const r = await explainPage(llm!, profile, {
              imageAbs: pngAbs,
              mimeType: mt,
              pngLinkName,
              docSlug: doc.slug,
              pageNo,
              pageCount: doc.pageCount,
              priorContext,
              lang: opts.lang,
              mode: opts.mode,
            });
            if (!r.ok) throw new Error(r.error ?? "unknown error");
            // S2 — output quality gate; gate failure is retryable.
            const validation = validatePageMarkdown(r.markdown, { page: pageNo, kind: profile });
            if (!validation.ok) throw retryableError(`gate: ${validation.reason}`);
            return r;
          },
          {
            maxRetries: defaultRetries(),
            retryWaitMs: defaultRetryWaitMs(),
            onRetry: ({ attempt, maxRetries: mx, waitMs: w }) =>
              console.error(
                `  [${pageNo}/${doc.pageCount}] 429/transient — 等待 ${Math.round(w / 1000)}s 後重試 (${attempt}/${mx})`,
              ),
          },
        );
      } catch (err) {
        res = { ok: false, markdown: "", error: (err as Error)?.message ?? String(err) };
      }
      const dt = ((Date.now() - t0) / 1000).toFixed(1);

      if (res.ok && res.markdown) {
        writeFileSync(doc.layout.mdAbs(pageNo), res.markdown + "\n", "utf8");
        mp.status = "done" as PageStatus;
        delete mp.error;
        console.error(`  [${pageNo}/${doc.pageCount}] done (${dt}s, ${res.markdown.length} chars)`);
        emit?.({ type: "page", slug: doc.slug, page: pageNo, status: "done", chars: res.markdown.length });
      } else {
        mp.status = "error" as PageStatus;
        mp.error = res.error ?? "unknown error";
        console.error(`  [${pageNo}/${doc.pageCount}] ERROR: ${mp.error}`);
        emit?.({ type: "page", slug: doc.slug, page: pageNo, status: "error", error: mp.error });
      }
      writeManifest(doc.layout, manifest);
      return { ok: !!(res.ok && res.markdown), markdown: res.markdown ?? "" };
    };

    if (concurrency <= 1) {
      // Serial: full S1 cross-page context (page N sees pages 1..N-1).
      for (let i = 0; i < doc.pageCount; i++) {
        const pageNo = i + 1;
        if (only && !only.has(pageNo)) continue;
        const priorContext = formatContext(pageContext.snapshot());
        const r = await runPage(pageNo, priorContext);
        if (r.ok && r.markdown) pageContext.feed(r.markdown);
      }
    } else {
      // Parallel (T2): bounded pool. Cross-page context is disabled — S1's
      // rolling context needs strict page order, incompatible with parallelism.
      // Pages run independently (speed mode for remote / multi-slot providers;
      // local LM Studio typically single-slots, hence default concurrency 1).
      const pageNos: number[] = [];
      for (let i = 0; i < doc.pageCount; i++) {
        const p = i + 1;
        if (only && !only.has(p)) continue;
        pageNos.push(p);
      }
      await runPool(pageNos, concurrency, (pageNo) => runPage(pageNo, undefined));
    }

    writeIndexNote(doc.layout, manifest, profile, cwd);
    console.error(`  ✓ ${doc.slug}: manifest + index written → ${displayPath(doc.layout.dir)}\n`);
    emit?.({ type: "doc_done", slug: doc.slug, profile, pages: doc.pageCount });
  }

  console.error("--- file2md done ---");
}
