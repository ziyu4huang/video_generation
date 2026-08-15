# zk-spawn findings/state — tickets 06+07 (archify-webui-html) — INCOMPLETE, mid-implementation

> Transient scratch (not committed). Session ran out of budget mid-build. Next implementer: read this, then spec.md + tickets 06/07, and resume.

## Status snapshot

- DONE: `bun-apps/pi-agent-ext-webui/src/webui-config.ts` — added `import * as path from "node:path"` (top, after header doc — verify it landed) + `resolveFileRoots(env?, explicit?)` (wiring `fileRoots` > env `WEBUI_FILE_ROOTS` `:`-split, trim+drop empty segs, relative→abs vs cwd, default `[]`).
- DONE (research): CSP directive decision — see below.
- ABORTED: write of `bun-apps/pi-agent-ext-webui/src/file-routes.ts` (full verbatim draft preserved below).
- NOT STARTED: open-event-handler.ts, webui-wiring.ts wiring, webui tests, archify emitter + tests.

## Verified vendored archify export mechanics (ticket 06 CSP requirement)

- All export/download paths in `vendored/assets/template.html` use the `download(blob, filename)` helper (~L5191): `URL.createObjectURL(blob)` + `<a download>` + `a.click()` + revoke-after-1s. WebM (MediaRecorder ~L5644/5837) and share-card/raster paths funnel into the same helper. → needs `allow-downloads`.
- NO `window.open`/`showModalDialog`/popups anywhere (only `aria-haspopup` ARIA attrs, 6 hits). → `allow-popups` NOT needed.
- All `localStorage` accesses try/catch-guarded; no fetch/XHR/WS in template. Opaque origin safe.
- **SETTLED CSP: `sandbox allow-scripts allow-downloads`** (on EVERY /files response incl. 404s).

## Key design decisions already made

- `file-routes.ts`: `OutputRouteHandler` shape; `GET /files/<rootIdx>/<rel…>`; rootIdx segment REQUIRED `/^\d+$/` (no optional-int like /output — multi-root); out-of-range → 404 (empty roots ⇒ always 404 = fail closed). Decode-after-prefix-strip, NUL reject, `locateFileInRoots(roots, path.join(roots[idx], rel))` must return SAME rootIdx (no cross-root round-trip). MIME: `.html`→`text/html; charset=utf-8`, else octet-stream; nosniff + `Cache-Control: no-cache` + CSP on all responses.
- Shared helper `locateFileInRoots(roots, target): {rootIdx, rel, real} | null` — realpathSync anchor+target, `startsWith(root+path.sep)`, `statSync(...,{throwIfNoEntry:false}).isFile()`. REUSED by open-event-handler (spec: same containment check).
- open-event-handler (`src/open-event-handler.ts`, NOT yet written): handler `(data:unknown)=>void`, validate `{path:string, view?, title?}` (non-string path → ignore + `console.log("[webui] webui:open ignored:", reason)`, never throw); `locateFileInRoots` → miss → ignore; hit → `ui.notify(\`${title ?? path} — open ${server.url}/files/${rootIdx}/${rel}\`)`. Factory `createOpenEventHandler(roots, {getUrl: () => server.url, notify: (m)=>void})` — wiring passes closures reading `server.url` lazily + `bound?.ctx?.ui` (mirror render-event-handler + first-render announce latch pattern; notify via bound ctx so it works after session_start).
- wiring (`webui-wiring.ts`): add `fileRoots?: string[]` to `WebuiDeps`; `const fileRoots = resolveFileRoots(process.env, deps.fileRoots);` near top (after enabled gate); `const fileRoutes = createFileRoutes({ roots: fileRoots });` and insert in the setHttpRoutes chain: btw → render → **file** → output (spec: after render, before output); register `pi.events?.on("webui:open", createOpenEventHandler(...))` alongside `webui:render`/`webui:present` registrations (~L639 area). Guarded `pi.events?.` like existing seams.
- Config tests go in `tests/webui-config.test.ts` (extend): precedence wiring>env>default, `:`-split, empty-string→[], relative resolution.
- file-routes tests: new `tests/file-routes.test.ts` mirroring `tests/output-routes.test.ts` exactly (module-level eager fixtures, `call()` helper, symlink describe w/ `test.skipIf`, uniform-404 matrix: empty roots 404, traversal `%2F`/`..`, NUL, %FF, dir target, out-of-range idx, non-integer idx, missing idx segment; happy: html 200 + CSP + text/html, non-html octet-stream+nosniff, multi-root idx routing, subpaths; fall-through null for non-/files + non-GET).
- open-event tests: new `tests/open-event-handler.test.ts` + consider a wiring-level test (valid→notify contains `/files/`; outside→no notify no throw; malformed payload (null/non-string path)→no throw).

## Archify (ticket 07) plan — NOT started

