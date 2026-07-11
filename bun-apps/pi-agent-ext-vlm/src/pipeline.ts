/**
 * Core vlm-describe pipeline: classify → rasterize → VLM extract → manifest.
 *
 * Extracted from bun-pi-agent-cli so both the CLI (thin wrapper) and the
 * pi extension (vlm_describe tool) share the same implementation.
 */
import { copyFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute, basename } from "node:path";
import { rasterizePdf } from "./native/pdf2png.ts";
import {
  classifyKind,
  imageMimeType,
  ALL_PROFILES,
  type DocKind,
  type DocProfile,
} from "./vlm/classify.ts";
import { classifyProfileViaVlm } from "./vlm/classify-vlm.ts";
import { explainPage, type ExplainMode } from "./vlm/agents.ts";
import { withRetry, retryableError } from "./vlm/retry.ts";
import { validatePageMarkdown } from "./vlm/validate.ts";
import { PageContext, formatContext } from "./vlm/page-context.ts";
import {
  slugify,
  layoutFor,
  ensureLayout,
  createManifest,
  writeManifest,
  loadManifest,
  type DocLayout,
  type Manifest,
  type PageStatus,
} from "./vlm/manifest.ts";
import { resolveLLM, type ResolvedLLM } from "./sessions.ts";

export const DEFAULT_VLM_MODEL = "lm-studio/google/gemma-4-26b-a4b-qat";

const DEFAULT_RETRIES = Number(process.env.PI_VLM_RETRIES ?? 3);
const DEFAULT_RETRY_WAIT_MS = Number(process.env.PI_VLM_RETRY_WAIT_MS ?? 10_000);

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
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
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
async function prepareDoc(
  inputAbs: string,
  outRoot: string,
  dpi: number,
): Promise<PreparedDoc> {
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
function writeIndexNote(
  layout: DocLayout,
  manifest: Manifest,
  profile: DocProfile,
  cwd: string,
): void {
  const relInput = isAbsolute(manifest.input)
    ? relative(cwd, manifest.input)
    : manifest.input;
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
 * Run the full vlm-describe pipeline for one or more input documents.
 *
 * This is the shared implementation used by both the CLI command wrapper and
 * the pi extension tool.
 */
export async function runVlmDescribePipeline(opts: VlmDescribePipelineOpts): Promise<void> {
  const {
    inputs,
    forcedType,
    pages,
    emit,
    relpath = false,
  } = opts;

  const concurrency = opts.concurrency ?? Number(process.env.PI_VLM_CONCURRENCY ?? 1);

  if (inputs.length === 0) {
    throw new Error("No input files given.");
  }

  const dpi = opts.dpi ?? 150;
  const cwd = process.cwd();

  // Always resolve outRoot to absolute for file operations; display format is controlled by relpath.
  const outRoot = isAbsolute(opts.outRoot) ? opts.outRoot : resolve(cwd, opts.outRoot);
  const displayPath = (abs: string) => relpath ? (relative(cwd, abs) || abs) : abs;

  if (forcedType && !ALL_PROFILES.includes(forcedType)) {
    throw new Error(
      `Invalid type "${forcedType}". Valid: ${ALL_PROFILES.join(", ")}`,
    );
  }

  const llm: ResolvedLLM = resolveLLM({
    model: opts.model,
    provider: opts.provider,
    thinking: opts.thinking,
  });
  const label = `${llm.provider}/${llm.modelId}`;
  console.error(`vlm-describe`);
  console.error(`  model: ${label}  thinking: ${llm.thinkingLevel}`);
  console.error(`  out:   ${displayPath(outRoot)}`);
  console.error(`  dpi:   ${dpi}`);
  if (pages) console.error(`  pages: ${pages}`);
  if (forcedType) console.error(`  type:  ${forcedType} (forced, skip classifier)`);
  if (concurrency > 1) console.error(`  concurrency: ${concurrency} (cross-page context off)`);
  console.error();

  for (const input of inputs) {
    const inputAbs = isAbsolute(input) ? input : resolve(cwd, input);
    console.error(`▶ ${displayPath(inputAbs)}`);

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
      console.error(`  classifying profile via VLM (page 1)…`);
      try {
        const { profile: p, reply } = await classifyProfileViaVlm(
          page1Png,
          "image/png",
          llm,
        );
        profile = p;
        manifest.profile = profile;
        console.error(`  → profile: ${profile}${reply ? `  (raw: "${reply.slice(0, 40)}")` : ""}`);
        emit?.({ type: "classify", slug: doc.slug, profile, reply });
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
      let res;
      try {
        res = await withRetry(
          async () => {
            const r = await explainPage(llm, profile, {
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
            maxRetries: DEFAULT_RETRIES,
            retryWaitMs: DEFAULT_RETRY_WAIT_MS,
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

  console.error("--- vlm-describe done ---");
}
