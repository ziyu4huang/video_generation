import { describe, expect, it } from "bun:test";
import { renderReport } from "../src/architecture-render";

describe("architecture-render smoke", () => {
  it("renders a non-empty self-contained HTML document for a minimal report (mermaid stubbed)", () => {
    // Stubbed mermaid blob — the test asserts STRUCTURE, not real mermaid, so
    // it never depends on the ~3.4 MiB vendored binary (now gitignored and
    // build-copied from node_modules at build time).
    const STUB = "/* mermaid stub */";
    const md = "# Architecture review — x\n\n## Candidate 1: Do the thing — Strong\n\n**Files**\n`a.ts`\n";
    const html = renderReport(md, "/*css*/", STUB, { mermaid: true });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<html");
    expect(html).toContain("Architecture review — x");
    expect(html).toContain("Do the thing");
    expect(html).toContain('data-strength="emerald"');
    expect(html).toContain("/*css*/"); // CSS inlined
    expect(html).toContain(STUB); // mermaid stub inlined into the <script> block
    expect(html).toContain("mermaid.initialize"); // mermaid init harness present
  });
});
