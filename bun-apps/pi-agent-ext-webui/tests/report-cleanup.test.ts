import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebServer } from "../src/web-server.js";
import { createRenderRoutes } from "../src/render-routes.js";
import { RenderService } from "../src/render-service.js";
import { createSessionStore } from "../src/session-store.js";
import { appendReport, clearReportsFile, compactReports, loadReports } from "../src/report-persist.js";
import type { WebFrame } from "../src/protocol.js";

// report-cleanup: DELETE /api/report/<id> (one) + DELETE /api/report (all).
// Seams mirror the wiring: store removal FIRST, then mirror compaction, so a
// restart stays clean. The shell carries a per-article x button + a pane-level
// "clear all reports" toolbar.

type ReportF = Extract<WebFrame, { type: "report" }>;
const started: WebServer[] = [];
afterEach(() => {
  while (started.length) {
    try {
      started.pop()!.stop();
    } catch {
      /* ignore */
    }
  }
});

function setup(): { server: WebServer; store: ReturnType<typeof createSessionStore>; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "rc-"));
  const path = join(dir, "reports.jsonl");
  const store = createSessionStore();
  const registry = new RenderService({ urlFor: (id) => `http://t/#${id}` });
  const server = new WebServer({ port: 0 });
  server.setHttpRoutes(
    createRenderRoutes(registry, {
      onReport: (frame) => {
        store.append(frame);
        appendReport(path, frame);
      },
      getReport: (id) => store.snapshot().transcript.find((f) => f.type === "report" && f.id === id) as ReportF | undefined,
      removeReport: (id) => {
        const ok = store.removeReport(id);
        if (ok) compactReports(path, new Set([id]));
        return ok;
      },
      clearReports: () => {
        const removed = store.clearReports();
        clearReportsFile(path);
        return removed;
      },
    }),
  );
  server.start();
  started.push(server);
  return { server, store, path };
}

async function post(server: WebServer, title: string, html?: string): Promise<string> {
  const res = await fetch(server.url + "/api/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(html ? { title, html } : { title, markdown: "# " + title }),
  });
  return ((await res.json()) as { id: string }).id;
}

describe("report-cleanup routes", () => {
  it("DELETE one: gone from store + mirror + /raw; unknown id 404", async () => {
    const { server, store, path } = setup();
    // A posts as HTML (the /raw door serves ONLY html frames — markdown -> 404
    // is the documented contract, not a bug).
    const a = await post(server, "A", "<p>html report</p>");
    const b = await post(server, "B");
    expect((await fetch(server.url + "/api/report/" + a + "/raw")).status).toBe(200);
    expect((await fetch(server.url + "/api/report/" + a, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(server.url + "/api/report/" + a + "/raw")).status).toBe(404);
    expect(loadReports(path).map((f) => f.title)).toEqual(["B"]);
    expect(store.snapshot().transcript.filter((f) => f.type === "report")).toHaveLength(1);
    expect((await fetch(server.url + "/api/report/nope", { method: "DELETE" })).status).toBe(404);
  });

  it("DELETE all: returns count, empties store + mirror", async () => {
    const { server, store, path } = setup();
    await post(server, "A");
    await post(server, "B");
    const res = await fetch(server.url + "/api/report", { method: "DELETE" });
    expect(((await res.json()) as { removed: number }).removed).toBe(2);
    expect(store.snapshot().transcript.filter((f) => f.type === "report")).toHaveLength(0);
    expect(readFileSync(path, "utf8").trim()).toBe("");
  });
});

describe("session-store removeReport/clearReports", () => {
  it("splices only the matching report; false when absent", () => {
    const s = createSessionStore();
    s.append({ type: "report", id: "r1", title: "one", markdown: "m", ts: 1 } as unknown as WebFrame);
    s.append({ type: "card", id: "c1", title: "card", body: {}, ts: 2 } as unknown as WebFrame);
    s.append({ type: "report", id: "r2", title: "two", markdown: "m", ts: 3 } as unknown as WebFrame);
    expect(s.removeReport("r1")).toBe(true);
    expect(s.removeReport("r1")).toBe(false);
    expect(s.snapshot().transcript.map((f) => f.type)).toEqual(["card", "report"]);
    expect(s.clearReports()).toBe(1);
    expect(s.snapshot().transcript.map((f) => f.type)).toEqual(["card"]);
  });
});

describe("report-persist compaction", () => {
  it("compact removes only named ids, preserves order + corrupt lines; clear empties", () => {
    const dir = mkdtempSync(join(tmpdir(), "rc-p-"));
    const p = join(dir, "r.jsonl");
    writeFileSync(p, '{"type":"report","id":"a","title":"A","markdown":"m"}\nnot-json\n{"type":"report","id":"b","title":"B","markdown":"m"}\n', "utf8");
    compactReports(p, new Set(["a"]));
    expect(readFileSync(p, "utf8")).toBe('not-json\n{"type":"report","id":"b","title":"B","markdown":"m"}\n');
    expect(loadReports(p).map((f) => f.id)).toEqual(["b"]);
    clearReportsFile(p);
    expect(readFileSync(p, "utf8")).toBe("");
  });
});

describe("shell cleanup affordances", () => {
  it("serves the clear-all toolbar + per-article remove button", async () => {
    const { server } = setup();
    const html = await (await fetch(server.url + "/")).text();
    expect(html).toContain("report-clear-all");
    expect(html).toContain("refreshReportClearAll");
    // the template literal resolves the escape — the served button text is
    // the REAL glyph, so the browser shows an actual cross mark.
    expect(html).toContain("\u2715");
    expect(html).toContain("method: 'DELETE'");
  });
});
