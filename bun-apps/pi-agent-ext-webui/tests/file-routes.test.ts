/**
 * file-routes.test.ts — tests for the /files serving port (spec §4.1,
 * archify-webui-html ticket 06): full-fidelity HTML with the CSP sandbox
 * header on EVERY response (200s and 404s alike), realpath containment across
 * the configured root allowlist, and multi-root rootIdx routing.
 *
 * Direct route-fn invocation for the matrix (deterministic, no socket),
 * mirroring tests/output-routes.test.ts (module-level eager fixtures — see
 * the DEVIATION note there about bun:test's eager describe bodies).
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createFileRoutes, locateFileInRoots } from "../src/file-routes.js";

/** DECIDED directive set (vendored templates use blob+anchor downloads only). */
const EXPECTED_CSP = "sandbox allow-scripts allow-downloads";

// --- fixture: two roots + an outside canary ----------------------------------
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "webui-files-test-"));
const rootA = path.join(tmpRoot, "a");
const rootB = path.join(tmpRoot, "b");
mkdirSync(path.join(rootA, "sub"), { recursive: true });
mkdirSync(rootB, { recursive: true });
writeFileSync(path.join(rootA, "page.html"), "<html>HI</html>");
writeFileSync(path.join(rootA, "data.bin"), "BINDATA");
writeFileSync(path.join(rootA, "sub", "deep.html"), "DEEP");
writeFileSync(path.join(rootB, "other.html"), "OTHER");
writeFileSync(path.join(rootB, "UP.HTML"), "UP");
// The traversal canary: exists on disk, OUTSIDE both roots — a 404 on escape
// is containment working, not "missing file".
const secretPath = path.join(tmpRoot, "secret.html");
writeFileSync(secretPath, "SECRET");

const TWO_ROOTS = [rootA, rootB];

/** Invoke the route fn directly (no socket). Non-/files paths return null. */
function call(routes: ReturnType<typeof createFileRoutes>, url: string): Response | null {
  return routes(
    new Request(url),
    undefined as unknown as Parameters<ReturnType<typeof createFileRoutes>>[1]
  );
}

