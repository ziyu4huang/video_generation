import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReport } from "../lib/architecture-render";

// Canonical architecture-review Markdown + the committed curated Tailwind build.
// Both are deterministic, committed inputs — so renders of them are byte-stable.
const SAMPLE = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "..",
    ".planning",
    "done",
    "2026-08-08-improve-codebase-architecture",
    "brainstorm",
    "sample-report.md",
  ),
  "utf-8",
);
const CSS = readFileSync(join(import.meta.dir, "..", "vendored", "tailwind.css"), "utf-8");

const GOLDEN_DIR = join(import.meta.dir, "fixtures");
const GOLDEN = join(GOLDEN_DIR, "architecture-render.golden.html");

// A tiny stand-in for the ~3.4 MiB vendored mermaid UMD blob. Using it keeps
// the committed golden fixture a few KB and keeps the suite offline + small;
// the REAL blob is exercised only by the gated Playwright paint-check.
const MERMAID_STUB = "/* mermaid stub */";

describe("architecture-render smoke", () => {
  it("renders a non-empty self-contained HTML document for a minimal report (mermaid stubbed)", () => {
    const md = "# Architecture review — x\n\n## Candidate 1: Do the thing — Strong\n\n**Files**\n`a.ts`\n";
    const html = renderReport(md, "/*css*/", MERMAID_STUB, { mermaid: true });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("<html");
    expect(html).toContain("Architecture review — x");
    expect(html).toContain("Do the thing");
    expect(html).toContain('data-strength="emerald"');
    expect(html).toContain("/*css*/"); // CSS inlined
    expect(html).toContain(MERMAID_STUB); // mermaid stub inlined into the <script> block
    expect(html).toContain("mermaid.initialize"); // mermaid init harness present
  });
});

// ── Task 3: offline self-containment + determinism ─────────────────────────

describe("architecture-render offline + determinism", () => {
  it("emits zero non-vendored external references (no CDN, no runtime network)", () => {
    // Full render with the real inlined Tailwind CSS + a stubbed mermaid blob.
    const html = renderReport(SAMPLE, CSS, MERMAID_STUB, { mermaid: true });

    // A browser only reaches the network via these three shapes. The converter
    // inlines ALL assets (CSS in <style>, mermaid in <script>), so none may be
    // present. The curated Tailwind build carries ONE `https://tailwindcss.com`
    // token — but only inside a `/*! license */` comment, which none of these
    // patterns match (it is not a fetch, just an attribution).
    const externalScripts = [...html.matchAll(/<script[^>]*\bsrc\s*=/gi)];
    const externalLinks = [...html.matchAll(/<link[^>]*\bhref\s*=\s*["']?\s*https?:\/\//gi)];
    const externalCssUrls = [...html.matchAll(/url\(\s*["']?\s*https?:\/\//gi)];

    expect(externalScripts, "must not contain <script src=…>").toHaveLength(0);
    expect(externalLinks, "must not contain <link href=https://…>").toHaveLength(0);
    expect(externalCssUrls, "must not contain url(https://…) in CSS").toHaveLength(0);
  });

  it("is deterministic — same input yields byte-identical output across calls", () => {
    const a = renderReport(SAMPLE, CSS, "", { mermaid: false });
    const b = renderReport(SAMPLE, CSS, "", { mermaid: false });
    expect(a).toBe(b);
  });
});

// ── Task 3: golden-HTML snapshot (byte-stable for fixed input) ──────────────

describe("architecture-render golden snapshot", () => {
  it("matches the committed golden (regenerate deliberately with UPDATE_GOLDEN=1)", () => {
    // Mermaid stubbed (omitted would also work) so the golden stays a few KB and
    // never contains the 3.4 MiB blob. The golden captures the converter's HTML
    // shape: header + legend + candidate cards (badges, before/after collapse,
    // mermaid fences → <pre class=mermaid>, ASCII → <pre class=ascii>) + top rec.
    const html = renderReport(SAMPLE, CSS, MERMAID_STUB, { mermaid: true });

    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(GOLDEN)) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(GOLDEN, html, "utf-8");
    }

    expect(html).toEqual(readFileSync(GOLDEN, "utf-8"));
  });
});