- `extensions/archify.ts` factory: `const events = (pi as {events?: {emit:(c:string,d:unknown)=>void}}).events;` — note: SDK `ExtensionAPI.events: EventBus` is typed NON-optional; capture directly but access defensively (older hosts). Pass `events` into wrapped tools: register `emitOpenOnSuccess(renderTool, events, makeRenderView)` style wrappers OR extend lib factories: prefer lib-level optional param to keep e2e recorder pattern intact. Simplest safe: build tool in extensions/archify.ts by wrapping `execute`:
  ```ts
  // after success (no isError): events?.emit("webui:open", { path, view, title })
  ```
  - render: `path` = `result.details.path` (outPath); `view` = `basename(outPath)` sans extension (strip LAST ext, i.e. `mini.architecture` from `mini.architecture.html`); `title` = `ir.meta.title ?? diagramType` — but tools don't return meta.title today; lib render has `loaded.meta` + `type`. Cleanest: emit INSIDE `archifyRender`/`archifyDelta` via optional `events` param on RenderCtx/DeltaCtx (mirrors wayfind `makeWayfindEffortTool(events?)` precedent). Renderer title: `loaded.meta.title ?? type` — NOTE load-ir.ts currently only extracts type+metaOutput; title needs `(obj.meta as {title?:string})?.title` — widen IrMeta with `title?: string` (small lib/load-ir.ts change, tests there too).
  - delta: `view: "compare-" + basename(outPath) sans ext` (spec/ticket-04: `compare-<basename>` where basename = the compared artifact's outPath sans .html — outPath default `architecture-delta.html` → `compare-architecture-delta`; ticket06 wording "compared artifact" = the delta OUT file). `title: "architecture-delta"` (no ir.meta for delta; use diagramType const "architecture-delta" per `ir.meta.title ?? diagramType` rule).
  - Emit AFTER success only (`receipt.ok === true && status === 0` for render; `status === 0` for delta). Never throws: wrap emit in try/catch. No webui import — string-literal channel `"webui:open"`.
- Tests: new `__tests__/open-emit.test.ts` — mock bus `{emits: [{channel,data}]}`; render success via `archifyRender({ir: validIr}, {cwd: tmp, events: bus})` → exactly one emit, channel `"webui:open"`, payload asserted AS LITERAL SHAPE `{path: join(tmp,"architecture.html")|fixture mini.html, view:"mini" (fixture authors meta.output mini.html), title:"Mini"}`; delta success → `{view:"compare-architecture-delta", title:"architecture-delta", path:<out>}`; failure (invalid ir / non-architecture type) → no emit; no bus → no throw, result text unchanged (golden vs existing render.test.ts text).
- Gates: `( cd bun-apps/pi-agent-ext-webui && bun run typecheck && bun test )`; `( cd bun-apps/pi-agent-ext-archify && bun run typecheck && bun test --isolate )`. Do NOT commit. Do NOT edit vendored/.

## VERBATIM DRAFT — src/file-routes.ts (write this file as-is, then typecheck)

```ts
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
```

## Reference facts gathered (for wiring/tests)

- webui-wiring.ts route chain (insert file routes between render and output):
  `server.setHttpRoutes((req,srv) => createBtwRoutes({...})(req,srv) ?? renderRoutes(req,srv) ?? outputRoutes(req,srv));`
- Event-handler registrations site: `pi.events?.on("webui:render", createRenderEventHandler(registry, {toImageMarkdown}));` + `webui:present` (~L639).
- MockPi (tests/helpers/mock-pi.ts): has `events` bus, `ctx.ui.notify` recorded into `ctx.notifications`, `registerTool`, `emit()`. FakeWebServer implements WebuiServer with `url = "http://fake.local/"` — good for open-handler wiring test: notify message should contain `http://fake.local//files/...`? NOTE FakeWebServer.url has trailing slash → `${server.url}/files/...` yields double slash; either strip trailing `/` when composing or tolerate in tests. Prefer composing with `server.url.replace(/\/$/,"")` or change fake to "http://fake.local". Decide during wiring-test write.
- Real notify pattern precedent: `ui.notify(\`webui ready — open ${url} in a browser...\`, "info")`.
- wayfind emitter precedent: `makeWayfindEffortTool(events?: EventBus)` + `index.ts` passes `pi.events`; emit sites guarded `events?.emit(...)` + try/catch comments.
- SDK: `EventBus { emit(channel: string, data: unknown): void; on(channel, handler): () => void }` exported from root; `ExtensionAPI.events: EventBus` (non-optional typed, but access defensively anyway); `defineTool` returns `ToolDefinition & AnyToolDefinition`.
- archify tests use `import factory from "../extensions/archify.ts"` + recorder pi (e2e.test.ts `makeRecorderPi`, `ctxFor(cwd)`); fixtures: `__tests__/fixtures/mini.architecture.json` (meta.title "Mini", meta.output "mini.html") and `mini.architecture.v2.json` (delta head). Delta outPath default: `<cwd>/architecture-delta.html` (resolveOutputPath diagramType "architecture-delta").
- archify tsconfig: `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `allowImportingTsExtensions` (imports use `.ts`). webui tsconfig: NodeNext `.js` import specifiers, `rootDir: "src"` (tests excluded from tsc).
- webui package scripts: `typecheck` = `tsc --noEmit`; `test` = `bun test`. archify: `typecheck` = `tsc --noEmit`; gate `bun test --isolate`.
