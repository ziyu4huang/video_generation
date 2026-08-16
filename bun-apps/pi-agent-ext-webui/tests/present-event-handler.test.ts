import { describe, expect, it } from "bun:test";
import { createPresentEventHandler } from "../src/present-event-handler.js";
import { RenderService } from "../src/render-service.js";

describe("createPresentEventHandler", () => {
  const CONTROLS = [
    { id: "approve", label: "Approve" },
    { id: "regenerate", label: "Regenerate…", takesInput: true },
  ];

  it("a valid payload mints the DEFAULT view 'present' with controls + presentId", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 7 });
    const handler = createPresentEventHandler(registry);
    handler({ content: "# pick", controls: CONTROLS, id: "present_1_1" });
    expect(registry.getView("present")).toMatchObject({
      id: "present",
      mode: "md",
      content: "# pick",
      controls: CONTROLS,
      presentId: "present_1_1",
      updatedAt: 7,
    });
  });

  it("forwards an explicit view/mode/title; id-less payload gets a MINTED presentId (spec §C2)", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 7 });
    const registered: { id: string; title?: string }[] = [];
    const handler = createPresentEventHandler(registry, {
      onEventPresent: (info) => registered.push(info),
    });
    handler({ content: "<p>x</p>", mode: "html", view: "v1", title: "T", controls: CONTROLS });
    const v = registry.getView("v1")!;
    expect(v).toMatchObject({ id: "v1", mode: "html", content: "<p>x</p>", title: "T", controls: CONTROLS });
    expect(typeof v.presentId).toBe("string"); // minted by the handler (spec §C2)
    expect(registered).toEqual([{ id: v.presentId as string, title: "T" }]);
  });

  it("ignores an invalid mode (falls back to 'md')", () => {
    const registry = new RenderService({ urlFor: () => "#" });
    const handler = createPresentEventHandler(registry);
    handler({ content: "x", mode: "bogus", controls: CONTROLS });
    expect(registry.getView("present")?.mode).toBe("md");
  });

  it("ignores a non-string view (hardened type-guard; previously forwarded raw as a view id)", () => {
    const registry = new RenderService({ urlFor: () => "#" });
    const handler = createPresentEventHandler(registry);
    handler({ content: "x", controls: CONTROLS, view: 42 });
    expect(registry.listViews()).toEqual([]);
  });

  it("ignores malformed payloads without throwing (missing/malformed controls, bad id)", () => {
    const registry = new RenderService({ urlFor: () => "#" });
    const handler = createPresentEventHandler(registry);
    expect(() => handler(null)).not.toThrow();
    expect(() => handler(undefined)).not.toThrow();
    expect(() => handler({})).not.toThrow();
    expect(() => handler({ content: 123, controls: CONTROLS })).not.toThrow();
    expect(() => handler({ content: "x" })).not.toThrow(); // missing controls
    expect(() => handler({ content: "x", controls: [] })).not.toThrow(); // empty is VALID (schema-validated upstream)
    expect(() => handler({ content: "x", controls: [{ label: "no id" }] })).not.toThrow();
    expect(() => handler({ content: "x", controls: [{ id: "a", label: "A", takesInput: "yes" }] })).not.toThrow();
    expect(() => handler({ content: "x", controls: CONTROLS, id: 42 })).not.toThrow(); // non-string id
    // The ONLY minted view is the EMPTY-controls payload — valid by design (the
    // tool schema enforces minItems:1 upstream); every malformed one was ignored.
    expect(registry.listViews()).toMatchObject([{ id: "present", content: "x", controls: [] }]);
  });

  it("v2 (F3): appends image markdown from the injected converter when images are present", () => {
    const registry = new RenderService({ urlFor: () => "#", now: () => 7 });
    const handler = createPresentEventHandler(registry, {
      toImageMarkdown: (paths) => paths.map((p) => `![image](/output/0/${p})`).join("\n"),
    });
    handler({ content: "# pick", controls: CONTROLS, id: "p1", images: ["shot.png"] });
    expect(registry.getView("present")).toMatchObject({
      id: "present",
      presentId: "p1",
      controls: CONTROLS,
      content: "# pick\n\n![image](/output/0/shot.png)",
    });
  });

  it("v2 (F3): no images -> content unchanged; malformed images ignored", () => {
    const registry = new RenderService({ urlFor: () => "#" });
    const handler = createPresentEventHandler(registry);
    handler({ content: "x", controls: CONTROLS, images: ["a.png"] }); // default no-op
    expect(registry.getView("present")?.content).toBe("x");
    handler({ content: "y", controls: CONTROLS, images: 42 }); // malformed
    expect(registry.getView("present")?.content).toBe("y");
  });
});
