import { describe, expect, it } from "bun:test";
import { createRenderTool } from "../src/render-tool.js";
import { RenderService } from "../src/render-service.js";

describe("createRenderTool", () => {
  it("returns a tool named webui_render with the TypeBox parameter schema", () => {
    const registry = new RenderService({ urlFor: () => "#" });
    const tool = createRenderTool(registry);
    expect(tool.name).toBe("webui_render");
    expect(tool.parameters.type).toBe("object");
    expect(tool.parameters.properties).toHaveProperty("content");
    expect(tool.parameters.properties).toHaveProperty("mode");
    expect(tool.parameters.properties).toHaveProperty("view");
    expect(tool.parameters.properties).toHaveProperty("title");
  });

  it("execute() renders to the registry (default view 'main', mode 'md') and returns the url", async () => {
    const registry = new RenderService({ urlFor: (id) => `http://test/#${id}`, now: () => 1 });
    const tool = createRenderTool(registry);
    const out = await tool.execute("call-1", { content: "# hi" }, undefined, undefined, {} as never);
    expect(out.content).toEqual([{ type: "text", text: "http://test/#main" }]);
    expect(out.details).toEqual({ viewId: "main", url: "http://test/#main" });
    expect(registry.getView("main")).toMatchObject({ id: "main", mode: "md", content: "# hi" });
  });

  it("execute() forwards view/mode/title", async () => {
    const registry = new RenderService({ urlFor: (id) => `http://test/#${id}`, now: () => 42 });
    const tool = createRenderTool(registry);
    const out = await tool.execute(
      "call-2",
      { content: "<p>x</p>", mode: "html", view: "preview", title: "Preview" },
      undefined,
      undefined,
      {} as never
    );
    expect(out.details).toEqual({ viewId: "preview", url: "http://test/#preview" });
    expect(registry.getView("preview")).toMatchObject({
      id: "preview",
      mode: "html",
      content: "<p>x</p>",
      title: "Preview",
      updatedAt: 42,
    });
  });
});
