/**
 * raster/svg.ts — SVG → PNG via Bun's built-in WebView (WebKit), zero new
 * dependencies (effort 2026-09-08-file2md-svg-pptx-vision, ticket 02).
 *
 * Pattern lifted from archify's `src/thumbnails.ts` (measured there
 * 2026-08-21): lazy engine, navigate to a file:// wrapper page, settle on a
 * readiness signal rather than racing the load, then `view.screenshot()`.
 * file2md additions: a white-background wrapper document (a bare SVG
 * screenshot can carry a transparent alpha channel that renders black on
 * dark themes), and a measure-then-resize pass so the capture holds the
 * WHOLE diagram instead of the probe viewport's crop.
 *
 * Best-effort by contract: every failure path returns `null` and the caller
 * degrades to the structural extraction — a conversion never fails because
 * a picture did not (the smart-mode D4 rule, applied to rendering).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Longest captured edge cap (callers pass the pipeline's scale-derived edge). */
export interface SvgRasterOptions {
  maxEdge?: number;
  /**
   * Liveness budget for one WebView pass (navigate → ready → measure/shot).
   * The in-page readiness signal only gates tick scheduling — a
   * never-composited window can stall an evaluate forever — so every pass is
   * raced against this fuse and the race loser degrades to `null`.
   * Default 10 000 ms; tests inject a small value + a stalled fake view.
   */
  livenessMs?: number;
  /** DI seam for tests: construct the view (production always Bun.WebView). */
  createView?: (width: number, height: number) => Bun.WebView;
}

export interface SvgRasterResult {
  png: Uint8Array;
  width: number;
  height: number;
}

/** Default per-pass liveness budget (see SvgRasterOptions.livenessMs). */
export const SVG_LIVENESS_MS = 10_000;

const PROBE_VIEWPORT = { width: 1024, height: 768 } as const;
/** Never trust a page that claims to be wider/taller than this (runaway layout). */
const ABSURD_EDGE = 16384;

/**
 * Reject when `p` outlives `ms` — the caller's catch converts the rejection
 * into the degrade path. The timer is always cleared so a won race never
 * holds the event loop, and a promise that loses the race gets a swallowed
 * catch: a wedged view may reject LATER, and that must never surface as an
 * unhandled rejection.
 */
async function raceLiveness<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fuse = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`webview pass exceeded the ${ms}ms liveness budget`)), ms);
  });
  p.catch(() => {}); // a loser's late rejection is not an error
  try {
    return await Promise.race([p, fuse]);
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort close: a rejecting (or slow) close must not fail the degrade. */
async function closeQuietly(view: Bun.WebView | undefined, livenessMs: number): Promise<void> {
  if (!view?.close) return;
  await raceLiveness(
    Promise.resolve(view.close()).catch(() => {}),
    livenessMs,
  ).catch(() => {});
}

function wrapperHtml(inner: string): string {
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    "<style>",
    "html,body{margin:0;padding:0;background:#fff;overflow:hidden}",
    "img{display:block}",
    "svg{display:block}",
    "</style>",
    inner,
    "",
  ].join("\n");
}

/** True when this runtime has a WebView at all (darwin always; linux needs webkit2gtk). */
function webViewAvailable(): boolean {
  return typeof (Bun as { WebView?: unknown }).WebView === "function";
}

/** Evaluate JS in the page, returning JSON.parse-able output or null. */
async function evaluateJson(view: Bun.WebView, js: string): Promise<unknown | null> {
  try {
    const out = await view.evaluate(js);
    if (typeof out === "string") return JSON.parse(out);
    return out ?? null;
  } catch {
    return null;
  }
}

/** Wait until the page reports an svg (or image) ready, bounded by a timeout. */
async function waitReady(view: Bun.WebView): Promise<void> {
  await view.evaluate(
    `(() => new Promise(r => { const t = Date.now();` +
      ` const ready = () => { const s = document.querySelector('svg'); const i = document.querySelector('img');` +
      ` return (s || (i && i.complete && i.naturalWidth > 0) || Date.now() - t > 3000); };` +
      ` const tick = () => ready() ? requestAnimationFrame(() => r('ok')) : setTimeout(tick, 50); tick(); }))()`,
  );
}

