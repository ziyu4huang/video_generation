import { describe, expect, it } from "bun:test";
import { createRenderEventHandler } from "../src/render-event-handler.js";
import { RenderService } from "../src/render-service.js";

describe("createRenderEventHandler", () => {
  it("a valid payload lands in the registry (default view 'main', mode 'md')", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 7 });
    const handler = createRenderEventHandler(registry);
    handler({ content: "# hi" });
    expect(registry.getView("main")).toMatchObject({ id: "main", mode: "md", content: "# hi", updatedAt: 7 });
  });

  it("forwards view/mode/title", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 7 });
    const handler = createRenderEventHandler(registry);
    handler({ content: "<p>x</p>", mode: "html", view: "v1", title: "T" });
    expect(registry.getView("v1")).toMatchObject({
      id: "v1",
      mode: "html",
      content: "<p>x</p>",
      title: "T",
      updatedAt: 7,
    });
  });

  it("ignores an invalid mode (falls back to 'md')", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 1 });
    const handler = createRenderEventHandler(registry);
    handler({ content: "x", mode: "bogus" });
    expect(registry.getView("main")?.mode).toBe("md");
  });

  it("ignores malformed payloads without throwing", () => {
    const registry = new RenderService({ urlFor: () => "#" });
    const handler = createRenderEventHandler(registry);
    expect(() => handler(null)).not.toThrow();
    expect(() => handler(undefined)).not.toThrow();
    expect(() => handler({})).not.toThrow();
    expect(() => handler({ content: 123 })).not.toThrow();
    expect(() => handler("nope")).not.toThrow();
    expect(() => handler({ mode: "md" })).not.toThrow(); // missing content
    expect(registry.listViews()).toEqual([]);
  });
});
