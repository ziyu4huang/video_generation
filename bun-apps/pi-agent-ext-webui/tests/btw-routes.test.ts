import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebServer } from "../src/web-server.js";
import { createRenderRoutes } from "../src/render-routes.js";
import { RenderService } from "../src/render-service.js";
import { buildBtwEntry, createBtwStore } from "../src/btw-store.js";

// BTW tab (demo): browser-authored branch questions — the webui -> agent
// direction (reverse of ask cards). Routes ride createRenderRoutes opts.

const started: WebServer[] = [];
function setup(): { server: WebServer; btw: ReturnType<typeof createBtwStore> } {
  const dir = mkdtempSync(join(tmpdir(), "btw-routes-"));
  const registry = new RenderService({ urlFor: (id) => `http://t/#${id}` });
  const server = new WebServer({ port: 0 });
  const btw = createBtwStore(join(dir, "btw-0.jsonl"));
  server.setHttpRoutes(
    createRenderRoutes(registry, {
      btw,
      dataSummary: () => ({ port: 0, btwPending: btw.list().filter((e) => !e.resolvedAt).length }),
    }),
  );
  server.start();
  started.push(server);
  return { server, btw };
}
afterEach(() => {
  while (started.length) {
    try {
      started.pop()!.stop();
    } catch {
      /* ignore */
    }
  }
});

describe("btw routes", () => {
  it("create -> pending -> resolve lifecycle", async () => {
    const { server } = setup();
    const create = await fetch(server.url + "/api/btw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "why is the scrollbar inset?", chips: ["css", "shell"], aboutId: "report-x", aboutTitle: "Architecture" }),
    });
    expect(create.status).toBe(200);
    const { id } = (await create.json()) as { id: string };
    type List = { pending: Array<{ id: string; question: string; chips: string[]; aboutTitle?: string }> };
    let list = (await (await fetch(server.url + "/api/btw")).json()) as List;
    expect(list.pending).toHaveLength(1);
    expect(list.pending[0].question).toBe("why is the scrollbar inset?");
    expect(list.pending[0].chips).toEqual(["css", "shell"]);
    expect(list.pending[0].aboutTitle).toBe("Architecture");
    expect((await fetch(server.url + "/api/btw/" + id + "/resolve", { method: "POST" })).status).toBe(200);
    list = (await (await fetch(server.url + "/api/btw")).json()) as List;
    expect(list.pending).toHaveLength(0);
    expect((await fetch(server.url + "/api/btw/nope/resolve", { method: "POST" })).status).toBe(404);
  });

  it("rejects bad bodies", async () => {
    const { server } = setup();
    expect((await fetch(server.url + "/api/btw", { method: "POST", body: "not json" })).status).toBe(400);
    expect(
      (await fetch(server.url + "/api/btw", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status,
    ).toBe(400);
  });

  it("data summary route serves the injected snapshot", async () => {
    const { server } = setup();
    const d = (await (await fetch(server.url + "/api/data/summary")).json()) as Record<string, unknown>;
    expect(d["btwPending"]).toBe(0);
    expect(d["port"]).toBe(0);
  });
});

describe("btw-store", () => {
  it("mirrors events and replays across restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "btw-store-"));
    const p = join(dir, "btw-1.jsonl");
    let t = 1000;
    const a = createBtwStore(p, () => t);
    const e = a.create({ question: "branch?", chips: [] });
    t = 2000;
    expect(a.resolve(e.id, t)).toBe(true);
    const b = createBtwStore(p, () => t);
    expect(b.list()).toHaveLength(1);
    expect(b.list()[0].resolvedAt).toBe(2000);
  });

  it("buildBtwEntry validates", () => {
    expect(buildBtwEntry({ question: "" }).ok).toBe(false);
    expect(buildBtwEntry("nope").ok).toBe(false);
    expect(buildBtwEntry({ question: "q" }).ok).toBe(true);
    expect(buildBtwEntry({ question: "q", chips: ["a", "", "b"] }).ok).toBe(true);
    expect(buildBtwEntry({ question: "q", chips: Array.from({ length: 7 }, () => "x") }).ok).toBe(false);
  });
});
