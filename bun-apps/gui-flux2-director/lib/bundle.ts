/**
 * bundle.ts — build the React frontend with Bun.build and cache the Responses.
 *
 * Bundle state MUST live on globalThis, NOT module scope: Bun's `--hot` reload
 * re-evaluates this module and would reset module-level `let` bindings to
 * null, while server.ts's hot-reload branch skips the initial build — the next
 * /bundle.js request would 503 and the page goes blank (same failure mode
 * documented in gui-movie-director's api/bundle.ts).
 */
import fs from "fs";
import path from "path";

import { PKG_DIR } from "./paths";

const FRONTEND_DIR = path.join(PKG_DIR, "frontend");
const OUT_DIR = "/tmp/gui-flux2-director-build";

interface BundleState {
  js: Response | null;
  css: Response | null;
  jsEtag: string;
  cssEtag: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __flux2GuiBundle: BundleState | undefined;
}

function state(): BundleState {
  globalThis.__flux2GuiBundle ??= { js: null, css: null, jsEtag: "", cssEtag: "" };
  return globalThis.__flux2GuiBundle;
}

export async function buildFrontendBundle(): Promise<boolean> {
  const entryPoint = path.join(FRONTEND_DIR, "main.tsx");
  try {
    const result = await Bun.build({
      entrypoints: [entryPoint],
      outdir: OUT_DIR,
      target: "browser",
      minify: false,
      splitting: false,
      sourcemap: "external",
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
    });
    if (!result.success || result.outputs.length === 0) {
      const errText = result.logs.map((l) => String(l)).join("\n");
      console.error("[bundle] build failed:", errText);
      return false;
    }
    const st = state();
    for (const output of result.outputs) {
      const stat = fs.statSync(output.path);
      const etag = `"${Bun.hash(`${stat.mtimeMs}:${stat.size}`).toString(16)}"`;
      if (output.path.endsWith(".css")) {
        st.cssEtag = etag;
        st.css = new Response(output, {
          headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache", ETag: etag },
        });
      } else if (output.path.endsWith(".js")) {
        st.jsEtag = etag;
        st.js = new Response(output, {
          headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache", ETag: etag },
        });
      }
    }
    return st.js !== null;
  } catch (err) {
    console.error("[bundle] build threw:", err);
    return false;
  }
}

function cachedRes(
  cached: Response | null,
  etag: string,
  req: Request,
  contentType: string,
): Response | null {
  if (!cached) return null;
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
  return new Response(cached.body, { headers: cached.headers });
}

/** Serve /bundle.js — 503 with a hint if the first build hasn't finished. */
export function serveBundleJs(req: Request): Response {
  const res = cachedRes(state().js, state().jsEtag, req, "application/javascript");
  return res ?? new Response("Bundle not ready — rebuilding", { status: 503 });
}

/** Serve /bundle.css — may legitimately be empty (no CSS emitted yet). */
export function serveBundleCss(req: Request): Response {
  const res = cachedRes(state().css, state().cssEtag, req, "text/css");
  return res ?? new Response("/* bundle not ready */", { status: 200, headers: { "Content-Type": "text/css" } });
}

/**
 * Cache-busting version for the HTML asset URLs: the current JS etag hex.
 * index.html references /bundle.js?v=<this>, so every rebuild is a BRAND-NEW
 * URL — Safari (which clings to cached assets far harder than Chromium) can
 * never keep serving a stale bundle after a CSS fix.
 */
export function bundleVersion(): string {
  return state().jsEtag.replace(/[^0-9a-f]/g, "") || String(Date.now().toString(16));
}
