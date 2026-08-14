// bun-apps/pi-agent-ext-webui/tests/btw-routes.test.ts
// Task 8: GET /api/btw (thread snapshot, D7) + GET /api/btw/models (D12).
import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server";
import { createBtwRoutes } from "../src/btw-routes";
import type { BtwThreadState } from "../src/btw-channels";

const servers: WebServer[] = [];
afterEach(() => {
  for (const server of servers) server.stop();
  servers.length = 0;
});

const STATE: BtwThreadState = {
  messages: [{ id: "btw-m-0", role: "user", text: "q", status: "done" }],
  mode: "contextual",
  model: null,
  thinking: null,
};

function startServer(deps: Parameters<typeof createBtwRoutes>[0]): WebServer {
  const server = new WebServer({ port: 0 });
  servers.push(server);
  server.setHttpRoutes(createBtwRoutes(deps));
  server.start();
  return server;
}

describe("GET /api/btw", () => {
  it("returns the latest thread snapshot with no-store headers", async () => {
    const server = startServer({ getState: () => STATE, getModels: () => [] });
    const res = await fetch(`${server.url}/api/btw`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(STATE);
  });

  it("returns an empty default state when nothing has been emitted yet", async () => {
    const server = startServer({ getState: () => null, getModels: () => [] });
    const res = await fetch(`${server.url}/api/btw`);
    expect(await res.json()).toEqual({ messages: [], mode: "contextual", model: null, thinking: null });
  });
});

describe("GET /api/btw/models", () => {
  it("returns the registry-backed model list", async () => {
    const models = [{ provider: "anthropic", id: "claude-sonnet-4", api: "anthropic" }];
    const server = startServer({ getState: () => STATE, getModels: () => models });
    const res = await fetch(`${server.url}/api/btw/models`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(models);
  });
});

describe("route chaining", () => {
  it("returns null for other paths so the existing chain continues", () => {
    const handler = createBtwRoutes({ getState: () => STATE, getModels: () => [] });
    expect(handler(new Request("http://localhost/api/views"), undefined as never)).toBeNull();
    expect(handler(new Request("http://localhost/output/x.png"), undefined as never)).toBeNull();
  });
});
