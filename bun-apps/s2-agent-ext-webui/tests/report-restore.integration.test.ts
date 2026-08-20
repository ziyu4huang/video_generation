/**
 * report-restore.integration.test.ts — the composition-level guard for
 * cross-restart report persistence (#1590). Unit tests cover report-persist.ts
 * in isolation; this test boots the REAL wireWebui composition root against a
 * seeded JSONL mirror and proves the whole chain end-to-end, no browser:
 *
 *   disk (reports-<port>.jsonl) -> wiring restore loop -> session store ->
 *   GET /api/report/<id>/raw -> 200
 *
 * It also pins the #1592 clean-boot contract on the same boot: an empty main
 * view slot answers 204 (not a console-error-logging 404).
 *
 * webui-wiring starts its server LAZILY on the first session_start event; the
 * fake host captures the pi.on handler so the test can fire it exactly like a
 * real host does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireWebui, type WebuiWiring } from "../src/webui-wiring.js";
import { WebServer } from "../src/web-server.js";

const PORT = 8897;

describe("report persistence — wiring-level restore (integration)", () => {
  const dirs: string[] = [];
  const wirings: WebuiWiring[] = [];
  const prevDir = process.env["WEBUI_REPORT_DIR"];
  afterEach(() => {
    while (wirings.length) {
      try { wirings.pop()!.dispose(); } catch { /* teardown best-effort */ }
    }
    if (prevDir === undefined) delete process.env["WEBUI_REPORT_DIR"];
    else process.env["WEBUI_REPORT_DIR"] = prevDir;
    while (dirs.length) {
      try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function bootWithMirror(lines: string[]): void {
    const dir = mkdtempSync(join(tmpdir(), "webui-restore-"));
    dirs.push(dir);
    process.env["WEBUI_REPORT_DIR"] = dir;
    if (lines.length > 0) {
      writeFileSync(join(dir, "reports-" + PORT + ".jsonl"), lines.join("\n") + "\n", "utf8");
    }
    const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
    const pi = {
      on: (ev: string, h: (e: unknown, ctx: unknown) => unknown) => {
        if (!handlers.has(ev)) handlers.set(ev, []);
        handlers.get(ev)!.push(h);
      },
      events: undefined,
      registerTool: undefined,
      sendUserMessage: undefined,
    };
    // Inject a FRESH real WebServer: getServer() memoizes a process-wide
    // singleton — disposing it would poison every other wiring test in the
    // same bun process. An injected server keeps the full integration depth
    // (real server + routes + store + persistence) with isolated teardown.
    wirings.push(wireWebui(pi as never, { port: PORT, server: new WebServer({ port: PORT }) } ));
    for (const h of handlers.get("session_start") ?? []) {
      h({}, { session: { ui: { notify: () => {} } }, abort: () => {} });
    }
  }

  test("seeded mirror restores into the live store — raw door serves a restored frame", async () => {
    bootWithMirror([
      JSON.stringify({ type: "report", id: "report-restore-1", title: "Restored", source: "agent", ts: 1, html: "<h1>from disk</h1>" }),
      JSON.stringify({ type: "report", id: "report-restore-2", title: "Restored md", source: "agent", ts: 2, markdown: "# from disk" }),
    ]);
    const url = `http://127.0.0.1:${PORT}`;
    // The html frame serves through the standalone door — proof the restore
    // loop fed the session store (getReport reads the store snapshot).
    const raw = await fetch(`${url}/api/report/report-restore-1/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-downloads");
    expect(await raw.text()).toBe("<h1>from disk</h1>");
    // The markdown frame is IN the store too (door serves html only by design).
    expect((await fetch(`${url}/api/report/report-restore-2/raw`)).status).toBe(404);
  });

  test("empty main view slot answers 204 on the same boot (clean-boot contract, #1592)", async () => {
    bootWithMirror([]);
    const res = await fetch(`http://127.0.0.1:${PORT}/api/view/main`);
    expect(res.status).toBe(204);
    expect((await fetch(`http://127.0.0.1:${PORT}/api/view/other`)).status).toBe(404);
  });
});