/** The uniform-404 contract: 404 + CSP sandbox + nosniff on EVERY response. */
function expect404(res: Response | null): void {
  expect(res).not.toBeNull();
  expect(res!.status).toBe(404);
  expect(res!.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
  expect(res!.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("createFileRoutes — happy paths", () => {
  const routes = createFileRoutes({ roots: TWO_ROOTS });

  test("serves .html as text/html; charset=utf-8 + CSP sandbox + nosniff", async () => {
    const res = call(routes, "http://t/files/0/page.html")!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe("<html>HI</html>");
  });

  test("non-html -> application/octet-stream + nosniff (CSP still set)", async () => {
    const res = call(routes, "http://t/files/0/data.bin")!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("BINDATA");
  });

  test("uppercase .HTML extension still text/html (case-insensitive ext)", async () => {
    const res = call(routes, "http://t/files/1/UP.HTML")!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("subpath serves", async () => {
    const res = call(routes, "http://t/files/0/sub/deep.html")!;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("DEEP");
  });

  test("rootIdx 1 routes to the SECOND root (multi-root allowlist)", async () => {
    const res = call(routes, "http://t/files/1/other.html")!;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OTHER");
  });
});

describe("createFileRoutes — failure paths (uniform 404, CSP on every response)", () => {
  const routes = createFileRoutes({ roots: TWO_ROOTS });

  test("EMPTY roots -> fail closed (nothing is ever in range)", () => {
    const empty = createFileRoutes({ roots: [] });
    expect404(call(empty, "http://t/files/0/page.html"));
  });

  test("out-of-range rootIdx -> 404", () => {
    expect404(call(routes, "http://t/files/2/page.html"));
  });

  test("non-integer rootIdx -> 404", () => {
    expect404(call(routes, "http://t/files/x/page.html"));
  });

  test("missing rootIdx segment -> 404 (index is REQUIRED, unlike /output)", () => {
    expect404(call(routes, "http://t/files/page.html"));
  });

  test("empty rel /files/0/ -> 404", () => {
    expect404(call(routes, "http://t/files/0/"));
  });

  test("bare /files/ -> 404", () => {
    expect404(call(routes, "http://t/files/"));
  });

  test("encoded traversal /files/0/..%2Fsecret.html -> 404 (canary EXISTS on disk)", () => {
    expect(existsSync(secretPath)).toBe(true);
    expect404(call(routes, "http://t/files/0/..%2Fsecret.html"));
  });

  test("cross-root round-trip: rel escaping rootB INTO rootA -> 404 (rootIdx must match)", () => {
    // join(rootB, "../a/page.html") normalizes into rootA — locatable, but
    // under rootIdx 0, not the requested 1: rejected so rootIdx <-> root
    // stays a stable bijection.
    expect404(call(routes, "http://t/files/1/..%2Fa%2Fpage.html"));
  });

  test("directory target /files/0/sub -> 404 (regular files only)", () => {
    expect404(call(routes, "http://t/files/0/sub"));
  });

  test("malformed %-sequence /files/0/%FF -> 404 (never a 500 from decodeURIComponent)", () => {
    expect404(call(routes, "http://t/files/0/%FF"));
  });

  test("null byte /files/0/%00.html -> 404 (never a 500 from statSync)", () => {
    expect404(call(routes, "http://t/files/0/%00.html"));
  });

  test("missing file -> 404", () => {
    expect404(call(routes, "http://t/files/0/nope.html"));
  });
});

describe("createFileRoutes — symlink containment", () => {
  // A symlink INSIDE a root pointing anywhere (final component OR an
  // intermediate directory) must 404 — realpath resolves every hop.
  const t2 = mkdtempSync(path.join(os.tmpdir(), "webui-files-symlink-"));
  const root = path.join(t2, "root");
  const outside = path.join(t2, "outside.html");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "ok.html"), "OK");
  writeFileSync(outside, "SECRET-OUTSIDE");
  let symlinksAvailable = true;
  try {
    symlinkSync(outside, path.join(root, "evil.html")); // final-component escape
    symlinkSync(t2, path.join(root, "linked-dir")); // intermediate-dir escape
  } catch {
    symlinksAvailable = false; // filesystem without symlink support — skip
  }
  const routes = createFileRoutes({ roots: [root] });

  test("a real file still serves (control)", async () => {
    const res = call(routes, "http://t/files/0/ok.html")!;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });

  test.skipIf(!symlinksAvailable)("final-component symlink escaping the root -> 404", () => {
    expect404(call(routes, "http://t/files/0/evil.html"));
  });

  test.skipIf(!symlinksAvailable)("symlinked intermediate directory escaping the root -> 404", () => {
    expect404(call(routes, "http://t/files/0/linked-dir/outside.html"));
  });
});

describe("createFileRoutes — fall-through", () => {
  const routes = createFileRoutes({ roots: TWO_ROOTS });

  test("non-/files path -> null", () => {
    expect(call(routes, "http://t/output/0/a.png")).toBeNull();
  });

  test("non-GET method -> null", () => {
    const req = new Request("http://t/files/0/page.html", { method: "POST" });
    expect(routes(req, undefined as never)).toBeNull();
  });
});

describe("locateFileInRoots (shared containment core — also used by webui:open)", () => {
  test("locates a file: rootIdx + root-relative rel + real path", () => {
    const loc = locateFileInRoots(TWO_ROOTS, path.join(rootA, "sub", "deep.html"))!;
    expect(loc).not.toBeNull();
    expect(loc.rootIdx).toBe(0);
    expect(loc.rel).toBe(path.join("sub", "deep.html"));
    expect(loc.real).toBe(realpathSync(path.join(rootA, "sub", "deep.html"))); // realpath'd absolute (macOS: /private/...)
  });

  test("second root matches with rootIdx 1", () => {
    const loc = locateFileInRoots(TWO_ROOTS, path.join(rootB, "other.html"))!;
    expect(loc.rootIdx).toBe(1);
    expect(loc.rel).toBe("other.html");
  });

  test("relative path resolved vs cwd, then located", () => {
    const rel = path.relative(process.cwd(), path.join(rootA, "page.html"));
    const loc = locateFileInRoots(TWO_ROOTS, rel)!;
    expect(loc.rootIdx).toBe(0);
  });

  test("outside all roots -> null", () => {
    expect(locateFileInRoots(TWO_ROOTS, secretPath)).toBeNull();
  });

  test("directory -> null (regular files only)", () => {
    expect(locateFileInRoots(TWO_ROOTS, path.join(rootA, "sub"))).toBeNull();
  });

  test("missing file -> null", () => {
    expect(locateFileInRoots(TWO_ROOTS, path.join(rootA, "nope.html"))).toBeNull();
  });
});
