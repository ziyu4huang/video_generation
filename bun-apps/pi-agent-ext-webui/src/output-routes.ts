/**
 * output-routes.ts — the /output serving port (spec Component 5, CORRECTED
 * premise: #1274 was planning-only — this route is NEW, not a port).
 *
 * Lean reimplementation of the #02 serving contract from
 * gui-movie-director/api/gallery.ts `handleGalleryImage` (~L300): MIME
 * allowlist, X-Content-Type-Options: nosniff on EVERY response (closes the
 * stored-XSS vector where an evil.png whose bytes are HTML/SVG gets
 * content-sniffed in the loopback origin), path-traversal containment with the
 * TRAILING separator, and a uniform 404 that never leaks existence.
 *
 * Deltas vs the reference (deliberate, v1 lean):
 *  - NO ETag / Range / 304 (future polish — lift gallery.ts's
 *    Bun.hash(mtime:size) ETag + bytes= slicing if video scrubbing needs it).
 *  - Single output dir; the leading /output/{int}/ segment is IGNORED (parsed
 *    and dropped) so the presentation convention /output/0/<rel> stays stable
 *    if multiple dirs ever arrive. Plain /output/<rel> also serves.
 *
 * Dir resolution (documented divergence from run.py config.py:189-191):
 *  - run.py anchors relative paths to REPO_DIR (the pipeline dir), making it
 *    cwd-independent. webui is an EMBEDDED bun-apps extension with NO
 *    repo-root guarantee, so we anchor to process.cwd() — the natural Bun
 *    package convention. Priority: explicit opts.dir (tests / deps) → env
 *    MLX_OUTPUT_DIR → default ../video_generation__output (same default as
 *    config.py). Absolute values pass through untouched.
 */
import { statSync } from "node:fs";
import * as path from "node:path";
import type { Server } from "bun";

/** Same handler shape as WebServer's HttpRouteHandler seam. */
export type OutputRouteHandler = (
  req: Request,
  srv: Server<undefined>
) => Response | null;

/** Options for {@link createOutputRoutes}. `dir` overrides env+default (tests). */
export interface OutputRouteOptions {
  dir?: string;
}

// MIME allowlist — mirrors gallery.ts GALLERY_MIME exactly (every media type
// the output store can hold). Unknown extensions fall through to
// application/octet-stream (forced download, never sniffed).
const OUTPUT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
};

/** Same default as run.py (config.py:189): sibling of the repo. */
const DEFAULT_OUTPUT_DIR = "../video_generation__output";

/**
 * Resolve the output dir: `explicit` → env MLX_OUTPUT_DIR → default. Absolute
 * as-is; relative anchored to process.cwd() (see file header for the run.py
 * divergence rationale). Exported so tests/docs can assert the resolution.
 */
export function resolveOutputDir(explicit?: string): string {
  const raw = explicit ?? process.env.MLX_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

/** Uniform 404 — containment failure and missing file are indistinguishable. */
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
    },
  });
}

/**
 * Build the /output route handler. Returns null for non-GET / non-/output
 * requests so the wiring chain falls through to the WebServer defaults.
 */
export function createOutputRoutes(opts: OutputRouteOptions = {}): OutputRouteHandler {
  const dir = resolveOutputDir(opts.dir);
  // Containment anchor MUST carry the trailing separator (gallery.ts comment):
  // a bare startsWith lets a sibling named "<dir>something" slip through.
  const resolvedDir = path.resolve(dir) + path.sep;
  return (req) => {
    const url = new URL(req.url);
    if (req.method !== "GET" || !url.pathname.startsWith("/output/")) return null;

    // Decode AFTER the prefix strip — %2F/%2e encodings reach our decoder even
    // though the URL parser pre-normalizes literal ".." segments. Malformed
    // %-sequences (e.g. /output/%FF) throw URIError -> uniform 404, never 500.
    let rest: string;
    try {
      rest = decodeURIComponent(url.pathname.slice("/output/".length));
    } catch {
      return notFound();
    }
    // Embedded NUL bytes (e.g. /output/%00.png) make statSync throw — reject
    // before touching the filesystem, same uniform 404.
    if (rest.includes("\0")) return notFound();
    // Drop an optional leading integer dir-index segment ("0/") — single output
    // dir in v1; the segment is parsed and ignored (mapped to that one dir).
    const slash = rest.indexOf("/");
    if (slash !== -1 && /^\d+$/.test(rest.slice(0, slash))) {
      rest = rest.slice(slash + 1);
    }
    if (rest === "") return notFound();

    const filePath = path.normalize(path.join(dir, rest));
    if (!filePath.startsWith(resolvedDir)) return notFound(); // escape -> 404
    const stat = statSync(filePath, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return notFound(); // missing/dir -> 404

    return new Response(Bun.file(filePath), {
      headers: {
        "Content-Type":
          OUTPUT_MIME[path.extname(filePath).toLowerCase()] ??
          "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      },
    });
  };
}
