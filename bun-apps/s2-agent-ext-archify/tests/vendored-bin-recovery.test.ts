import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(PKG_ROOT, "vendored/bin/archify.mjs");

const run = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8" });

// The vendored snapshot must be a faithful archify@2.12.0 re-copy: these
// developer-facing subcommands reference files that were missing from an
// incomplete vendor-copy (recipes/, examples/*.json, bin/preview.mjs,
// bin/open-artifact.mjs, scripts/render-examples.mjs). They must work.
describe("vendored archify bin — recovered subcommands", () => {
  it("doctor reports the snapshot is ready (all files present)", () => {
    const r = run(["doctor"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Archify is ready");
  });

  it("guide --json lists scenario recipes", () => {
    const r = run(["guide", "--json"]);
    expect(r.status).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok?: boolean; mode?: string };
    expect(payload.ok).toBe(true);
    expect(payload.mode).toBe("list");
  });

  it("examples re-renders every bundled example IR to HTML", () => {
    // commandExamples() ignores argv and writes the regenerated HTMLs back
    // into the snapshot examples dir; compare before/after and clean up so the
    // test leaves no generated artifacts in the vendored tree.
    const examplesDir = join(PKG_ROOT, "vendored/examples");
    // Stale gitignored renders from earlier runs are overwritten in place,
    // which would zero the new-file diff; drop them first so the count is
    // deterministic regardless of leftover state.
    for (const f of readdirSync(examplesDir).filter((f) => f.endsWith(".html"))) {
      rmSync(join(examplesDir, f), { force: true });
    }
    const before = readdirSync(examplesDir).filter((f) => f.endsWith(".html"));
    const r = run(["examples"]);
    expect(r.status).toBe(0);
    const after = readdirSync(examplesDir).filter((f) => f.endsWith(".html"));
    expect(after.length - before.length).toBeGreaterThanOrEqual(5);
    for (const f of after.filter((f) => !before.includes(f))) {
      rmSync(join(examplesDir, f), { force: true });
    }
  });

  it("demo renders the bundled web-app architecture example", () => {
    const out = mkdtempSync(join(tmpdir(), "archify-demo-"));
    const r = run(["demo", out]);
    expect(r.status).toBe(0);
    expect(existsSync(join(out, "archify-demo.html"))).toBe(true);
  });
});
