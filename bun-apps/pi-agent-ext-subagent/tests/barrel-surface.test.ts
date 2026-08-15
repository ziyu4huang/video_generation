/**
 * Guards the two rules documented at the top of `src/index.ts`.
 *
 * Why this exists: the barrel had grown to 114 exported names, of which 21 were
 * ever imported through it. ~68 of the rest were straight pass-throughs of
 * `@repo/pi-agent-ext-core-runtime` symbols that no peer package reached for.
 * That is a wide interface with no leverage behind it — every reader of this
 * package's public API had to scan five times more surface than exists.
 *
 * The facade is not simply deletable, which is the subtle part. `pi-agent`,
 * `pi-agent-ext-obsidian`, `pi-agent-ext-file2md` and `pi-agent-ext-knowledge-card`
 * do NOT declare `@repo/pi-agent-ext-core-runtime` in package.json, so for them
 * this barrel is the only legal path to those symbols (bun-apps/tests/dep-guard.test.ts
 * invariant 1 rejects an undeclared @repo edge). So the rule is not "no
 * pass-throughs" — it is "a pass-through must have a named peer that needs it".
 *
 * Checked in BOTH directions, so neither a newly-added re-export nor a facade
 * entry whose last consumer moved away can drift past:
 *   1. every core-runtime name re-exported by src/index.ts is in FACADE_SYMBOLS
 *   2. every FACADE_SYMBOLS name is still re-exported AND still imported through
 *      the barrel by the consumer named against it
 *   3. no file under src/ imports through its own barrel
 */

import * as assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUN_APPS = resolve(PKG, "..");
const INDEX = join(PKG, "src", "index.ts");
const CORE = "@repo/pi-agent-ext-core-runtime";

/**
 * The sanctioned facade: a core-runtime symbol this barrel re-exports, mapped to
 * the peer file that imports it THROUGH this barrel. Add a row only when a peer
 * genuinely cannot import core-runtime directly; otherwise let that peer declare
 * the dependency and import it itself.
 */
const FACADE_SYMBOLS: Record<string, string> = {
  WorkflowAgent: "pi-agent/src/cli/commands/memory-to-vault.ts",
  getSubagentInFlightRegistry: "pi-agent-ext-obsidian/src/lib/subagent.ts",
  loadModelTierConfig: "pi-agent-ext-file2md/src/sessions.ts",
  resolveModelRole: "pi-agent-ext-file2md/src/sessions.ts",
  saveModelTierConfig: "pi-agent-ext-file2md/__tests__/resolve-vision-llm.test.ts",
  // The cross-package module-identity guard asserts the package-root path and the
  // core-runtime path land on ONE limiter instance; it needs both spellings.
  getGlobalRateLimiter: "pi-agent-ext-subagent/tests/rate-limiter-cross-pkg.test.ts",
  setRateLimitCapResolver: "pi-agent-ext-subagent/tests/rate-limiter-cross-pkg.test.ts",
};

/**
 * Types re-exported for peers whose own public signatures mention them (e.g.
 * `SpawnSubagentResult.usage: AgentUsage`). Type-only, so they carry no runtime
 * identity concern, but they are still interface surface and still bounded.
 */
const FACADE_TYPES = new Set(["AgentHistoryEntry", "AgentUsage"]);

/** Names this barrel re-exports from core-runtime, split by value vs type-only. */
function coreReExports(source: string): { values: Set<string>; types: Set<string> } {
  const values = new Set<string>();
  const types = new Set<string>();
  const re = new RegExp(`export\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${CORE}["']`, "g");
  for (const m of source.matchAll(re)) {
    const typeOnly = Boolean(m[1]);
    for (const raw of (m[2] as string).split(",")) {
      const name = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (!name) continue;
      (typeOnly ? types : values).add(name);
    }
  }
  return { values, types };
}

/** Does `file` import `name` from the subagent package root / this package's barrel? */
function importsThroughBarrel(file: string, name: string): boolean {
  let src: string;
  try {
    src = readFileSync(join(BUN_APPS, file), "utf8");
  } catch {
    return false;
  }
  const re =
    /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](?:@repo\/pi-agent-ext-subagent|(?:\.\.\/)+src\/index\.js|\.\/index\.js)["']/g;
  for (const m of src.matchAll(re)) {
    for (const raw of (m[1] as string).split(",")) {
      if (
        raw
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          ?.trim() === name
      )
        return true;
    }
  }
  return false;
}

describe("subagent barrel surface", () => {
  const source = readFileSync(INDEX, "utf8");
  const { values, types } = coreReExports(source);

  it("re-exports no core-runtime VALUE that is not a sanctioned facade symbol", () => {
    const unsanctioned = [...values].filter((n) => !(n in FACADE_SYMBOLS)).sort();
    assert.deepEqual(
      unsanctioned,
      [],
      `src/index.ts re-exports core-runtime symbols with no named peer consumer: ${unsanctioned.join(", ")}. ` +
        `Either add a FACADE_SYMBOLS row naming the peer that needs it, or drop the re-export and have that ` +
        `peer declare ${CORE} and import it directly.`,
    );
  });

  it("re-exports no core-runtime TYPE outside the bounded facade set", () => {
    const unsanctioned = [...types].filter((n) => !FACADE_TYPES.has(n)).sort();
    assert.deepEqual(unsanctioned, [], `unsanctioned core-runtime type re-exports: ${unsanctioned.join(", ")}`);
  });

  it("every sanctioned facade symbol is still re-exported (no stale FACADE_SYMBOLS row)", () => {
    const missing = Object.keys(FACADE_SYMBOLS)
      .filter((n) => !values.has(n))
      .sort();
    assert.deepEqual(
      missing,
      [],
      `FACADE_SYMBOLS names symbols src/index.ts no longer re-exports: ${missing.join(", ")}. Remove the rows.`,
    );
  });

  it("every sanctioned facade symbol still has its named peer consumer", () => {
    const orphaned = Object.entries(FACADE_SYMBOLS)
      .filter(([name, consumer]) => !importsThroughBarrel(consumer, name))
      .map(([name, consumer]) => `${name} (claimed by ${consumer})`)
      .sort();
    assert.deepEqual(
      orphaned,
      [],
      `these facade re-exports have no consumer left — the peer moved off the barrel, so the re-export is dead ` +
        `interface: ${orphaned.join(", ")}. Drop both the FACADE_SYMBOLS row and the export.`,
    );
  });

  it("no file under src/ imports through its own barrel", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(p);
          continue;
        }
        if (!ent.name.endsWith(".ts") || p === INDEX) continue;
        if (/from\s*["']\.{1,2}\/index\.js["']/.test(readFileSync(p, "utf8"))) {
          offenders.push(p.replace(`${PKG}/`, ""));
        }
      }
    };
    walk(join(PKG, "src"));
    assert.deepEqual(
      offenders.sort(),
      [],
      `these src/ files import through the package's own barrel instead of the owning module — ` +
        `a needless self-edge that makes the module graph read as if the barrel were a layer: ${offenders.join(", ")}`,
    );
  });
});
