/**
 * workspace-dist-fresh — tripwire gate: ZERO @repo/* packages may resolve their
 * package root to a dist/ build output.
 *
 * HISTORY: this gate used to check staleness (no dist/ older than src/) for the
 * four dist-entry packages (workflow, superpowers, wayfind, webui) after the
 * 2026-08-15 jiti `NameTooLong` incident (cf6f1394: stale workflow dist still
 * imported a removed export; movie-director un-loadable at boot; remote CI
 * could never see it — dist is gitignored). The src-entry migration
 * (.planning/2026-08-15-src-entry-migration/, tickets 02–04) flipped all four
 * roots to ./src/index.ts and deleted the build steps, retiring the bug class
 * at the habitat. The gate now guards the retirement itself: a re-added
 * `main → ./dist/…` package resurrects the whole class (stale gitignored
 * artifacts, boot-order NameTooLong, CI-invisible drift), so one appearing is
 * a REGRESSION, not a staleness to patch. The remediation is migration, not
 * `bun run build`.
 *
 * ONE implementation, no second copy: detection lives in
 * pi-agent/src/workspace-dist-staleness.ts (pure helpers; distEntryMain is the
 * same predicate the boot patch used).
 *
 * Registered as `bun run test:dist` (bun-apps root) and wired into the
 * regression-gates job of .github/workflows/ci.yml.disabled.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { distEntryMain } from "../pi-agent/src/workspace-dist-staleness.ts";

const BUN_APPS = import.meta.dirname + "/..";

describe("workspace-dist-fresh gate", () => {
  test("zero @repo/* packages resolve their root to dist (src-entry invariant)", () => {
    const distEntries: string[] = [];

    for (const dir of readdirSync(BUN_APPS, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      let pkg: Record<string, unknown>;
      try {
        pkg = JSON.parse(readFileSync(join(BUN_APPS, dir.name, "package.json"), "utf8"));
      } catch {
        continue;
      }
      if (typeof pkg.name !== "string" || !pkg.name.startsWith("@repo/")) continue;
      if (distEntryMain(pkg)) {
        distEntries.push(`${pkg.name} (root → ${String(distEntryMain(pkg))})`);
      }
    }

    expect(
      distEntries.length === 0
        ? "all src-entry"
        : `dist-root packages reintroduced (the stale-dist class is retired — migrate to a src root):\n  ${distEntries.join("\n  ")}`,
    ).toBe("all src-entry");
  });
});
