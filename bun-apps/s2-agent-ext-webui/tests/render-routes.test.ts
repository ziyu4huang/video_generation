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

  it("md present view includes controls + presentId (spec Decision A)", async () => {
    const { registry, server } = setup(() => 5);
    registry.render({
      content: "# approve?",
      view: "present",
      controls: [
        { id: "approve", label: "Approve" },
        { id: "regenerate", label: "Regenerate…", takesInput: true },
      ],
      presentId: "present_9_1",
    });
    const res = await fetch(`${server.url}/api/view/present`);
    expect(res.status).toBe(200);
    const v = await res.json();
    expect(v.id).toBe("present");
    expect(v.html).toContain("<h1");
    expect(v.controls).toEqual([
      { id: "approve", label: "Approve" },
      { id: "regenerate", label: "Regenerate…", takesInput: true },
    ]);
    expect(v.presentId).toBe("present_9_1");
  });

  it("html present view includes controls + presentId", async () => {
    const { registry, server } = setup(() => 5);
    registry.render({
      content: "<p>pick</p>",
      view: "p",
      mode: "html",
      controls: [{ id: "ok", label: "OK" }],
      presentId: "present_9_2",
    });
    const v = await (await fetch(`${server.url}/api/view/p`)).json();
    expect(v.mode).toBe("html");
    expect(v.controls).toEqual([{ id: "ok", label: "OK" }]);
    expect(v.presentId).toBe("present_9_2");
  });

  it("a non-present view omits controls/presentId keys (clean shape)", async () => {
    const { registry, server } = setup(() => 5);
    registry.render({ content: "a", view: "plain" });
    const v = await (await fetch(`${server.url}/api/view/plain`)).json();
    expect(v).not.toHaveProperty("controls");
    expect(v).not.toHaveProperty("presentId");
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

// --- GET /api/events — REMOVED (webui-simplify §3: one live transport) ------

describe("createRenderRoutes — GET /api/events is gone (webui-simplify §3)", () => {
  it("404s like any unknown route — live view refresh rides the WS view_update frames", async () => {
    const { registry, server } = setup();
    const res = await fetch(`${server.url}/api/events`);
    expect(res.status).toBe(404);
    expect(registry.subscriberCount).toBe(0); // nothing subscribes anymore
  });
});
