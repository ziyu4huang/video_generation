import fs from "fs";
import path from "path";
import { FRONTEND_DIR } from "../lib/paths";
import { broadcastMessage } from "./ws";

const TEXT_CSS = { "Content-Type": "text/css; charset=utf-8" };

let _bundle: Response | null = null;
let _bundleCss: Response | null = null;
let _bundleEtag = "";
let _bundleCssEtag = "";

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
      let jsSize = 0;
      let cssSize = 0;
      for (const output of result.outputs) {
        const stat = fs.statSync(output.path);
        const etag = `"${Bun.hash(`${stat.mtimeMs}:${stat.size}`).toString(16)}"`;
        if (output.path.endsWith(".css")) {
          _bundleCssEtag = etag;
          _bundleCss = new Response(output, {
            headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache", ETag: etag },
          });
          cssSize = output.size;
        } else if (output.path.endsWith(".js")) {
          _bundleEtag = etag;
          _bundle = new Response(output, {
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
  if (!_bundle) return null;
  if (req.headers.get("If-None-Match") === _bundleEtag)
    return new Response(null, { status: 304, headers: { ETag: _bundleEtag } });
  return _bundle.clone();
}

export function serveBundleCss(req: Request): Response {
  if (!_bundleCss) return new Response("", { status: 200, headers: TEXT_CSS });
  if (req.headers.get("If-None-Match") === _bundleCssEtag)
    return new Response(null, { status: 304, headers: { ETag: _bundleCssEtag } });
  return _bundleCss.clone();
}
