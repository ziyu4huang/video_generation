/**
 * file-routes.ts — the /files serving port (spec §4.1, archify-webui-html
 * tickets 01-A/03/06): full-fidelity HTML (inline SVG + the vendored archify
 * JS runtime) served over the loopback webui, opened as a TOP-LEVEL browser
 * tab with scripts allowed — unlike the existing /output route
 * (output-routes.ts), which MIME-blocks .html on purpose.
 *
 * `GET /files/<rootIdx>/<rel…>` indexes the CONFIGURED root allowlist
 * (`deps.fileRoots` → env `WEBUI_FILE_ROOTS`, see webui-config.resolveFileRoots).
 * Fail closed: an empty allowlist (the default) serves nothing but uniform
 * 404s — every request takes the out-of-range-rootIdx branch.
 *
 * Containment mirrors output-routes.ts exactly (TRAILING-separator realpath
 * rule): decode AFTER the prefix strip, NUL reject, path.normalize, then
 * realpathSync BOTH the anchor and the target and require
 * `real.startsWith(realRoot + path.sep)`. Regular files only. Every failure
 * path — out-of-range/non-integer/missing rootIdx, traversal, symlink hop,
 * escape, directory, missing file, malformed %-sequence — is the SAME uniform
 * 404 that never leaks existence.
 *
 * MIME: `.html` → `text/html; charset=utf-8` (served inline, never a forced
 * download); everything else → `application/octet-stream`. EVERY response
 * carries `X-Content-Type-Options: nosniff` (the stored-XSS guard from
 * output-routes) and the CSP sandbox header below.
 *
 * Deliberate fall-through (matches the /output convention): `GET /files`
 * EXACT (no trailing-slash index) and any NON-GET /files request return null
 * from this handler and land on the WebServer's DEFAULT 404 — WITHOUT the
 * CSP sandbox header. That is fine on purpose: those paths can never serve
 * /files bytes (the sandbox header exists to contain SERVED bytes; a
 * bytes-free default 404 needs no containment), so routing them here would
 * change nothing observable. Only requests that can carry /files bytes get
 * the header. No extra routing is added for them.
 */
import { realpathSync, statSync } from "node:fs";
import * as path from "node:path";
import type { Server } from "bun";

/** Same handler shape as WebServer's HttpRouteHandler seam. */
export type FileRouteHandler = (
  req: Request,
  srv: Server<undefined>
) => Response | null;

/** Options for {@link createFileRoutes}. `roots` is the resolved allowlist. */
export interface FileRouteOptions {
  roots?: string[];
}

/**
 * CSP sandbox directive set — VERIFIED against the vendored archify export
 * mechanics (ticket 06: "verify the vendored archify export-menu mechanics and
 * add allow-popups ONLY if required"):
 *
 *  - Downloads (PNG/SVG/WebM/share-card export menu) go through
 *    `download(blob, filename)` in `vendored/assets/template.html` (~L5191):
 *    `URL.createObjectURL(blob)` + a synthetic `<a download>` + `.click()` +
 *    revoke; the WebM path (MediaRecorder → Blob, ~L5644/5837) funnels into
 *    the SAME helper. Blob-URL anchor downloads require `allow-downloads`.
 *  - Popups: there is NO `window.open` / `showModalDialog` anywhere in the
 *    template — the only "popup" strings are `aria-haspopup` ARIA attributes
 *    on in-document menu/dialog panels. → `allow-popups` NOT required.
 *  - Opaque-origin safety: every `localStorage` access in the template is
 *    already try/catch-guarded (the template documents "sandboxed iframes"),
 *    and the runtime performs NO fetch/XHR/WS — so the opaque origin a
 *    sandboxed document gets can never reach `/api` or the WS endpoint.
 *
 * Settled: `sandbox allow-scripts allow-downloads`.
 */
const FILES_CSP = "sandbox allow-scripts allow-downloads";

/** Uniform 404 — containment failure and missing file are indistinguishable. */
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-cache",
      // Same sandbox on error responses: any /files-served bytes stay opaque.
      "Content-Security-Policy": FILES_CSP,
    },
  });
}

