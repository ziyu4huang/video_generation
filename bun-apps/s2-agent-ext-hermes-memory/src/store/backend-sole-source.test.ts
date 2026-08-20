import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// C5-lite sole-source gate: `backend-factory.ts` is the ONLY non-test src file
// allowed to CONSTRUCT a `SqliteBackend` (`new SqliteBackend(`). Before C5-lite
// there were five construction sites (backend-factory, card-store, and three
// ephemeral opens in knowledge-search-tool) — each a private copy of the same
// `new SqliteBackend(dir)` + `init()` sequence. Forbidding the raw constructor
// outside the factory forces every caller (bundle path, card-store, ephemeral
// read-only opens) through the one construction path, so migrations/WAL setup
// cannot drift between call sites. Mirrors the C1 fence-split gate
// (frontmatter-codec-sole-source.test.ts — its leaf hoisted to
// s2-agent-core-interface in L2).
const here = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(here, "..");

/** Files sanctioned to construct a SqliteBackend directly: the factory itself
 *  (that IS the sole source). No other sanctioned sites exist today — if a
 *  legitimate one appears (e.g. a corruption-recovery test helper in non-test
 *  src), add it here explicitly with a justification, like the C1 gate does. */
const SANCTIONED = new Set(["store/backend-factory.ts"]);

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walkTs(full, acc);
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

const NEW_SQLITE_BACKEND_RE = /new\s+SqliteBackend\s*\(/;

describe("backend sole-source gate (C5-lite)", () => {
  it("no non-test src file constructs a SqliteBackend outside the factory", () => {
    const offenders: string[] = [];
    for (const file of walkTs(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file);
      if (SANCTIONED.has(rel)) continue;
      if (NEW_SQLITE_BACKEND_RE.test(readFileSync(file, "utf8"))) {
        offenders.push(rel);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `non-test src files constructing SqliteBackend directly (must delegate to store/backend-factory.ts createSqliteBackend): ${offenders.join(", ")}`,
    );
  });

  it("the factory is still the sanctioned construction site (guard against a moved/renamed seam)", () => {
    const factory = readFileSync(join(SRC_ROOT, "store/backend-factory.ts"), "utf8");
    assert.match(factory, NEW_SQLITE_BACKEND_RE);
    assert.match(factory, /export async function createSqliteBackend/);
  });
});
