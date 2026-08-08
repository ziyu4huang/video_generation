import { describe, expect, it } from "bun:test";
import { renderReport } from "../src/architecture-render";

describe("architecture-render smoke", () => {
  it("renders a non-empty self-contained HTML document for a minimal report", () => {
    const md = "# Architecture review — x\n\n## Candidate 1: Do the thing — Strong\n\n**Files**\n`a.ts`\n";
    const html = renderReport(md, "/*css*/", "", { mermaid: false });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<html");
    expect(html).toContain("Architecture review — x");
    expect(html).toContain("Do the thing");
    expect(html).toContain('data-strength="emerald"');
    expect(html).toContain("/*css*/"); // CSS inlined
  });
});
