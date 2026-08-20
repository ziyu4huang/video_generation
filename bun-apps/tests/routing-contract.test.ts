/**
 * Cross-extension routing-contract guard (ticket 05).
 *
 * superpowers' `using-superpowers` bootstrap (`src/superpowers.ts`, injected
 * every session) carries the pipeline-routing table that names wayfind's skills
 * — `grilling` / `to-spec` — as the DECIDE/SYNTHESIZE entry paths. (`wayfinder`
 * was collapsed to a `/wayfind`-invoked procedure — see procedures/wayfinder.md
 * — so it is no longer a model-loadable skill and is intentionally absent here.)
 * If wayfind renames or removes one of those skills, superpowers'
 * bootstrap silently teaches stale routing, and there is NO recovery net (the
 * agent just misroutes). superpowers' own `bootstrap.test.ts` pins that the
 * bootstrap CONTAINS the names (superpowers-side drift), but nothing asserts
 * the named skills still EXIST in wayfind (wayfind-side drift). This guard
 * closes that gap — the one seam that is strictly wayfind↔superpowers.
 *
 * Note: the stage names (DECIDE/SYNTHESIZE/...) are superpowers' OWN framing —
 * wayfind has no "stage" vocabulary (its CONTEXT.md explicitly avoids it). So
 * the cross-package seam is the 3 SKILL names, not the stage names.
 *
 * Invariants (the no-orphans/no-dead pattern, same as seam-contract.test.ts):
 *  1. NO DEAD — every routing-referenced wayfind skill exists in
 *     `s2-agent-ext-wayfind/skills/`.
 *  2. NO ORPHAN — every routing-referenced wayfind skill still appears in
 *     superpowers' bootstrap source (the reference wasn't dropped).
 *
 * Static source analysis only; no runtime import. Run: bun run test:routing.
 */
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // bun-apps/

/**
 * The wayfind skills that superpowers' pipeline-routing bootstrap names as
 * DECIDE/SYNTHESIZE entry paths. A skill enters this set by being referenced
 * by name in superpowers' routing prose. Updating this set when the routing
 * changes IS maintaining the contract.
 */
const ROUTING_WAYFIND_SKILLS = ["grilling", "to-spec"] as const;

const WAYFIND_SKILLS_DIR = join(ROOT, "s2-agent-ext-wayfind", "skills");
const SUPERPOWERS_BOOTSTRAP = join(ROOT, "s2-agent-ext-superpowers", "src", "superpowers.ts");

describe("cross-extension routing contract (superpowers bootstrap ↔ wayfind skills; ticket 05)", () => {
  const bootstrapSrc = readFileSync(SUPERPOWERS_BOOTSTRAP, "utf8");
  const wayfindSkills = new Set(
    readdirSync(WAYFIND_SKILLS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name),
  );
  // Grounding: guard against a vacuous pass if the dirs moved / extraction broke.
  assert.ok(wayfindSkills.size >= 3, `expected ≥3 wayfind skills, got ${wayfindSkills.size}`);
  assert.ok(bootstrapSrc.length > 0, "superpowers.ts source unreadable");

  it("NO DEAD — every routing-referenced wayfind skill exists in s2-agent-ext-wayfind/skills/", () => {
    const missing = ROUTING_WAYFIND_SKILLS.filter((s) => !wayfindSkills.has(s));
    assert.deepEqual(missing, [], missing.length
      ? `ROUTING DRIFT — superpowers' bootstrap names a wayfind skill that no longer exists (renamed? removed?). Update the bootstrap routing text OR the ROUTING_WAYFIND_SKILLS spec:\n${missing.map((s) => `  "${s}" not found in s2-agent-ext-wayfind/skills/`).join("\n")}`
      : "");
  });

  it("NO ORPHAN — every routing-referenced wayfind skill still appears in superpowers' bootstrap source", () => {
    const drift = ROUTING_WAYFIND_SKILLS.filter((s) => !bootstrapSrc.includes(s));
    assert.deepEqual(drift, [], drift.length
      ? `ROUTING DRIFT — a routing-referenced wayfind skill no longer appears in superpowers' bootstrap (src/superpowers.ts). Was the routing table edited? Update the bootstrap text OR the ROUTING_WAYFIND_SKILLS spec:\n${drift.map((s) => `  "${s}" not found in superpowers.ts`).join("\n")}`
      : "");
  });
});
