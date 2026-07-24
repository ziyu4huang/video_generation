import { describe, it, expect } from "bun:test";
import { resolveOutputPath } from "../lib/output-path.ts";

describe("resolveOutputPath", () => {
  it("honors explicit outputPath (absolute)", () => {
    expect(resolveOutputPath({ cwd: "/work", outputPath: "/tmp/x.html", diagramType: "architecture" }))
      .toBe("/tmp/x.html");
  });
  it("honors explicit outputPath (cwd-relative)", () => {
    expect(resolveOutputPath({ cwd: "/work", outputPath: "out/x.html", diagramType: "architecture" }))
      .toBe("/work/out/x.html");
  });
  it("falls back to meta.output (cwd-relative) when no outputPath", () => {
    expect(resolveOutputPath({ cwd: "/work", metaOutput: "my-map.html", diagramType: "architecture" }))
      .toBe("/work/my-map.html");
  });
  it("falls back to <diagram_type>.html when neither given", () => {
    expect(resolveOutputPath({ cwd: "/work", diagramType: "workflow" })).toBe("/work/workflow.html");
  });
  it("uses collision-safe slug when default exists", () => {
    expect(resolveOutputPath({ cwd: "/work", diagramType: "architecture", exists: () => true }))
      .toMatch(/^\/work\/architecture-[0-9a-z]{6}\.html$/);
  });
});