/** Measure the figure element's laid-out size (scrollWidth floors at the viewport). */
async function measureContent(view: Bun.WebView): Promise<{ w: number; h: number } | null> {
  const m = (await evaluateJson(
    view,
    `JSON.stringify((() => { const el = document.querySelector('svg') || document.querySelector('img');` +
      ` if (!el) return { w: 0, h: 0 }; const r = el.getBoundingClientRect();` +
      ` return { w: Math.ceil(r.width), h: Math.ceil(r.height) }; })())`,
  )) as { w?: number; h?: number } | null;
  if (!m || !Number.isFinite(m.w) || !Number.isFinite(m.h)) return null;
  if (m.w! < 1 || m.h! < 1 || m.w! > ABSURD_EDGE || m.h! > ABSURD_EDGE) return null;
  return { w: m.w!, h: m.h! };
}

/**
 * Screenshot a wrapper HTML file at its natural content size, scaled to
 * maxEdge. Two passes: a PROBE view loads the page and measures the content
 * (scrollWidth/Height); a CAPTURE view is then constructed at the measured
 * size so the screenshot holds the whole diagram rather than the probe's
 * crop. Bun.WebView's width/height are constructor-set (not live-resizable
 * in the type surface), hence the second load of the same local file:// URL.
 */
/** Production view factory (DI seam — tests inject a stalled fake). */
const defaultCreateView = (width: number, height: number): Bun.WebView => new Bun.WebView({ width, height });

async function captureWrapper(
  htmlPath: string,
  maxEdge: number,
  livenessMs: number,
  createView: (width: number, height: number) => Bun.WebView,
): Promise<SvgRasterResult | null> {
  if (!webViewAvailable() && createView === defaultCreateView) return null;
  // --- probe pass: load + measure (liveness-fused end to end) ---
  let measured: { w: number; h: number } | null = null;
  let probe: Bun.WebView | undefined;
  try {
    probe = createView(PROBE_VIEWPORT.width, PROBE_VIEWPORT.height);
    measured = await raceLiveness(
      (async () => {
        await probe!.navigate(`file://${htmlPath}`);
        await waitReady(probe!);
        return await measureContent(probe!);
      })(),
      livenessMs,
    );
  } catch {
    return null;
  } finally {
    await closeQuietly(probe, livenessMs);
  }
  if (!measured) return null;
  const scale = Math.min(1, maxEdge / Math.max(measured.w, measured.h));
  const target = {
    w: Math.max(1, Math.ceil(measured.w * scale)),
    h: Math.max(1, Math.ceil(measured.h * scale)),
  };
  // --- capture pass at the measured size (same fuse; the IIFE returns the
  // result through raceLiveness) ---
  let view: Bun.WebView | undefined;
  try {
    view = createView(target.w, target.h);
    return await raceLiveness(
      (async () => {
        await view!.navigate(`file://${htmlPath}`);
        await waitReady(view!);
        const shot = await view!.screenshot();
        const png = new Uint8Array(await shot.arrayBuffer());
        if (png.byteLength === 0) throw new Error("empty screenshot");
        return { png, width: target.w, height: target.h } satisfies SvgRasterResult;
      })(),
      livenessMs,
    );
  } catch {
    return null;
  } finally {
    await closeQuietly(view, livenessMs);
  }
}

/** Render a standalone .svg file to PNG bytes. */
export async function renderSvgFileToPng(svgAbs: string, opts: SvgRasterOptions = {}): Promise<SvgRasterResult | null> {
  const maxEdge = opts.maxEdge ?? 1600;
  const livenessMs = opts.livenessMs ?? SVG_LIVENESS_MS;
  const createView = opts.createView ?? defaultCreateView;
  const work = mkdtempSync(join(tmpdir(), "file2md-svg-"));
  try {
    const htmlPath = join(work, "wrap.html");
    const esc = svgAbs.replace(/"/g, "&quot;");
    writeFileSync(htmlPath, wrapperHtml(`<img src="${esc}">`), "utf8");
    return await captureWrapper(htmlPath, maxEdge, livenessMs, createView);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Render an inline SVG fragment (already-decoded text) to PNG bytes. */
export async function renderSvgTextToPng(
  svgText: string,
  opts: SvgRasterOptions = {},
): Promise<SvgRasterResult | null> {
  const maxEdge = opts.maxEdge ?? 1600;
  const livenessMs = opts.livenessMs ?? SVG_LIVENESS_MS;
  const createView = opts.createView ?? defaultCreateView;
  const work = mkdtempSync(join(tmpdir(), "file2md-svgfrag-"));
  try {
    const htmlPath = join(work, "wrap.html");
    // An inline fragment becomes a document at file:// origin — strip script
    // blocks so authored-once svg can't execute in our renderer (the <img>
    // form used for whole files is sandboxed by the image loader instead).
    const safe = svgText.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
    writeFileSync(htmlPath, wrapperHtml(safe), "utf8");
    return await captureWrapper(htmlPath, maxEdge, livenessMs, createView);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
