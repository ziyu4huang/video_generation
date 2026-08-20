/**
 * thumbnails.ts — slide-rail thumbnails for a persisted deck (ticket 10).
 *
 * ## Why this lives in archify and not in webui
 *
 * A thumbnail needs a rendering engine. webui currently has NO runtime
 * rendering dependency at all — it serves files and frames — and adding one so
 * it can screenshot artifacts would change that posture for a visual nicety.
 * archify already owns the slide files and already uses `Bun.WebView` in its
 * tests, so it generates the images beside the slides and simply names them in
 * the `webui:deck` payload. webui serves them through the `/files` route it
 * already has: no new route, no engine, no new security surface.
 *
 * ## Cost, and why this is still opt-in
 *
 * Each thumbnail is a real page load. Measured 2026-08-21: the five-slide
 * example deck built its slides AND all five thumbnails in **1.3 s total** —
 * cheaper than the "several seconds" this was first estimated at, because the
 * engine starts once and is reused across slides.
 *
 * Still off by default: it is pure waste when you only want a .pptx, and the
 * cost scales with deck size. `--thumbnails` / `thumbnails: true` opts in.
 *
 * Best-effort throughout: any failure yields `null` for that slide and the rail
 * falls back to titles. A deck build must never fail because a picture did not.
 */
import { statSync } from "node:fs";
import { join } from "node:path";

export interface ThumbnailOptions {
  /** Longest edge of the generated image, in pixels. */
  width?: number;
  /** WebP quality, 1-100. */
  quality?: number;
  /** Viewport used to render the artifact before downscaling. */
  viewport?: { width: number; height: number };
}

const DEFAULTS = {
  width: 480,
  quality: 78,
  viewport: { width: 1280, height: 800 },
} as const;

/** The thumbnail path for a slide: `slide-1.html` → `slide-1.thumb.webp`. */
export function thumbPathFor(htmlPath: string): string {
  return htmlPath.replace(/\.html$/i, "") + ".thumb.webp";
}

/** True when `thumb` exists and is newer than its source. */
function isFresh(htmlPath: string, thumbPath: string): boolean {
  try {
    const src = statSync(htmlPath);
    const out = statSync(thumbPath);
    return out.mtimeMs >= src.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Generate thumbnails for `htmlPaths`, returning one entry per input — the
 * written path, or `null` when generation failed or was skipped.
 *
 * Sequential on purpose: these are page loads of a large document, and running
 * several engines at once on a laptop trades wall-clock for memory pressure
 * during what is already an optional step.
 */
export async function generateThumbnails(
  htmlPaths: string[],
  options: ThumbnailOptions = {}
): Promise<(string | null)[]> {
  const width = options.width ?? DEFAULTS.width;
  const quality = options.quality ?? DEFAULTS.quality;
  const viewport = options.viewport ?? DEFAULTS.viewport;
  const out: (string | null)[] = [];

  let view: Bun.WebView | undefined;
  try {
    for (const htmlPath of htmlPaths) {
      const thumbPath = thumbPathFor(htmlPath);
      if (isFresh(htmlPath, thumbPath)) {
        out.push(thumbPath); // cache hit: the source has not changed
        continue;
      }
      try {
        // Created lazily so a fully-cached deck never starts an engine at all.
        view ??= new Bun.WebView({ width: viewport.width, height: viewport.height });
        await view.navigate(`file://${htmlPath}`);
        // The artifact paints its SVG on load; give the runtime a moment to
        // settle rather than racing it, then capture whatever is there.
        await view.evaluate(
          `(() => new Promise(r => { const t = Date.now(); const tick = () => (document.querySelector('svg') || Date.now() - t > 3000) ? r('ok') : setTimeout(tick, 50); tick(); }))()`
        );
        const shot = await view.screenshot();
        const bytes = new Uint8Array(await shot.arrayBuffer());
        await new Bun.Image(bytes)
          .resize(width, width, { fit: "inside" })
          .webp({ quality })
          .write(thumbPath);
        out.push(thumbPath);
      } catch {
        out.push(null); // best-effort: the rail falls back to titles
      }
    }
  } finally {
    await view?.close?.();
  }
  return out;
}

/** Convenience: thumbnails for every `slide-N.html` in a persisted slides dir. */
export function slideHtmlPaths(slidesDir: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => join(slidesDir, `slide-${i + 1}.html`));
}
