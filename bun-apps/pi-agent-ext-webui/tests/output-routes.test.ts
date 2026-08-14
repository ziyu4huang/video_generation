/**
 * output-routes.test.ts — tests for the /output serving port (spec Component 5,
 * CORRECTED premise: #1274 was planning-only; this route is NEW, modeled on the
 * #02 contract in gui-movie-director/api/gallery.ts handleGalleryImage but
 * reimplemented lean — no ETag/Range/304 for v1).
 *
 * Direct route-fn invocation for the matrix (deterministic, no socket) + one
 * live WebServer integration test proving the origin-guarded fetch() path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createOutputRoutes, resolveOutputDir } from "../src/output-routes.js";
import { WebServer } from "../src/web-server.js";

// --- fixture: tmpRoot/out/{a.png,b.mp4,c.xyz,sub/d.png} + tmpRoot/secret.txt --
// DEVIATION from the plan snippet (which used beforeAll): bun:test runs
// describe bodies EAGERLY at collection time, BEFORE beforeAll hooks — so the
// describe-scoped `createOutputRoutes({ dir: outDir })` consts captured an
// undefined outDir and every happy-path test 404'd. Module-level eager init
// fixes the ordering; all test bodies are unchanged from the plan.
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "webui-output-test-"));
const outDir = path.join(tmpRoot, "out");
mkdirSync(path.join(outDir, "sub"), { recursive: true });
writeFileSync(path.join(outDir, "a.png"), "PNGDATA");
writeFileSync(path.join(outDir, "b.mp4"), "MP4DATA");
writeFileSync(path.join(outDir, "c.xyz"), "XYZDATA");
writeFileSync(path.join(outDir, "sub", "d.png"), "SUBPNG");
// The traversal canary: a file OUTSIDE the output dir. Its existence on disk
// proves a 404 on /output/.. escapes is CONTAINMENT working, not "missing file".
const secretPath = path.join(tmpRoot, "secret.txt");
writeFileSync(secretPath, "TOPSECRET");

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
