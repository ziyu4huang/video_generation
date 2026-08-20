import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import { createRenderRoutes } from "../src/render-routes.js";
import { RenderService } from "../src/render-service.js";
import type { WebFrame } from "../src/protocol.js";

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

type ReportFrame = Extract<WebFrame, { type: "report" }>;
function setup(onReport?: (frame: ReportFrame) => void): { server: WebServer; frames: ReportFrame[] } {
  const frames: ReportFrame[] = [];
  const registry = new RenderService({ urlFor: (id) => `http://t/#${id}` });
  const server = new WebServer({ port: 0 });
  started.push(server);
  server.setHttpRoutes(createRenderRoutes(registry, onReport ? { onReport: (f) => { frames.push(f); onReport(f); } } : {}));
  server.start();
  return { server, frames };
}
const post = (url: string, body: string) => fetch(`${url}/api/report`, { method: "POST", body });

describe("POST /api/report (tab-views 02 producer)", () => {
  it("valid markdown -> 200 {ok,id} + report frame with markdown, source default api", async () => {
    const { server, frames } = setup(() => {});
    const res = await post(server.url, JSON.stringify({ title: "T", markdown: "# hi" }));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { ok: boolean; id: string };
    expect(j.ok).toBe(true);
    expect(j.id.startsWith("report-")).toBe(true);
    expect(frames.length).toBe(1);
    expect(frames[0].type).toBe("report");
    expect(frames[0].markdown).toBe("# hi");
    expect(frames[0].source).toBe("api");
  });
  it("valid html -> frame with html field", async () => {
    const { server, frames } = setup(() => {});
    const res = await post(server.url, JSON.stringify({ title: "T", html: "<b>x</b>", source: "skill" }));
    expect(res.status).toBe(200);
    expect(frames[0].html).toBe("<b>x</b>");
    expect(frames[0].source).toBe("skill");
  });
  it("rejects: both modes / neither / no title / bad JSON / oversized / no sink", async () => {
    const { server } = setup(() => {});
    expect((await post(server.url, JSON.stringify({ title: "T", markdown: "a", html: "b" }))).status).toBe(400);
    expect((await post(server.url, JSON.stringify({ title: "T" }))).status).toBe(400);
    expect((await post(server.url, JSON.stringify({ markdown: "a" }))).status).toBe(400);
    expect((await post(server.url, "not-json")).status).toBe(400);
    expect((await post(server.url, JSON.stringify({ title: "T", markdown: "x".repeat(16777217) }))).status).toBe(413);
    const bare = setup();
    expect((await post(bare.server.url, JSON.stringify({ title: "T", markdown: "a" }))).status).toBe(404);
  });
});

describe("GET /api/report/<id>/raw (standalone door)", () => {
  // Same construction as the POST suite (WebServer + createRenderRoutes),
  // plus the standalone reader: getReport over a local frames array.
  const setupRaw = (): { server: WebServer } => {
    const frames: ReportFrame[] = [
      { type: "report", id: "report-html-1", title: "H", source: "api", ts: 1, html: "<b>x</b>" },
      { type: "report", id: "report-md-1", title: "M", source: "api", ts: 2, markdown: "# m" },
    ];
    const registry = new RenderService({ urlFor: (id) => `http://t/#${id}` });
    const server = new WebServer({ port: 0 });
    started.push(server);
    server.setHttpRoutes(createRenderRoutes(registry, { getReport: (id) => frames.find((f) => f.id === id) }));
    server.start();
    return { server };
  };
  const get = (url: string, id: string) => fetch(`${url}/api/report/${id}/raw`, { method: "GET" });

  it("unknown id -> 404 (also 404 when no reader is wired)", async () => {
    const { server } = setupRaw();
    expect((await get(server.url, "report-nope")).status).toBe(404);
    // No getReport in opts: the standalone door stays closed (404, not 500).
    const bare = new WebServer({ port: 0 });
    started.push(bare);
    bare.setHttpRoutes(createRenderRoutes(new RenderService({ urlFor: (id) => `http://t/#${id}` }), {}));
    bare.start();
    expect((await get(bare.url, "report-html-1")).status).toBe(404);
  });

  it("stored html frame -> 200 text/html with CSP 'sandbox allow-scripts allow-downloads'", async () => {
    const { server } = setupRaw();
    const res = await get(server.url, "report-html-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts allow-downloads");
    expect(await res.text()).toBe("<b>x</b>");
  });

  it("markdown-only frame -> 404 (standalone door serves html frames only)", async () => {
    const { server } = setupRaw();
    expect((await get(server.url, "report-md-1")).status).toBe(404);
  });
});

describe("GET /api/view/<id> — empty main slot is 204, not console noise (main-slot-204)", () => {
  it("missing MAIN view -> 204 No Content (boot probe, no console error)", async () => {
    const { server } = setup();
    const res = await fetch(`${server.url}/api/view/main`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
  it("any OTHER missing id -> 404 (true not-found semantics kept)", async () => {
    const { server } = setup();
    expect((await fetch(`${server.url}/api/view/other`)).status).toBe(404);
  });
});
