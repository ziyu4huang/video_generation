# HITL webui — Phase 4: `/output` serving + image presentation (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the MLX output directory over the webui HTTP seam at `/output/{name}` and give the agent a pure helper + prompt guidance for presenting generated images as `![image](/output/0/<name>)` markdown.

**Architecture:** Two independent deliverables. Task 1 builds `src/output-routes.ts` — a lean reimplementation of the gui-movie-director `handleGalleryImage` serving contract (MIME allowlist, `nosniff`, trailing-separator traversal containment, uniform 404) as a `(req) => Response | null` route factory chained after `createRenderRoutes` in `webui-wiring.ts`. Task 2 builds `src/image-presentation.ts` — pure functions that turn `details.output` / `details.outputs[]` (strings or `{path}` objects) into `/output/0/<rel>` markdown — plus a `webui_present` description edit teaching the pattern. T2 produces URL strings; T1 serves them. They share no code; order T1 → T2 is narrative only (noted for parallel dispatch if ever needed).

**Tech Stack:** TypeScript (strict, NodeNext), Bun runtime (`Bun.file`, `bun test`), node builtins (`node:path`, `node:fs`). No new dependencies.

## Phase context — CORRECTED PREMISE (read first)

The spec (`.planning/2026-08-14-build-hitl-webui/spec.md:19`) says the `/output` serving contract was "**shipped in #1274, SURVIVES the mirror drop**" and Phase 4 would only "port" it. **That premise is wrong: PR #1274 was planning-only — no serving route ever landed.** Phase 4 therefore BUILDS the route + the presentation convention from scratch, using the #02 contract (survivor of the gui-movie-director mirror work) as the reference: `bun-apps/gui-movie-director/api/gallery.ts` `handleGalleryImage` (~L300–L373). We REIMPLEMENT lean (no cross-package import — the webui package has zero today and gains none). Deltas vs the reference, all deliberate and documented inline:

