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
