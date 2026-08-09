import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { renderReport } from "../src/architecture-render";

// ── This is the paint-check the prototype COULD NOT make. ───────────────────
// Mermaid renders client-side on `startOnLoad`; the prototype only emitted the
// HTML and eyeballed it. This test loads the FULL rendered HTML (real vendored
// mermaid UMD inlined) in a headless browser and asserts the `<pre class=mermaid>`
// blocks were actually swapped for real `<svg>` diagrams.
//
// Gated behind RUN_RENDER=1 because it needs (a) the vendored mermaid blob
// (`bun run build` / `architecture:vendor`) and (b) a one-time browser download
// (`bunx playwright install chromium`). Default `bun test` skips it so the suite
// stays offline-green with no browser required.

const RUN_RENDER = process.env.RUN_RENDER === "1";

const SAMPLE_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".planning",
  "2026-08-08-improve-codebase-architecture",
  "brainstorm",
  "sample-report.md",
);
const CSS_PATH = join(import.meta.dir, "..", "vendor", "tailwind.css");
const MERMAID_PATH = join(import.meta.dir, "..", "vendor", "mermaid.min.js");

// Sync preconditions (no network): is the vendored blob present, and is a
// chromium binary installed where Playwright expects it? Both feed declarative
// `skipIf` gates so the suite never fails for a missing optional dependency.
const mermaidVendored = existsSync(MERMAID_PATH);
let browserReady = false;
try {
  // executablePath() is synchronous; it computes the expected path without
  // launching. Verify the binary actually exists on disk.
  browserReady = existsSync(chromium.executablePath());
} catch {
  browserReady = false;
}

if (RUN_RENDER && (!mermaidVendored || !browserReady)) {
  const reasons: string[] = [];
  if (!mermaidVendored) reasons.push("vendor/mermaid.min.js missing — run `bun run build`");
  if (!browserReady) reasons.push("Playwright chromium missing — run `bunx playwright install chromium`");
  console.warn(`[paint-check] skipping: ${reasons.join("; ")}`);
}

describe.skipIf(!RUN_RENDER)("architecture-render mermaid paint", () => {
  it.skipIf(!mermaidVendored || !browserReady)(
    "paints at least one Mermaid diagram to <svg> in a headless browser",
    async () => {
      const sample = readFileSync(SAMPLE_PATH, "utf-8");
      const css = readFileSync(CSS_PATH, "utf-8");
      const mermaid = readFileSync(MERMAID_PATH, "utf-8");

      const html = renderReport(sample, css, mermaid, { mermaid: true });
      const file = join(process.env.TMPDIR || "/tmp", "architecture-mermaid-paintcheck.html");
      writeFileSync(file, html, "utf-8");

      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(`file://${file}`);
        // Mermaid swaps each `<pre class="mermaid">` for a div containing an <svg>.
        await page.waitForSelector(".mermaid svg", { timeout: 10_000 });
        const svgCount = await page.locator(".mermaid svg").count();
        expect(svgCount, "expected ≥1 painted Mermaid diagram").toBeGreaterThanOrEqual(1);
      } finally {
        await browser.close();
      }
    },
  );
});
