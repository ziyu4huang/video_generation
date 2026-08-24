import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Source-pinning guard for the ONE-LINE wiring that motivates the
 * __piBakedProviders seam: `getRegistry()` in src/agent.ts must layer the
 * host-published baked catalog onto the ModelRuntime it builds from
 * ~/.pi/agent/models.json. If someone deletes that call (or moves it behind
 * the ModelRegistry construction), the unit tests of
 * registerBakedProvidersFromSeam still pass — and the silent-fallback bug
 * this fixes ("requested model … unavailable" → empty vision output → OCR
 * degrade, measured 2026-08-24) recurs undetected. Integration-testing the
 * real path would need a disposable pi agent dir + live ModelRuntime, which
 * is disproportionate for a one-line wiring; pin the source instead (same
 * class of guard as s2-agent's extension-entry-typechecked.test.ts).
 */
describe("getRegistry baked-providers wiring (source pin)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "agent.ts"), "utf8");

  test("getRegistry applies registerBakedProvidersFromSeam to the runtime before wrapping it in a ModelRegistry", () => {
    // Extract the getRegistry body up to the end of its promise chain.
    const start = src.indexOf("private getRegistry()");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start, src.indexOf("return this.registryPromise;", start));
    const callIdx = body.indexOf("registerBakedProvidersFromSeam(runtime)");
    const wrapIdx = body.indexOf("new ModelRegistry(runtime)");
    expect(callIdx).toBeGreaterThan(0);
    expect(wrapIdx).toBeGreaterThan(0);
    // Register on the RUNTIME first, then wrap — ModelRegistry is a stateless
    // facade over ModelRuntime, so registering after wrapping also works, but
    // the runtime-first order guarantees the registry's first snapshot already
    // includes the baked catalog.
    expect(callIdx).toBeLessThan(wrapIdx);
  });

  test("no other ModelRuntime.create registry site bypasses the seam", () => {
    // agent.ts must have exactly one ModelRuntime construction site — the
    // guarded getRegistry. A second site would silently lack the baked catalog.
    const sites = src.match(/ModelRuntime\.create\(/g) ?? [];
    expect(sites.length).toBe(1);
  });
});
