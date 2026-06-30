import fs from "fs";
import path from "path";
import { FRONTEND_DIR } from "../lib/paths";
import { broadcastMessage } from "./ws";

const TEXT_CSS = { "Content-Type": "text/css; charset=utf-8" };

// Bundle state MUST live on globalThis, NOT module scope. Bun's `--hot` reload
// (triggered by any backend file change) re-evaluates this module, which resets
// module-level `let` bindings back to `null`. The hot-reload branch in server.ts
// (line ~80) only calls `reload()` and skips the first-start `buildFrontendBundle()`,
// so a module-local `_bundle` would stay null forever after the first reload → the
// next /frontend/bundle.js request 503s ("Bundle not ready") and the page goes blank.
//
// Persisting on globalThis mirrors server.ts's own _devServer / _devInitialized
// pattern: the already-built bundle survives route swaps without a wasted rebuild.
// See memory `bun-hot-reload-resets-bundle-state`.
declare global {
  var _guiBundle: {
    js: Response | null;
    css: Response | null;
    jsEtag: string;
    cssEtag: string;
  } | undefined;
}

function bundleState() {
  if (!globalThis._guiBundle) {
    globalThis._guiBundle = { js: null, css: null, jsEtag: "", cssEtag: "" };
  }
  return globalThis._guiBundle;
}

async function _doBuild(silent?: boolean): Promise<boolean> {
  const entryPoint = path.join(FRONTEND_DIR, "app.tsx");
  try {
    const result = await Bun.build({
      entrypoints: [entryPoint],
      outdir: "/tmp/gui-movie-director-build",
      target: "browser",
      minify: false,
      splitting: false,
      sourcemap: "external",
      define: { "process.env.NODE_ENV": JSON.stringify("development") },
      external: [],
    });
    if (result.success && result.outputs.length > 0) {
      const st = bundleState();
      let jsSize = 0;
      let cssSize = 0;
      for (const output of result.outputs) {
        const stat = fs.statSync(output.path);
        const etag = `"${Bun.hash(`${stat.mtimeMs}:${stat.size}`).toString(16)}"`;
        if (output.path.endsWith(".css")) {
          st.cssEtag = etag;
          st.css = new Response(output, {
            headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache", ETag: etag },
          });
          cssSize = output.size;
        } else if (output.path.endsWith(".js")) {
          st.jsEtag = etag;
          st.js = new Response(output, {
            headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache", ETag: etag },
          });
          jsSize = output.size;
        }
      }
      if (!silent) console.log(`📦 Frontend bundled: JS ${Math.round(jsSize / 1024)}KB${cssSize ? ` + CSS ${Math.round(cssSize / 1024)}KB` : ""}`);
      return true;
    } else {
      console.error("Bundle errors:", result.logs);
      const errors = result.logs
        .filter((l) => l.level === "error")
        .map((l) => ({
          message: l.message,
          file: (l as any).position?.file ?? "",
          line: (l as any).position?.line ?? 0,
          col: (l as any).position?.column ?? 0,
        }));
      if (errors.length) broadcastMessage({ type: "hmr-error", errors });
      return false;
    }
  } catch (err) {
    console.error("Bundle failed:", err);
    return false;
  }
}

export async function buildFrontendBundle(): Promise<void> {
  await _doBuild();
}

export async function rebuildFrontendBundle(): Promise<boolean> {
  return _doBuild(true);
}

export function serveBundleJs(req: Request): Response | null {
  const st = bundleState();
  if (!st.js) return null;
  if (req.headers.get("If-None-Match") === st.jsEtag)
    return new Response(null, { status: 304, headers: { ETag: st.jsEtag } });
  return st.js.clone();
}

export function serveBundleCss(req: Request): Response {
  const st = bundleState();
  if (!st.css) return new Response("", { status: 200, headers: TEXT_CSS });
  if (req.headers.get("If-None-Match") === st.cssEtag)
    return new Response(null, { status: 304, headers: { ETag: st.cssEtag } });
  return st.css.clone();
}
