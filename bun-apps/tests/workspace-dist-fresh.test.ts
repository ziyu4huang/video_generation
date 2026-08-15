/**
 * workspace-dist-fresh — regression gate: no @repo/* package may have a dist/
 * older than (or absent for) its src.
 *
 * WHY THIS IS A GATE (incident 2026-08-15): four packages resolve their entry
 * to `./dist/index.js` — a gitignored, locally built artifact (workflow,
 * superpowers, wayfind, webui). When a refactor edits src without rebuilding,
 * the stale dist keeps importing removed/renamed exports from LIVE sibling
 * barrels, and the first consumer blows up with a cryptic jiti `NameTooLong`
 * (stale workflow dist still imported `homeDir` after cf6f1394 removed it from
 * the subagent barrel → movie-director un-loadable at `./pi-agent.sh` boot).
 * Remote CI can never see this class (dist is gitignored → always fresh there);
 * the boot-time patch (pi-agent/src/patches/ensure-workspace-dist.ts) self-heals
 * a dev machine, and THIS gate turns the same detection into a local-CI
 * regression-gate. ORDERING NOTE: inside a local_ci run the per-package matrix
 * executes BEFORE this gate, and pi-agent's suite imports the patch — which
 * self-heals any staleness — so in that flow this gate is a last-line
 * confirmation that fires only when the heal itself failed. Its standalone
 * value is `bun run test:dist` alone (fresh clone, patch not yet booted, or
 * BUN_PI_ENSURE_WORKSPACE_DIST=0): an actionable failure message instead of a
 * cryptic NameTooLong.
 *
 * ONE implementation, no second copy: detection logic lives in
 * pi-agent/src/workspace-dist-staleness.ts (pure helpers, unit-tested there);
 * this gate and the boot patch both consume it. Missing dist counts as stale —
 * a consumer's tests would fail on it anyway; the message says how to build.
 *
 * Registered as `bun run test:dist` (bun-apps root) and wired into the
 * regression-gates job of .github/workflows/ci.yml.disabled.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  distEntryMain,
  newestMtimeMs,
  newestSrcMtimeMs,
  shouldRebuildDist,
} from "../pi-agent/src/workspace-dist-staleness.ts";

const BUN_APPS = import.meta.dirname + "/..";

describe("workspace-dist-fresh gate", () => {
  test("every @repo/* dist-entry package has a dist at least as new as its src", () => {
    const stale: string[] = [];
    let checked = 0;

    for (const dir of readdirSync(BUN_APPS, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(readFileSync(join(BUN_APPS, dir.name, "package.json"), "utf8"));
      } catch {
        continue;
      }
      if (typeof pkg.name !== "string" || !pkg.name.startsWith("@repo/")) continue;
      const entry = distEntryMain(pkg);
      if (!entry) continue; // src-entry package — no build artifact

      checked++;
      const newestSrcMs = newestSrcMtimeMs(join(BUN_APPS, dir.name, "src"));
      const newestDistMs = newestMtimeMs(join(BUN_APPS, dir.name, "dist"));
      if (shouldRebuildDist({ newestSrcMs, newestDistMs })) {
        const why = newestDistMs === null ? "dist/ is MISSING" : "dist/ is older than src";
        stale.push(`${pkg.name}: ${why} — ( cd bun-apps/${dir.name} && bun run build )`);
      }
    }

    expect(checked, "dist-entry packages found (if 0, the gate is scanning nothing)").toBeGreaterThan(0);
    expect(
      stale.length === 0 ? "all fresh" : `stale dist builds:\n  ${stale.join("\n  ")}`,
    ).toBe("all fresh");
  });
});
