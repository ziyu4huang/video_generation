import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import { createRenderRoutes } from "../src/render-routes.js";
import { RenderService } from "../src/render-service.js";

// --- harness (helpers copied from web-server.test.ts) ----------------------

const started: WebServer[] = [];
function makeServer(opts?: { port?: number; hostname?: string }): WebServer {
  const s = new WebServer(opts);
  started.push(s);
  return s;
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

function withTimeout<T>(p: Promise<T>, ms = 2000, label = "timed out"): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
  ]);
}

async function waitFor(name: string, predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitFor(${name}) timed out after ${ms}ms`);
}

/** Build a registry + a live WebServer with the render routes installed. */
function setup(now = () => 1000): { registry: RenderService; server: WebServer } {
  const registry = new RenderService({ urlFor: (id) => `http://t/#${id}`, now });
  const server = makeServer({ port: 0 });
  server.setHttpRoutes(createRenderRoutes(registry));
  server.start();
  return { registry, server };
}

// ---------------------------------------------------------------------------

describe("createRenderRoutes — GET /api/views", () => {
  it("returns [] for an empty registry", async () => {
    const { server } = setup();
    const res = await fetch(`${server.url}/api/views`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual([]);
  });

  it("lists every view as { id, title, mode, updatedAt }", async () => {
    const { registry, server } = setup(() => 42);
    registry.render({ content: "a", view: "v1", title: "One" });
    registry.render({ content: "b", view: "v2", mode: "html" });
    const views = await (await fetch(`${server.url}/api/views`)).json();
    expect(views).toEqual([
      { id: "v1", title: "One", mode: "md", updatedAt: 42 },
      { id: "v2", title: null, mode: "html", updatedAt: 42 },
    ]);
  });
});

describe("createRenderRoutes — GET /api/view/:id", () => {
  it("md view -> { id, mode, html, title, updatedAt } with server-rendered html", async () => {
    const { registry, server } = setup(() => 5);
    registry.render({ content: "# hi", view: "main", title: "Main" });
    const res = await fetch(`${server.url}/api/view/main`);
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.id).toBe("main");
    expect(v.mode).toBe("md");
    expect(v.html).toContain("<h1");
    expect(v.html.toLowerCase()).toContain("hi");
    expect(v.title).toBe("Main");
    expect(v.updatedAt).toBe(5);
    expect(v).not.toHaveProperty("content"); // md never leaks raw content
  });

  it("html view -> { id, mode, content, title, updatedAt } (raw content for iframe srcdoc)", async () => {
    const { registry, server } = setup(() => 5);
    registry.render({ content: "<p>raw</p>", view: "p", mode: "html" });
    const v = await (await fetch(`${server.url}/api/view/p`)).json();
    expect(v).toEqual({
      id: "p",
      mode: "html",
      content: "<p>raw</p>",
      title: null,
      updatedAt: 5,
    });
    expect(v).not.toHaveProperty("html");
  });

  it("unknown id -> 404", async () => {
    const { server } = setup();
    const res = await fetch(`${server.url}/api/view/nope`);
    expect(res.status).toBe(404);
  });
});

describe("createRenderRoutes — fall-through", () => {
  it("an unknown path returns null -> WebServer default 404", async () => {
    const { server } = setup();
    const res = await fetch(`${server.url}/api/unknown`);
    expect(res.status).toBe(404);
  });

  it("/health still works (routes do not shadow it)", async () => {
    const { server } = setup();
    const res = await fetch(`${server.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("createRenderRoutes — GET /api/events (SSE)", () => {
  it("opens text/event-stream and emits a view_update on render, then unsubscribes on disconnect", async () => {
    const { registry, server } = setup();
    const ctrl = new AbortController();
    const res = await fetch(`${server.url}/api/events`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(registry.subscriberCount).toBe(1);

    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";

    // initial comment frame
    const first = await withTimeout(reader.read(), 2000, "no initial chunk");
    buf += dec.decode(first.value ?? new Uint8Array(), { stream: true });
    expect(buf).toContain(": connected");

    // push a view -> expect a `data:` frame
    registry.render({ content: "# hi", view: "sse-view" });
    let payload: { viewId?: string; updatedAt?: number } | null = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !payload) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 40)),
      ]);
      if ("value" in chunk && chunk.value) buf += dec.decode(chunk.value, { stream: true });
      const m = buf.match(/data: (\{.*\})\n\n/);
      if (m) payload = JSON.parse(m[1]);
    }
    expect(payload).toEqual({ viewId: "sse-view", updatedAt: 1000 });

    // disconnect -> subscriber removed (ReadableStream.cancel -> unsubscribe)
    ctrl.abort();
    await waitFor("subscriber removed", () => registry.subscriberCount === 0, 2000);
  });
});

// --- GET /api/events heartbeat ----------------------------------------------

describe("createRenderRoutes — GET /api/events heartbeat", () => {
  it("emits ': ping' comment frames at the injected heartbeatMs interval", async () => {
    const registry = new RenderService({ urlFor: (id) => `http://t/#${id}`, now: () => 1000 });
    const server = makeServer({ port: 0 });
    server.setHttpRoutes(createRenderRoutes(registry, { heartbeatMs: 20 }));
    server.start();

    const ctrl = new AbortController();
    const res = await fetch(`${server.url}/api/events`, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();

    // initial comment frame
    const first = await withTimeout(reader.read(), 2000, "no initial chunk");
    expect(dec.decode(first.value ?? new Uint8Array(), { stream: true })).toContain(": connected");

    // the next chunk (well within 2s for a 20ms heartbeat) is the heartbeat
    const second = await withTimeout(reader.read(), 2000, "no heartbeat chunk");
    expect(dec.decode(second.value ?? new Uint8Array(), { stream: true })).toBe(": ping\n\n");

    // abort is clean (no throw) and unsubscribes
    expect(() => ctrl.abort()).not.toThrow();
    await waitFor("subscriber removed", () => registry.subscriberCount === 0, 2000);
  });
});
