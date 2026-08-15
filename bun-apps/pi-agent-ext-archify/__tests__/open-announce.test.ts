/**
 * Pure unit tests for lib/open-announce.ts (zk-spawn task).
 * No bin spawn, no tool invocation — only the pure payload builder and the
 * bus-robustness wrapper. The end-to-end "exactly one webui:open on success"
 * contract stays covered by open-emit.test.ts.
 */
import { describe, it, expect } from "bun:test";
import { isAbsolute, join } from "node:path";
import { openAnnounceFor, announceOpen, type OpenAnnounceIr } from "../lib/open-announce.ts";

describe("openAnnounceFor — render", () => {
  it("builds {path, view, title} with basename view and ir.meta.title", () => {
    const ir: OpenAnnounceIr = { meta: { title: "T" }, diagram_type: "architecture" };
    expect(openAnnounceFor("render", "/tmp/x/my-diagram.html", ir)).toEqual({
      path: "/tmp/x/my-diagram.html",
      view: "my-diagram",
      title: "T",
    });
  });

  it("resolves a relative outPath to an absolute path", () => {
    const p = openAnnounceFor("render", "my-diagram.html");
    expect(p.path).toBe(join(process.cwd(), "my-diagram.html"));
    expect(isAbsolute(p.path)).toBe(true);
  });
});

describe("openAnnounceFor — title fallbacks", () => {
  it("falls back to diagram_type when meta.title is absent", () => {
    expect(openAnnounceFor("render", "/tmp/x/a.html", { diagram_type: "workflow" }).title).toBe("workflow");
  });

  it("falls back to \"archify\" when neither meta.title nor diagram_type is set", () => {
    expect(openAnnounceFor("render", "/tmp/x/a.html").title).toBe("archify");
    expect(openAnnounceFor("render", "/tmp/x/a.html", {}).title).toBe("archify");
  });
});

describe("openAnnounceFor — delta", () => {
  it("prefixes the view with compare-", () => {
    expect(openAnnounceFor("delta", "/tmp/x/a.html", { diagram_type: "architecture-delta" })).toEqual({
      path: "/tmp/x/a.html",
      view: "compare-a",
      title: "architecture-delta",
    });
  });

  it("strips the .html extension, including when it is absent", () => {
    expect(openAnnounceFor("delta", "/tmp/x/a.html").view).toBe("compare-a");
    expect(openAnnounceFor("delta", "/tmp/x/a").view).toBe("compare-a");
  });

  it("strips the extension case-insensitively (aligns with the route's case-insensitive .html MIME branch)", () => {
    // Review fix: "X.HTML" -> "X" — the /files route serves .HTML as
    // text/html, so the view name must not keep a .HTML tail either.
    expect(openAnnounceFor("render", "/tmp/x/X.HTML").view).toBe("X");
    expect(openAnnounceFor("delta", "/tmp/x/Diagram.Html").view).toBe("compare-Diagram");
  });
});

describe("announceOpen — bus wrapper", () => {
  it("emits webui:open once with the built payload", () => {
    const seen: { channel: string; payload: unknown }[] = [];
    announceOpen({ emit: (channel, payload) => seen.push({ channel, payload }) }, "render", "/tmp/x/my-diagram.html", {
      meta: { title: "T" },
      diagram_type: "architecture",
    });
    expect(seen).toEqual([
      { channel: "webui:open", payload: { path: "/tmp/x/my-diagram.html", view: "my-diagram", title: "T" } },
    ]);
  });

  it("does not throw when the bus is undefined", () => {
    expect(() => announceOpen(undefined, "render", "/tmp/x/a.html")).not.toThrow();
  });

  it("does not throw when emit throws", () => {
    const bus = { emit: () => { throw new Error("listener exploded"); } };
    expect(() => announceOpen(bus, "delta", "/tmp/x/a.html")).not.toThrow();
  });
});

describe("openAnnounceFor — payload shape", () => {
  it("has EXACTLY the keys path/view/title", () => {
    expect(Object.keys(openAnnounceFor("render", "/tmp/x/a.html")).sort()).toEqual(["path", "title", "view"]);
    expect(Object.keys(openAnnounceFor("delta", "/tmp/x/a.html", { diagram_type: "d" })).sort()).toEqual(["path", "title", "view"]);
  });
});
