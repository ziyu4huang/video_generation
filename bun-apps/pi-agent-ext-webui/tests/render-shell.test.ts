import { afterEach, describe, expect, it } from "bun:test";
import { WebServer } from "../src/web-server.js";
import { createRenderRoutes } from "../src/render-routes.js";
import { RENDER_SHELL_HTML } from "../src/render-shell.js";
import { RenderService } from "../src/render-service.js";

const started: WebServer[] = [];
function makeServer(): WebServer {
  const s = new WebServer({ port: 0 });
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

describe("RENDER_SHELL_HTML constant", () => {
  it("is a complete HTML document with the marker, tabs pane, content pane, and SSE client", () => {
    expect(RENDER_SHELL_HTML).toContain("<!-- webui-render-shell -->");
    expect(RENDER_SHELL_HTML).toContain("<!doctype html>");
    expect(RENDER_SHELL_HTML).toContain('id="tabs"');
    expect(RENDER_SHELL_HTML).toContain('id="content"');
    expect(RENDER_SHELL_HTML).toContain("EventSource('/api/events')");
    expect(RENDER_SHELL_HTML).toContain("/api/view/");
  });

  it("sandboxes html-mode content (iframe sandbox attribute, no allow-scripts)", () => {
    // The shell builds the iframe via JS and sets an EMPTY sandbox (most
    // restrictive — no allow-scripts, no allow-same-origin) per spec D5.
    expect(RENDER_SHELL_HTML).toContain("setAttribute('sandbox', '')");
    expect(RENDER_SHELL_HTML).not.toContain("allow-scripts");
  });
});

describe("createRenderRoutes — GET / serves the shell", () => {
  it("GET / returns 200 text/html RENDER_SHELL_HTML", async () => {
    const registry = new RenderService();
    const server = makeServer();
    server.setHttpRoutes(createRenderRoutes(registry));
    server.start();
    const res = await fetch(`${server.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toBe(RENDER_SHELL_HTML);
    expect(body).toContain("webui-render-shell");
  });

  it("GET / is served BEFORE /api/* (does not shadow api routes)", async () => {
    const registry = new RenderService();
    registry.render({ content: "# x", view: "main" });
    const server = makeServer();
    server.setHttpRoutes(createRenderRoutes(registry));
    server.start();
    const shell = await (await fetch(`${server.url}/`)).text();
    const views = await (await fetch(`${server.url}/api/views`)).json();
    expect(shell).toContain("webui-render-shell");
    expect(views.length).toBe(1);
  });
});
