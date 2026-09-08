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
}

export interface SvgRasterResult {
  png: Uint8Array;
  width: number;
  height: number;
}

const PROBE_VIEWPORT = { width: 1024, height: 768 } as const;
/** Never trust a page that claims to be wider/taller than this (runaway layout). */
const ABSURD_EDGE = 16384;

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
async function captureWrapper(htmlPath: string, maxEdge: number): Promise<SvgRasterResult | null> {
  if (!webViewAvailable()) return null;
  // --- probe pass: load + measure ---
  let size: { w: number; h: number } | null = null;
  let probe: Bun.WebView | undefined;
  try {
    probe = new Bun.WebView({ width: PROBE_VIEWPORT.width, height: PROBE_VIEWPORT.height });
    await probe.navigate(`file://${htmlPath}`);
    await waitReady(probe);
    size = await measureContent(probe);
  } catch {
    return null;
  } finally {
    await probe?.close?.();
  }
  if (!size) return null;
  const scale = Math.min(1, maxEdge / Math.max(size.w, size.h));
  const target = {
    w: Math.max(1, Math.ceil(size.w * scale)),
    h: Math.max(1, Math.ceil(size.h * scale)),
  };
  // --- capture pass at the measured size ---
  let view: Bun.WebView | undefined;
  try {
    view = new Bun.WebView({ width: target.w, height: target.h });
    await view.navigate(`file://${htmlPath}`);
    await waitReady(view);
    const shot = await view.screenshot();
    const png = new Uint8Array(await shot.arrayBuffer());
    if (png.byteLength === 0) return null;
    return { png, width: target.w, height: target.h };
  } catch {
    return null;
  } finally {
    await view?.close?.();
  }
}

/** Render a standalone .svg file to PNG bytes. */
export async function renderSvgFileToPng(svgAbs: string, opts: SvgRasterOptions = {}): Promise<SvgRasterResult | null> {
  const maxEdge = opts.maxEdge ?? 1600;
  const work = mkdtempSync(join(tmpdir(), "file2md-svg-"));
  try {
    const htmlPath = join(work, "wrap.html");
    const esc = svgAbs.replace(/"/g, "&quot;");
    writeFileSync(htmlPath, wrapperHtml(`<img src="${esc}">`), "utf8");
    return await captureWrapper(htmlPath, maxEdge);
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
  const work = mkdtempSync(join(tmpdir(), "file2md-svgfrag-"));
  try {
    const htmlPath = join(work, "wrap.html");
    // An inline fragment becomes a document at file:// origin — strip script
    // blocks so authored-once svg can't execute in our renderer (the <img>
    // form used for whole files is sandboxed by the image loader instead).
    const safe = svgText.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
    writeFileSync(htmlPath, wrapperHtml(safe), "utf8");
    return await captureWrapper(htmlPath, maxEdge);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
