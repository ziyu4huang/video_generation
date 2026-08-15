/**
 * open-event-handler.test.ts — tests for the `webui:open` event seam (spec
 * §4.2, archify-webui-html ticket 06): valid paths announce a /files URL via
 * notify; outside-roots and malformed payloads are ignored (never throw —
 * the pi.events bus robustness rule).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createOpenEventHandler } from "../src/open-event-handler.js";
import { createFileRoutes } from "../src/file-routes.js";

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "webui-open-test-"));
const decoy = path.join(tmpRoot, "decoy"); // empty first root -> root indexes 1
const root = path.join(tmpRoot, "root");
mkdirSync(decoy, { recursive: true });
mkdirSync(path.join(root, "sub"), { recursive: true });
writeFileSync(path.join(root, "a.html"), "A");
writeFileSync(path.join(root, "sub", "b.html"), "B");
const secretPath = path.join(tmpRoot, "secret.html");
writeFileSync(secretPath, "SECRET");

const BASE_URL = "http://loopback:1234";

/** Handler + captured notify calls (deterministic, no server). */
function make(roots: string[], getUrl: () => string = () => BASE_URL) {
  const notified: string[] = [];
  const handler = createOpenEventHandler(roots, {
    getUrl,
    notify: (m) => notified.push(m),
  });
  return { handler, notified };
}

describe("createOpenEventHandler — valid paths", () => {
  test("announces `${title} — open ${url}` with /files/<idx>/<rel>", () => {
    const { handler, notified } = make([root]);
    handler({ path: path.join(root, "a.html"), title: "Diagram" });
    expect(notified).toEqual([`Diagram — open ${BASE_URL}/files/0/a.html`]);
  });

  test("subpath rel preserved in the URL", () => {
    const { handler, notified } = make([root]);
    handler({ path: path.join(root, "sub", "b.html") });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("/files/0/sub/b.html");
  });

  test("title absent -> path used as the label", () => {
    const { handler, notified } = make([root]);
    const p = path.join(root, "a.html");
    handler({ path: p });
    expect(notified).toEqual([`${p} — open ${BASE_URL}/files/0/a.html`]);
  });

  test("non-string title falls back to path (payload is validated, not trusted)", () => {
    const { handler, notified } = make([root]);
    const p = path.join(root, "a.html");
    handler({ path: p, title: 42 });
    expect(notified).toEqual([`${p} — open ${BASE_URL}/files/0/a.html`]);
  });

  test("multi-root: second root indexes 1", () => {
    const { handler, notified } = make([decoy, root]);
    handler({ path: path.join(root, "a.html"), title: "T" });
    expect(notified[0]).toBe(`T — open ${BASE_URL}/files/1/a.html`);
  });

  test("relative path resolved vs cwd, then located", () => {
    const { handler, notified } = make([root]);
    handler({ path: path.relative(process.cwd(), path.join(root, "a.html")) });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("/files/0/a.html");
  });

  test("weird filename (space + '#') -> encoded URL that ROUND-TRIPS through the /files route (200)", async () => {
    // Review fix (SHOULD): the announced URL must percent-encode per segment —
    // raw '#' would truncate at the fragment, raw space breaks clients — and
    // the encoded URL must still serve the bytes via the route's decoder.
    const tmp = mkdtempSync(path.join(os.tmpdir(), "webui-open-weird-"));
    const weirdPath = path.join(tmp, "weird #name.html");
    writeFileSync(weirdPath, "WEIRD-BYTES");
    const { handler, notified } = make([tmp]);
    handler({ path: weirdPath, title: "W" });
    expect(notified).toHaveLength(1);
    expect(notified[0]).toBe(`W — open ${BASE_URL}/files/0/weird%20%23name.html`);
    // Route harness (same direct-fn invocation as file-routes.test.ts `call`):
    // fetching the EXACT announced URL must 200 with the file's bytes.
    const url = notified[0]!.slice(notified[0]!.lastIndexOf("http"));
    const routes = createFileRoutes({ roots: [tmp] });
    const res = routes(new Request(url), undefined as never)!;
    expect(res).not.toBeNull();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("WEIRD-BYTES");
  });
});

describe("createOpenEventHandler — ignored paths (no notify, never throw)", () => {
  test("path outside every root -> ignored", () => {
    const { handler, notified } = make([root]);
    handler({ path: secretPath, title: "X" });
    expect(notified).toEqual([]);
  });

  test("empty roots (fail closed) -> ignored", () => {
    const { handler, notified } = make([]);
    handler({ path: path.join(root, "a.html") });
    expect(notified).toEqual([]);
  });

  test("missing file -> ignored", () => {
    const { handler, notified } = make([root]);
    handler({ path: path.join(root, "nope.html") });
    expect(notified).toEqual([]);
  });

  test("directory -> ignored", () => {
    const { handler, notified } = make([root]);
    handler({ path: path.join(root, "sub") });
    expect(notified).toEqual([]);
  });

  test("malformed payloads -> no throw, no notify", () => {
    const { handler, notified } = make([root]);
    expect(() => handler(null)).not.toThrow();
    expect(() => handler(undefined)).not.toThrow();
    expect(() => handler("a.html")).not.toThrow();
    expect(() => handler({})).not.toThrow();
    expect(() => handler({ path: 42 })).not.toThrow();
    expect(() => handler({ path: "" })).not.toThrow();
    expect(notified).toEqual([]);
  });

  test("getUrl throwing -> swallowed (bus robustness)", () => {
    const { handler, notified } = make([root], () => {
      throw new Error("not started");
    });
    expect(() => handler({ path: path.join(root, "a.html") })).not.toThrow();
    expect(notified).toEqual([]);
  });

  test("notify throwing -> swallowed (bus robustness)", () => {
    const handler = createOpenEventHandler([root], {
      getUrl: () => BASE_URL,
      notify: () => {
        throw new Error("ui gone");
      },
    });
    expect(() => handler({ path: path.join(root, "a.html") })).not.toThrow();
  });
});