/** A regular file located under one of the configured roots. */
export interface FileLocation {
  /** Index into the roots array (the /files/<rootIdx>/ URL segment). */
  rootIdx: number;
  /** Root-relative path (URL path under /files/<rootIdx>/). */
  rel: string;
  /** The realpath'd absolute file path (the servable bytes). */
  real: string;
}

/**
 * Shared containment core (spec §4.2: the `webui:open` handler validates with
 * the SAME check as the route). Resolves `target` (absolute, or relative to
 * cwd) → realpathSync → must be a REGULAR file strictly INSIDE one of the
 * realpath'd roots (trailing-separator rule — a root named "<root>x" never
 * matches). Returns the winner + its root-relative URL path, or null.
 * Per-call (no anchor caching): the route wants per-request re-checks anyway
 * (a symlink INSIDE a root must never widen between requests) and the roots
 * arrays are tiny (loopback tool surface).
 */
export function locateFileInRoots(roots: string[], target: string): FileLocation | null {
  const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  let real: string;
  try {
    real = realpathSync(path.normalize(abs));
  } catch {
    return null; // missing / broken link / unreadable -> not locatable
  }
  const stat = statSync(real, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) return null; // directories/devices never serve
  for (let i = 0; i < roots.length; i++) {
    let rootReal: string;
    try {
      rootReal = realpathSync(path.resolve(roots[i]!));
    } catch {
      continue; // root missing/unreadable — it simply cannot contain anything
    }
    if (!real.startsWith(rootReal + path.sep)) continue; // trailing-sep rule
    return { rootIdx: i, rel: path.relative(rootReal, real), real };
  }
  return null;
}

/**
 * Build the /files route handler. Returns null for non-GET / non-/files
 * requests so the wiring chain falls through (registered AFTER render routes,
 * BEFORE output routes — spec §4.1 registration order).
 */
export function createFileRoutes(opts: FileRouteOptions = {}): FileRouteHandler {
  const roots = opts.roots ?? [];
  return (req) => {
    const url = new URL(req.url);
    if (req.method !== "GET" || !url.pathname.startsWith("/files/")) return null;

    // Decode AFTER the prefix strip — %2F/%2e encodings reach our decoder even
    // though the URL parser pre-normalizes literal ".." segments. Malformed
    // %-sequences throw URIError -> uniform 404, never 500 (output-routes rule).
    let rest: string;
    try {
      rest = decodeURIComponent(url.pathname.slice("/files/".length));
    } catch {
      return notFound();
    }
    // Embedded NUL bytes make statSync/realpathSync throw — reject before
    // touching the filesystem (output-routes rule).
    if (rest.includes("\0")) return notFound();

    // Leading integer segment = rootIdx — REQUIRED (unlike /output, where the
    // {int}/ is optional: /files indexes a MULTI-root allowlist, so a missing
    // index cannot default anywhere). Non-integer/missing/out-of-range (incl.
    // the empty-allowlist case — nothing is ever in range) -> uniform 404.
    const slash = rest.indexOf("/");
    if (slash === -1) return notFound();
    const idxSeg = rest.slice(0, slash);
    if (!/^\d+$/.test(idxSeg)) return notFound();
    const rootIdx = Number(idxSeg);
    if (rootIdx >= roots.length) return notFound();
    rest = rest.slice(slash + 1);
    if (rest === "") return notFound();

    // Containment: join the requested root, then locate via the shared core.
    // A `rel` that normalizes OUT of roots[rootIdx] but happens to land inside
    // a DIFFERENT root is still rejected (rootIdx must round-trip) — the URL
    // space stays a stable bijection rootIdx <-> root.
    const loc = locateFileInRoots(roots, path.join(roots[rootIdx]!, rest));
    if (!loc || loc.rootIdx !== rootIdx) return notFound();

    const isHtml = path.extname(loc.real).toLowerCase() === ".html";
    return new Response(Bun.file(loc.real), {
      headers: {
        "Content-Type": isHtml
          ? "text/html; charset=utf-8"
          : "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
        "Content-Security-Policy": FILES_CSP,
      },
    });
  };
}
