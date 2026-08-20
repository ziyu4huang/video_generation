import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReport } from "../lib/architecture-render";

/**
 * The paint-check: mermaid renders CLIENT-SIDE on `startOnLoad`, so only a real
 * engine can prove the `<pre class="mermaid">` blocks become `<svg>`.
 *
 * ## Why this test used to prove nothing (fixed 2026-08-21)
 *
 * It was gated behind THREE conditions — `RUN_RENDER=1`, a vendored mermaid
 * blob, and a Playwright chromium install — so it never ran in practice. Worse,
 * its sample path was missing the `done/` segment the effort folder had since
 * moved under, so even with all three satisfied it would have thrown on read.
 * A gate nobody can satisfy is indistinguishable from a deleted test.
 *
 * All three gates are gone:
 *   - `Bun.WebView` (Bun 1.4) drives the system WebKit with NOTHING to install
 *     — measured ~350 ms cold on the development machine.
 *   - mermaid comes from `node_modules` (it is a declared dependency), with the
 *     vendored blob preferred when a build produced one.
 *   - the sample path is correct, and asserted to exist rather than assumed.
 */

const SAMPLE = join(
  import.meta.dir,
  "..", "..", "..",
  ".planning",
  "done",
  "2026-08-08-improve-codebase-architecture",
  "brainstorm",
  "sample-report.md",
);
const CSS_PATH = join(import.meta.dir, "..", "vendored", "tailwind.css");
const VENDORED_MERMAID = join(import.meta.dir, "..", "vendored", "mermaid.min.js");
const NODE_MERMAID = join(import.meta.dir, "..", "node_modules", "mermaid", "dist", "mermaid.min.js");

/** Vendored blob first (a build may have produced one), else the dependency. */
function mermaidSource(): string {
  const path = existsSync(VENDORED_MERMAID) ? VENDORED_MERMAID : NODE_MERMAID;
  return readFileSync(path, "utf-8");
}

describe("architecture-render mermaid paint", () => {
  it("has the inputs it claims to have", () => {
    // The previous version silently depended on a path that no longer existed.
    expect(existsSync(SAMPLE), `sample report missing: ${SAMPLE}`).toBe(true);
    expect(existsSync(CSS_PATH), `tailwind css missing: ${CSS_PATH}`).toBe(true);
    expect(
      existsSync(VENDORED_MERMAID) || existsSync(NODE_MERMAID),
      "mermaid is neither vendored nor installed"
    ).toBe(true);
  });

  it("emits mermaid blocks as <pre class=\"mermaid\"> with the runtime inlined", () => {
    const html = renderReport(readFileSync(SAMPLE, "utf-8"), "/*css*/", "/*mermaid*/", {
      mermaid: true,
    });
    expect((html.match(/<pre class="mermaid">/g) ?? []).length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("mermaid.initialize");
  });

  it("paints at least one Mermaid diagram to <svg> in a real engine", async () => {
    const html = renderReport(
      readFileSync(SAMPLE, "utf-8"),
      readFileSync(CSS_PATH, "utf-8"),
      mermaidSource(),
      { mermaid: true }
    );
    const file = join(tmpdir(), "architecture-mermaid-paintcheck.html");
    writeFileSync(file, html, "utf-8");

    await using view = new Bun.WebView({ width: 1000, height: 800 });
    await view.navigate(`file://${file}`);
    // mermaid swaps each <pre class="mermaid"> for an <svg>; poll rather than
    // sleep so a fast machine is not penalised and a slow one is not flaky.
    const raw = (await view.evaluate(`(() => new Promise(resolve => {
      var tries = 0;
      var tick = function () {
        var n = document.querySelectorAll('.mermaid svg, pre.mermaid svg').length;
        if (n > 0 || ++tries > 100) resolve(JSON.stringify({ svgCount: n, tries: tries }));
        else setTimeout(tick, 100);
      };
      tick();
    }))()`)) as string;
    const { svgCount } = JSON.parse(raw) as { svgCount: number; tries: number };
    expect(svgCount, "expected >=1 painted Mermaid diagram").toBeGreaterThanOrEqual(1);
  }, 60_000);
});
