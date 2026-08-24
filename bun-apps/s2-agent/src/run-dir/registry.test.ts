import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadRegistry } from "./registry.ts";

describe("loadRegistry (the REGISTRY read path)", () => {
  const PKG_DIR = join(import.meta.dir, "..", "..");
  const BUN_APPS = join(PKG_DIR, "..");

  test("returns the manifest-ready shape (active extensions, deployed blocks normalized)", () => {
    const r = loadRegistry({ bunAppsDir: BUN_APPS });
    expect(r.extensions.length).toBeGreaterThan(10);
    for (const e of r.extensions) {
      expect(e.skills).toBeBoolean();
      if (e.deploy) {
        expect(e.deploy.copy).toBeArray();
        expect(e.deploy.vendor).toBeArray();
        expect(e.deploy.enabled).toBeBoolean();
      } else {
        expect(e.excludeReason).toBeString();
      }
    }
  });

  test("every registry entry points at an existing package + entry on disk", () => {
    // loadRegistry validates existence at load time; this is the same check
    // expressed as an invariant over the real registry, so a broken entry
    // fails here with the entry's name even before any consumer runs.
    expect(() => loadRegistry({ bunAppsDir: BUN_APPS })).not.toThrow();
  });

  test("outRoot expands to an absolute path under the runtime home", () => {
    const r = loadRegistry({ bunAppsDir: BUN_APPS });
    expect(r.deploy.outRoot).toMatch(/^\//);
    expect(r.deploy.outRoot.endsWith("proj/dist/s2-agent-sh")).toBe(true);
  });
});
