/**
 * Repo lint (ADR-0007 defense-in-depth): no superpowers artifact may live under
 * the upstream paths `docs/superpowers/` or `.superpowers/`. Runs in the ext's
 * `bun run test` matrix (ci.yml:111) so leakage fails CI with zero wiring.
 */
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tests/ → ext pkg → bun-apps → repo root (3 levels up)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Files grandfathered under the upstream paths (the ADR-0007 baseline). */
const ALLOWED = new Set(["docs/superpowers/audit/2026-07-18-workflow-pack-finding-docket.md"]);

function listFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const stat = lstatSync(p);
    if (stat.isSymbolicLink()) continue; // Skip symlinks
    if (stat.isDirectory()) listFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

test("no superpowers artifacts leak to upstream paths (ADR-0007)", () => {
  const offenders: string[] = [];
  for (const root of ["docs/superpowers", ".superpowers"]) {
    for (const abs of listFiles(join(repoRoot, root))) {
      const rel = abs.slice(repoRoot.length + 1).replace(/\\/g, "/");
      if (!ALLOWED.has(rel)) offenders.push(rel);
    }
  }
  expect(offenders).toEqual([]);
});