- **No ETag / Range / 304** for v1 (lean; future polish — the reference's `Bun.hash(mtime:size)` ETag + `bytes=` slicing at gallery.ts:324–L360 is the pattern to lift later if browser video scrubbing ever needs it).
- **Single output dir** (env-resolved); the leading `/output/{int}/` URL segment is IGNORED (parsed and dropped, mapped to that one dir), whereas the gallery indexes `OUTPUT_DIRS[]` (gallery.ts:308–L312).
- **404 (not 403)** on containment failure — do not leak file existence.

Open ledger minors from `sdd/progress.md` (`isPayload` view type-guard, `awaitPendingWithAbort` early-abort hardening, `params.mode` cast) are **NOT this phase's scope** — do not fix them opportunistically; they stay ledgered.

## Global Constraints

- Loopback `originAllowed` guard + optional token auth are UNTOUCHED — the new route rides behind them via the existing `setHttpRoutes` seam (web-server.ts `fetch()`: origin guard → token → `/api/logs` → `httpRoutes` → `/health`/`/`/`/ws`).
- Gate: `( cd bun-apps/pi-agent-ext-webui && bun run test )` — i.e. `bunx tsc` build (src/**) THEN `bun test`. Both must pass at every commit.
- Zero cross-package imports: do NOT import anything from `gui-movie-director`; reimplement. Same for `python/` — config.py is reference only.
- No new dependencies (package.json stays as-is).
- `GET /api/logs`, the SSE heartbeat, and the SSE payload shape are untouched.
- All written output (code, comments, commits) in English.
- Commit style: conventional `feat:`/`test:`/`chore:` one-liners, one logical change per commit.

## File Structure

- **Create** `bun-apps/pi-agent-ext-webui/src/output-routes.ts` — the `/output` serving route factory: dir resolution (env/default/injectable), MIME allowlist, containment, uniform 404. One responsibility: serve files under the resolved output dir.
- **Create** `bun-apps/pi-agent-ext-webui/src/image-presentation.ts` — pure path→markdown helpers (`imageMd`, `imageMdFromDetails`). No Bun, no fs — pure string/path logic only.
- **Modify** `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` — chain `createOutputRoutes` after `createRenderRoutes` at the `setHttpRoutes` seam (~L361, locate by `server.setHttpRoutes(createRenderRoutes(registry))`); add `outputDir?: string` to `WebuiDeps`.
- **Modify** `bun-apps/pi-agent-ext-webui/src/present-tool.ts` — description/promptSnippet edit only (no schema change, no execute() change).
- **Create** `bun-apps/pi-agent-ext-webui/tests/output-routes.test.ts` — route-fn matrix + one live-`WebServer` integration test.
- **Create** `bun-apps/pi-agent-ext-webui/tests/image-presentation.test.ts` — pure-function matrix + present-tool description assertion.
- **Modify** `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts` — one added test: the chained seam serves `/output/0/...` via injected `deps.outputDir`.

---

### Task 1: `/output` serving route (`src/output-routes.ts`) + wiring chain

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/output-routes.ts`
- Modify: `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts` (~L361 `server.setHttpRoutes(createRenderRoutes(registry))`; `WebuiDeps` interface ~L130–L142)
- Test: `bun-apps/pi-agent-ext-webui/tests/output-routes.test.ts` (create), `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts` (modify, add one test)

**Interfaces:**
- Consumes: `HttpRouteHandler = (req: Request, srv: Server<undefined>) => Response | null` (web-server.ts ~L105–L110) — the seam `setHttpRoutes` accepts; `RenderRouteHandler` from `render-routes.ts:22` has the same call shape.
- Produces:
  - `createOutputRoutes(opts?: { dir?: string }): (req: Request, srv: Server<undefined>) => Response | null` — returns `null` for non-`GET` or non-`/output/...` paths (fall-through), a `Response` for everything else (200 file or 404).
  - `resolveOutputDir(explicit?: string): string` (exported for tests/docs) — `explicit` → env `MLX_OUTPUT_DIR` → default `"../video_generation__output"`; absolute kept as-is; relative resolved vs `process.cwd()`.
  - `WebuiDeps.outputDir?: string` (new optional dep) — threads into `createOutputRoutes({ dir })`.

- [ ] **Step 1: Write the failing test** — create `bun-apps/pi-agent-ext-webui/tests/output-routes.test.ts`:

```ts
/**
 * output-routes.test.ts — tests for the /output serving port (spec Component 5,
 * CORRECTED premise: #1274 was planning-only; this route is NEW, modeled on the
 * #02 contract in gui-movie-director/api/gallery.ts handleGalleryImage but
 * reimplemented lean — no ETag/Range/304 for v1).
 *
 * Direct route-fn invocation for the matrix (deterministic, no socket) + one
 * live WebServer integration test proving the origin-guarded fetch() path.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createOutputRoutes, resolveOutputDir } from "../src/output-routes.js";
import { WebServer } from "../src/web-server.js";

// --- fixture: tmpRoot/out/{a.png,b.mp4,c.xyz,sub/d.png} + tmpRoot/secret.txt --
let tmpRoot: string;
let outDir: string;
let secretPath: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(path.join(os.tmpdir(), "webui-output-test-"));
  outDir = path.join(tmpRoot, "out");
  mkdirSync(path.join(outDir, "sub"), { recursive: true });
  writeFileSync(path.join(outDir, "a.png"), "PNGDATA");
  writeFileSync(path.join(outDir, "b.mp4"), "MP4DATA");
  writeFileSync(path.join(outDir, "c.xyz"), "XYZDATA");
  writeFileSync(path.join(outDir, "sub", "d.png"), "SUBPNG");
  // The traversal canary: a file OUTSIDE the output dir. Its existence on disk
  // proves a 404 on /output/.. escapes is CONTAINMENT working, not "missing file".
  secretPath = path.join(tmpRoot, "secret.txt");
  writeFileSync(secretPath, "TOPSECRET");
});

afterEach(() => {}); // keeps bun:test happy alongside beforeAll

/** Invoke the route fn directly (no socket). Non-/output paths return null. */
function call(routes: ReturnType<typeof createOutputRoutes>, url: string): Response | null {
  return routes(new Request(url), undefined as unknown as Parameters<ReturnType<typeof createOutputRoutes>>[1]);
}

describe("createOutputRoutes — happy paths", () => {
  const routes = createOutputRoutes({ dir: outDir });

  test("serves png with image/png + nosniff", async () => {
    const res = call(routes, "http://t/output/0/a.png")!;
    expect(res).not.toBeNull();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe("PNGDATA");
  });

  test("serves mp4 with video/mp4 + nosniff", async () => {
    const res = call(routes, "http://t/output/0/b.mp4")!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("unknown extension -> application/octet-stream + nosniff", () => {
    const res = call(routes, "http://t/output/0/c.xyz")!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("subpath serves (profile_TS-style)", async () => {
    const res = call(routes, "http://t/output/0/sub/d.png")!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await res.text()).toBe("SUBPNG");
  });

  test("dirIdx segment ignored: /output/1/x == /output/0/x", async () => {
    const r0 = call(routes, "http://t/output/0/a.png")!;
    const r1 = call(routes, "http://t/output/1/a.png")!;
    expect(r0.status).toBe(200);
    expect(r1.status).toBe(200);
    expect(await r1.text()).toBe(await r0.text());
  });

  test("plain /output/x.png (no dirIdx) serves", async () => {
    const res = call(routes, "http://t/output/a.png")!;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("PNGDATA");
  });
});

describe("createOutputRoutes — failure paths (uniform 404)", () => {
  const routes = createOutputRoutes({ dir: outDir });

  test("missing file -> 404", () => {
    const res = call(routes, "http://t/output/0/nope.png")!;
    expect(res.status).toBe(404);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("raw-dot traversal /output/0/../secret.txt -> 404 (canary file EXISTS on disk)", () => {
    // NOTE: the URL parser pre-normalizes literal ".." (pathname arrives as
    // /output/secret.txt, still contained -> missing -> 404). The next test
    // exercises OUR containment branch via %2F decoding.
    expect(require("node:fs").existsSync(secretPath)).toBe(true);
    const res = call(routes, "http://t/output/0/../secret.txt")!;
    expect(res.status).toBe(404);
  });

  test("encoded traversal /output/..%2Fsecret.txt -> 404 (containment branch)", () => {
    // "..%2F" survives URL parsing as one segment; our decodeURIComponent
    // yields "../secret.txt" -> normalize+join escapes the dir -> 404.
    const res = call(routes, "http://t/output/..%2Fsecret.txt")!;
    expect(res.status).toBe(404);
  });

  test("encoded traversal with dirIdx /output/7/%2e%2e%2Fsecret.txt -> 404", () => {
    const res = call(routes, "http://t/output/7/%2e%2e%2Fsecret.txt")!;
    expect(res.status).toBe(404);
  });

  test("/output/ (empty name) -> 404, never serves the directory itself", () => {
    const res = call(routes, "http://t/output/")!;
    expect(res.status).toBe(404);
  });

  test("directory target /output/0/sub -> 404 (files only)", () => {
    const res = call(routes, "http://t/output/0/sub")!;
    expect(res.status).toBe(404);
  });
});

describe("createOutputRoutes — fall-through", () => {
  const routes = createOutputRoutes({ dir: outDir });

  test("non-/output path -> null", () => {
    expect(call(routes, "http://t/api/views")).toBeNull();
  });

  test("non-GET method -> null", () => {
    const req = new Request("http://t/output/0/a.png", { method: "POST" });
    expect(routes(req, undefined as never)).toBeNull();
  });
});

describe("resolveOutputDir", () => {
  test("explicit wins over env and default", () => {
    expect(resolveOutputDir("/explicit/dir")).toBe("/explicit/dir");
  });

  test("relative explicit resolved vs cwd", () => {
    expect(resolveOutputDir("rel/dir")).toBe(path.resolve(process.cwd(), "rel/dir"));
  });

  test("default is ../video_generation__output vs cwd", () => {
    const prev = process.env.MLX_OUTPUT_DIR;
    delete process.env.MLX_OUTPUT_DIR;
    expect(resolveOutputDir()).toBe(path.resolve(process.cwd(), "../video_generation__output"));
    if (prev !== undefined) process.env.MLX_OUTPUT_DIR = prev;
  });
});

describe("createOutputRoutes — live WebServer integration", () => {
  const started: WebServer[] = [];
  afterEach(() => {
    while (started.length) {
      try { started.pop()!.stop(); } catch { /* ignore */ }
    }
  });

  test("serves /output/0/a.png through the real origin-guarded fetch()", async () => {
    const server = new WebServer({ port: 0 });
    started.push(server);
    server.setHttpRoutes(createOutputRoutes({ dir: outDir }));
    server.start();
    const res = await fetch(`${server.url}/output/0/a.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("PNGDATA");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/output-routes.test.ts )`
Expected: FAIL — `Cannot find module '../src/output-routes.js'` (module does not exist yet).

- [ ] **Step 3: Write the implementation** — create `bun-apps/pi-agent-ext-webui/src/output-routes.ts`:

```ts
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
    // though the URL parser pre-normalizes literal ".." segments.
    let rest = decodeURIComponent(url.pathname.slice("/output/".length));
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/output-routes.test.ts )`
Expected: PASS — all tests green.

- [ ] **Step 5: Write the failing wiring test** — in `bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts`, add inside the top-level suite (after the existing `dispatch` helper; imports already present: `wireWebui`, `WebServer` is NOT imported here — the FakeWebServer is; add `mkdtempSync`/`writeFileSync`/`path`/`os` imports at top):

```ts
// --- Phase 4: chained httpRoutes seam (render ?? output) ---------------------
describe("wireWebui — chained render+output http routes", () => {
  test("seam serves /output/0/... via deps.outputDir; render routes still first", () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "webui-wiring-out-"));
    const outDir = path.join(tmpRoot, "out");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "shot.png"), "PNG");
    try {
      const pi = new MockPi();
      const server = new FakeWebServer();
      wireWebui(pi, { broadcaster: new MemoryBroadcaster(), clock: new FakeClock(), server, outputDir: outDir });
      const handler = server.httpRoutes!;
      expect(handler).not.toBeNull();
      // Render route still consulted first: /api/views answers through the chain.
      const views = handler(new Request("http://t/api/views"), undefined as never);
      expect(views).not.toBeNull();
      expect(views!.status).toBe(200);
      // Output route serves behind it via the injected dir.
      const res = handler(new Request("http://t/output/0/shot.png"), undefined as never);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(200);
      expect(res!.headers.get("content-type")).toBe("image/png");
      // Fall-through preserved for unknown paths.
      expect(handler(new Request("http://t/definitely/not/a/route"), undefined as never)).toBeNull();
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
```

Also add to the test file's `node:fs`/`node:path`/`node:os` imports at the top (adjust to actual style — the file currently imports none of them):

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
```

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts )`
Expected: FAIL — TypeScript error on `outputDir` (unknown property of `WebuiDeps`) / the `/output` request falls through the un-chained seam and returns null.

- [ ] **Step 6: Wire the chain** — in `bun-apps/pi-agent-ext-webui/src/webui-wiring.ts`:

(a) Add the import next to `createRenderRoutes` (line 44):

```ts
import { createOutputRoutes } from "./output-routes.js";
```

(b) Extend `WebuiDeps` (the interface ending at ~L142, after `server?: WebuiServer;`):

```ts
  /** Output dir for the /output serving route (spec Component 5). Default:
   *  env MLX_OUTPUT_DIR → ../video_generation__output vs cwd (see
   *  output-routes.ts). Injectable so wiring tests use a temp fixture. */
  outputDir?: string;
```

(c) Replace the seam installation (currently ~L361):

```ts
  server.setHttpRoutes(createRenderRoutes(registry));
```

with:

```ts
  // Phase 4 (spec Component 5): chain the /output serving route BEHIND the
  // render routes — render answers first (incl. GET / shell), output serves
  // /output/{...}, everything else falls through to the WebServer defaults.
  const renderRoutes = createRenderRoutes(registry);
  const outputRoutes = createOutputRoutes(deps.outputDir !== undefined ? { dir: deps.outputDir } : undefined);
  server.setHttpRoutes((req, srv) => renderRoutes(req, srv) ?? outputRoutes(req, srv));
```

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/webui-wiring.test.ts )`
Expected: PASS.

- [ ] **Step 7: Run the full gate**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: `bunx tsc` build exit 0, then ALL `bun test` suites pass (existing 273 + new).

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/output-routes.ts bun-apps/pi-agent-ext-webui/src/webui-wiring.ts bun-apps/pi-agent-ext-webui/tests/output-routes.test.ts bun-apps/pi-agent-ext-webui/tests/webui-wiring.test.ts
git commit -m "feat(webui): serve MLX output dir at /output behind the render seam"
```

---

### Task 2: image presentation helper + `webui_present` guidance

**Task note:** INDEPENDENT of Task 1 (this task only produces URL *strings*; Task 1's route serves them). Ordered second for narrative flow.

**Files:**
- Create: `bun-apps/pi-agent-ext-webui/src/image-presentation.ts`
- Modify: `bun-apps/pi-agent-ext-webui/src/present-tool.ts` (description ~L118–L125, promptSnippet ~L126–L127 — locate by `promptSnippet:` inside `createPresentTool`)
- Test: `bun-apps/pi-agent-ext-webui/tests/image-presentation.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Task 1 (pure module, `node:path` only). For the description assertion: `createPresentTool(deps: PresentToolDeps)` from `present-tool.ts` with `PresentToolDeps = { present: PresentFn; registerPending: (id: string) => Promise<HitlResponse>; hasPending: () => boolean; cancelPending: (id: string) => void }`.
- Produces (pure, no deps — exported from `src/image-presentation.ts`):
  - `imageMd(absPath: string, outputDir: string): string | null` — `![image](/output/0/<rel>)` for an image file under `outputDir` (subpaths preserved, separators normalized to `/`); `null` when the path escapes the dir, IS the dir, or has a non-image extension (`.png/.jpg/.jpeg/.webp/.gif` only — video presentation is deferred fog).
  - `imageMdFromDetails(details: unknown, outputDir: string): string[]` — handles `details.output` (string; null/absent → skipped) then `details.outputs[]` (strings OR `{path: string}` objects — the `[object Object]` regression shape), dedupes, filters to images, preserves order (output first, then outputs[] in order). `[]` for anything else.

- [ ] **Step 1: Write the failing test** — create `bun-apps/pi-agent-ext-webui/tests/image-presentation.test.ts`:

```ts
/**
 * image-presentation.test.ts — pure-function matrix for the /output/0/<rel>
 * markdown helpers (spec Component 5) + the webui_present description edit.
 */
import { describe, expect, test } from "bun:test";
import { imageMd, imageMdFromDetails } from "../src/image-presentation.js";
import { createPresentTool } from "../src/present-tool.js";
import * as path from "node:path";

const OUT = path.resolve("/tmp/fake-out");

describe("imageMd", () => {
  test("flat file -> /output/0/<basename>", () => {
    expect(imageMd(path.join(OUT, "shot_001.png"), OUT)).toBe("![image](/output/0/shot_001.png)");
  });

  test("subpath preserved (profile_TS/front.png)", () => {
    expect(imageMd(path.join(OUT, "profile_TS", "front.png"), OUT)).toBe(
      "![image](/output/0/profile_TS/front.png)"
    );
  });

  test("escape outside the output dir -> null", () => {
    expect(imageMd(path.resolve("/tmp/elsewhere", "evil.png"), OUT)).toBeNull();
  });

  test("sibling-dir bypass (../out-secret/x.png, no trailing-sep bug) -> null", () => {
    expect(imageMd(path.resolve("/tmp/out-secret", "x.png"), OUT)).toBeNull();
  });

  test("the output dir itself -> null", () => {
    expect(imageMd(OUT, OUT)).toBeNull();
  });

  test("non-image extension (mp4) -> null (video presentation is deferred fog)", () => {
    expect(imageMd(path.join(OUT, "clip.mp4"), OUT)).toBeNull();
  });

  test("case-insensitive image extension (.PNG)", () => {
    expect(imageMd(path.join(OUT, "SHOT.PNG"), OUT)).toBe("![image](/output/0/SHOT.PNG)");
  });

  test("a file literally named ..foo.png INSIDE the dir still serves (no false escape)", () => {
    expect(imageMd(path.join(OUT, "..foo.png"), OUT)).toBe("![image](/output/0/..foo.png)");
  });
});

describe("imageMdFromDetails", () => {
  test("details.output string", () => {
    expect(imageMdFromDetails({ output: path.join(OUT, "a.png") }, OUT)).toEqual([
      "![image](/output/0/a.png)",
    ]);
  });

  test("details.output null -> skipped", () => {
    expect(imageMdFromDetails({ output: null }, OUT)).toEqual([]);
  });

  test("outputs string-array", () => {
    expect(imageMdFromDetails({ outputs: [path.join(OUT, "a.png"), path.join(OUT, "b.jpg")] }, OUT)).toEqual([
      "![image](/output/0/a.png)",
      "![image](/output/0/b.jpg)",
    ]);
  });

  test("outputs object-array [{path}] — the [object Object] regression", () => {
    // Real flux2/ltx shape: details.outputs entries are objects with .path.
    // Naive template interpolation rendered "[object Object]"; this MUST map
    // through .path and produce real markdown.
    expect(
      imageMdFromDetails(
        { outputs: [{ path: path.join(OUT, "a.png") }, { path: path.join(OUT, "sub", "b.webp") }] },
        OUT
      )
    ).toEqual(["![image](/output/0/a.png)", "![image](/output/0/sub/b.webp)"]);
  });

  test("mixed object/string outputs array", () => {
    expect(
      imageMdFromDetails({ outputs: [path.join(OUT, "a.png"), { path: path.join(OUT, "b.png") }] }, OUT)
    ).toEqual(["![image](/output/0/a.png)", "![image](/output/0/b.png)"]);
  });

  test("output first, then outputs[] — order preserved; dedupe across both", () => {
    expect(
      imageMdFromDetails(
        { output: path.join(OUT, "a.png"), outputs: [path.join(OUT, "a.png"), path.join(OUT, "b.png")] },
        OUT
      )
    ).toEqual(["![image](/output/0/a.png)", "![image](/output/0/b.png)"]);
  });

  test("non-image filtered (mp4 excluded, png kept)", () => {
    expect(
      imageMdFromDetails({ outputs: [path.join(OUT, "clip.mp4"), path.join(OUT, "a.png")] }, OUT)
    ).toEqual(["![image](/output/0/a.png)"]);
  });

  test("object entry with non-string .path skipped, object without .path skipped", () => {
    expect(imageMdFromDetails({ outputs: [{ path: 42 }, { nope: 1 }] }, OUT)).toEqual([]);
  });

  test("empty / absent / non-object details -> []", () => {
    expect(imageMdFromDetails({}, OUT)).toEqual([]);
    expect(imageMdFromDetails(null, OUT)).toEqual([]);
    expect(imageMdFromDetails("string", OUT)).toEqual([]);
    expect(imageMdFromDetails({ outputs: [] }, OUT)).toEqual([]);
  });
});

describe("webui_present description teaches the /output pattern", () => {
  test("description mentions ![image](/output/0/<name>)", () => {
    const tool = createPresentTool({
      present: () => "id",
      registerPending: async () => ({ cancelled: true }),
      hasPending: () => false,
      cancelPending: () => {},
    });
    expect(tool.description).toContain("![image](/output/0/<name>)");
    expect(tool.promptSnippet).toContain("/output/0/");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/image-presentation.test.ts )`
Expected: FAIL — `Cannot find module '../src/image-presentation.js'`.

- [ ] **Step 3: Write the implementation** — create `bun-apps/pi-agent-ext-webui/src/image-presentation.ts`:

```ts
/**
 * image-presentation.ts — pure helpers turning pipeline output paths into the
 * `/output/0/<rel>` markdown presentation convention (spec Component 5).
 *
 * The URL form matches the serving route (output-routes.ts): leading dir-index
 * "0/" (ignored there, canonical here) + the path RELATIVE to the output dir
 * with subpaths preserved (profile_TS/front.png). Videos are deliberately
 * EXCLUDED (.mp4/.mov/... — deferred fog): the v1 convention is image
 * presentation; the route still serves videos for manual browsing.
 *
 * Pure: node:path only — no Bun, no fs, no cross-package imports.
 */
import * as path from "node:path";

/** Image extensions eligible for the ![image] presentation convention. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

/**
 * Markdown for one output image: `![image](/output/0/<rel>)` where <rel> is
 * `absPath` relative to `outputDir` (separators normalized to "/"). Null when
 * the path is not an image, escapes the dir, or IS the dir itself.
 */
export function imageMd(absPath: string, outputDir: string): string | null {
  const ext = path.extname(absPath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) return null;
  const rel = path.relative(path.resolve(outputDir), path.resolve(absPath));
  // Escape check: reject exactly ".." or anything under a leading "../"
  // component — NOT a bare startsWith(".."), which would wrongly reject a
  // legitimate in-dir file literally named "..foo.png".
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return `![image](/output/0/${rel.split(path.sep).join("/")})`;
}

/** Narrow shape an outputs[] entry may take (the flux2/ltx `{path}` form). */
interface PathCarrier {
  path?: unknown;
}

/**
 * All presentable image markdown from a tool-result `details` payload:
 * `details.output` (string, optional) first, then every `details.outputs[]`
 * entry (a string OR an object with a string `.path` — the shape that rendered
 * "[object Object]" when naively interpolated). Deduped, image-filtered,
 * order-preserving. `[]` when nothing presentable.
 */
export function imageMdFromDetails(details: unknown, outputDir: string): string[] {
  if (typeof details !== "object" || details === null) return [];
  const d = details as { output?: unknown; outputs?: unknown };
  const candidates: string[] = [];
  if (typeof d.output === "string") candidates.push(d.output);
  if (Array.isArray(d.outputs)) {
    for (const entry of d.outputs) {
      if (typeof entry === "string") candidates.push(entry);
      else if (typeof entry === "object" && entry !== null) {
        const p = (entry as PathCarrier).path;
        if (typeof p === "string") candidates.push(p);
      }
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const md = imageMd(candidate, outputDir);
    if (md === null || seen.has(md)) continue;
    seen.add(md);
    out.push(md);
  }
  return out;
}
```

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/image-presentation.test.ts )`
Expected: everything passes EXCEPT the `webui_present description` test (Step 1's last block) — FAIL on `toContain`.

- [ ] **Step 4: Extend the `webui_present` description + promptSnippet** — in `bun-apps/pi-agent-ext-webui/src/present-tool.ts`, replace the current strings (inside `createPresentTool`'s returned object; locate by `promptSnippet:`):

Old (verbatim, present-tool.ts ~L118–L127):

```ts
    description:
      "Present content (markdown or HTML, e.g. a generated image as markdown) to the user in the " +
      "browser TOGETHER with declarative response controls, and BLOCK until the user picks one. " +
      "Each control is a button ({id, label}); controls with takesInput reveal a free-text tweak " +
      "field. Returns {action: <controlId>, tweak?} when the user responds, or {cancelled: true} " +
      "if the user cancels / the connection drops. One presentation at a time.",
    promptSnippet:
      "Use to show the user content and WAIT for their decision via declarative controls (blocking HITL gate).",
```

New:

```ts
    description:
      "Present content (markdown or HTML, e.g. a generated image as markdown) to the user in the " +
      "browser TOGETHER with declarative response controls, and BLOCK until the user picks one. " +
      "Each control is a button ({id, label}); controls with takesInput reveal a free-text tweak " +
      "field. Returns {action: <controlId>, tweak?} when the user responds, or {cancelled: true} " +
      "if the user cancels / the connection drops. One presentation at a time. To present " +
      "generated images, reference them as ![image](/output/0/<name>) markdown — images live " +
      "under the MLX output dir and are served at /output/ (subpaths preserved, e.g. " +
      "![image](/output/0/profile_TS/front.png)).",
    promptSnippet:
      "Use to show the user content and WAIT for their decision via declarative controls (blocking HITL gate). " +
      "Present generated images as ![image](/output/0/<name>) markdown.",
```

Description edit only — NO schema change (`PresentParameters` untouched), NO `execute()` change.

- [ ] **Step 5: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-webui && bun test tests/image-presentation.test.ts )`
Expected: PASS — all tests green, including the description assertion.

- [ ] **Step 6: Run the full gate**

Run: `( cd bun-apps/pi-agent-ext-webui && bun run test )`
Expected: `bunx tsc` build exit 0, then ALL `bun test` suites pass.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-webui/src/image-presentation.ts bun-apps/pi-agent-ext-webui/src/present-tool.ts bun-apps/pi-agent-ext-webui/tests/image-presentation.test.ts
git commit -m "feat(webui): imageMd/imageMdFromDetails helpers + teach webui_present the /output pattern"
```

---

## Self-Review

**1. Spec coverage (spec.md Component 5, lines 19/49–51/78):**
- "port `handleGalleryImage` via `setHttpRoutes`" → Task 1 (`createOutputRoutes` + chained `setHttpRoutes`; corrected premise — BUILD not port — flagged in the Phase context).
- "serve `MLX_OUTPUT_DIR` at `/output/{name}`" → Task 1 (`resolveOutputDir`, `/output/0/{name}` + plain `/output/{name}`).
- "MIME allowlist (png/jpg/webp/gif + mp4), `nosniff`, path-traversal containment, loopback originAllowed-guarded" → Task 1 (9-entry allowlist incl. jpeg/mov/webm/m4v; `nosniff` on every response incl. 404s; trailing-separator containment; loopback guard untouched — route rides the existing seam).
- "agent presents `![image](/output/0/{basename})`" → Task 2 (`imageMd` — extended to subpath-rel per the task brief, superset of basename).
- "thin helper from flux2/ltx `details.output`/`outputs[].path`" → Task 2 (`imageMdFromDetails`, `{path}` object shape tested explicitly).
- "Image review = `webui_present({content: md, controls: [approve, regenerate]})`" → covered by the existing blocking-gate tool; Task 2's description edit teaches composing it. No gaps found.

**2. Placeholder scan:** no TBD/TODO/"handle edge cases"/"similar to Task N" — every step carries full code. Verified.

**3. Type consistency:** `createOutputRoutes(opts?: OutputRouteOptions)` / `resolveOutputDir(explicit?: string)` match between Task 1's Interfaces, implementation, tests, and the wiring call (`createOutputRoutes(deps.outputDir !== undefined ? { dir: deps.outputDir } : undefined)`). `imageMd(absPath, outputDir)` / `imageMdFromDetails(details, outputDir)` match between Task 2's Interfaces, implementation, and tests. The chained handler `(req, srv) => renderRoutes(req, srv) ?? outputRoutes(req, srv)` satisfies `HttpRouteHandler` (both factories return the same `(req, srv) => Response | null` shape). The `webui-wiring.test.ts` addition uses only symbols the file already has (`MockPi`, `FakeClock`, `MemoryBroadcaster`, `FakeWebServer`, `wireWebui`) plus the three new node imports it spells out.

One test caveat verified during authoring: the raw-dot traversal test (`/output/0/../secret.txt`) is pre-normalized by the URL parser — that is exactly why the `%2F`/`%2e` encoded tests and the on-disk canary file exist to prove the containment branch actually runs. The plan documents this in the test comment.
