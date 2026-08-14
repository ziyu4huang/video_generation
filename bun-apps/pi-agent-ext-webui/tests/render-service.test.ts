import { describe, expect, it } from "bun:test";
import { RenderService } from "../src/render-service.js";

describe("RenderService", () => {
  it("render() creates the default view 'main' with mode 'md'", () => {
    const r = new RenderService({ urlFor: (id) => `http://x/#${id}`, now: () => 100 });
    const out = r.render({ content: "# hi" });
    expect(out).toEqual({ viewId: "main", url: "http://x/#main" });
    expect(r.getView("main")).toMatchObject({
      id: "main",
      mode: "md",
      content: "# hi",
      updatedAt: 100,
    });
  });

  it("render() accepts an explicit view/mode/title", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 100 });
    r.render({ content: "<p>x</p>", mode: "html", view: "preview", title: "Preview" });
    expect(r.getView("preview")).toMatchObject({
      id: "preview",
      mode: "html",
      content: "<p>x</p>",
      title: "Preview",
    });
  });

  it("render() does NOT store a title key when none is given (clean shape)", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    r.render({ content: "a", view: "v" });
    expect(r.getView("v")).not.toHaveProperty("title");
  });

  it("render() REPLACES a view on re-render to the same id and updatedAt advances", () => {
    let t = 100;
    const r = new RenderService({ urlFor: () => "#", now: () => t });
    r.render({ content: "a", view: "v" });
    t = 200;
    r.render({ content: "b", view: "v" });
    expect(r.getView("v")).toMatchObject({ id: "v", content: "b", updatedAt: 200 });
    expect(r.listViews().length).toBe(1);
  });

  it("listViews() returns every view", () => {
    const r = new RenderService({ urlFor: () => "#" });
    r.render({ content: "a", view: "v1" });
    r.render({ content: "b", view: "v2" });
    const ids = r.listViews().map((v) => v.id).sort();
    expect(ids).toEqual(["v1", "v2"]);
  });

  it("getView() returns undefined for an unknown id", () => {
    const r = new RenderService();
    expect(r.getView("nope")).toBeUndefined();
  });

  it("subscribe() fires (viewId, updatedAt) on each render and the returned fn unsubscribes", () => {
    let t = 1;
    const r = new RenderService({ urlFor: () => "#", now: () => t });
    const seen: Array<[string, number]> = [];
    const off = r.subscribe((viewId, updatedAt) => seen.push([viewId, updatedAt]));
    expect(r.subscriberCount).toBe(1);

    t = 5; r.render({ content: "a", view: "v1" });
    t = 9; r.render({ content: "b", view: "v2" });
    off();
    expect(r.subscriberCount).toBe(0);

    t = 20; r.render({ content: "c", view: "v3" });
    expect(seen).toEqual([
      ["v1", 5],
      ["v2", 9],
    ]);
  });

  it("default urlFor is '#<id>' and default now is wall-clock", () => {
    const r = new RenderService();
    const out = r.render({ content: "x", view: "z" });
    expect(out.url).toBe("#z");
    expect(typeof r.getView("z")?.updatedAt).toBe("number");
  });
});

describe("RenderService — present-as-view fields (spec Decision A)", () => {
  it("render() round-trips controls + presentId onto the stored view", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 100 });
    r.render({
      content: "# approve?",
      view: "present",
      controls: [
        { id: "approve", label: "Approve" },
        { id: "regenerate", label: "Regenerate…", takesInput: true },
      ],
      presentId: "present_123_1",
    });
    expect(r.getView("present")).toMatchObject({
      id: "present",
      mode: "md",
      content: "# approve?",
      controls: [
        { id: "approve", label: "Approve" },
        { id: "regenerate", label: "Regenerate…", takesInput: true },
      ],
      presentId: "present_123_1",
      updatedAt: 100,
    });
  });

  it("render() does NOT store controls/presentId keys when absent (clean shape)", () => {
    const r = new RenderService({ urlFor: () => "#", now: () => 1 });
    r.render({ content: "a", view: "v" });
    const v = r.getView("v")!;
    expect(v).not.toHaveProperty("controls");
    expect(v).not.toHaveProperty("presentId");
  });
});
