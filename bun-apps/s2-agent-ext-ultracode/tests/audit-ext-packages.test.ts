/**
 * Unit gates for the audit-ext-packages workflow script (self-arc-17 t01) —
 * no LLM, no spawns: the script is runtime data, so these test its STATIC
 * contract (meta shape, default package list, batch slicing parity with the
 * script's arithmetic) by parsing the committed source.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "..", "samples", "audit-ext-packages.js"), "utf8");

const EXT_PACKAGE_COUNT = 26;

describe("audit-ext-packages workflow script (static contract)", () => {
  test("meta block names and phases the audit", () => {
    expect(src).toContain('name: "audit-ext-packages"');
    expect(src).toMatch(/title: "Audit"/);
    expect(src).toMatch(/title: "Synthesize"/);
  });

  test("default package list covers all 26 ext packages, no dupes", () => {
    const m = src.match(/A\.packages\.length > 0 \? A\.packages : \[([\s\S]*?)\]/);
    expect(m).toBeTruthy();
    const pkgs = (m?.[1] ?? "").match(/"s2-agent-ext-[a-z0-9-]+"/g) ?? [];
    expect(pkgs.length).toBe(EXT_PACKAGE_COUNT);
    expect(new Set(pkgs).size).toBe(EXT_PACKAGE_COUNT);
    expect(pkgs).toContain('"s2-agent-ext-ultracode"');
  });

  test("auditors are schema'd and read-only-by-prompt; batches bounded", () => {
    expect(src).toMatch(/schema: AUDIT_SCHEMA/);
    expect(src).toMatch(/READ-ONLY auditor/);
    expect(src).toMatch(/NEVER edit, write, or create any file/);
    expect(src).toMatch(/for \(let i = 0; i < PACKAGES\.length; i \+= CONCURRENCY\)/);
    expect(src).toMatch(/Math\.min\(8, Number\(A\.concurrency\) \|\| 7\)/);
  });

  test("gates are derived from each package's own scripts — no bare gate commands", () => {
    expect(src).toMatch(/cat bun-apps\/\$\{pkg\}\/package\.json/);
    expect(src).toMatch(/bun run <gate>/);
    expect(src).toMatch(/NEVER run bare "bun test" or bare "bun x tsc" as a substitute/);
    // The arc-17 runnable bare forms are gone; the only remaining "bun test"
    // occurrences are the never-do-this rule and verbatim package.json
    // script examples in prose.
    expect(src).not.toMatch(/bun test > \/tmp/);
    expect(src).not.toMatch(/bun x tsc --noEmit/);
  });

  test("per-gate provenance, absent-gate and env-drift verdicts are in the schema", () => {
    expect(src).toMatch(/commands\.check \/ commands\.typecheck \/ commands\.test/);
    expect(src).toMatch(/absentGates/);
    expect(src).toMatch(/envDrift/);
    expect(src).toContain('"absent"');
  });

  test("install preflight runs before any package is measured", () => {
    expect(src).toMatch(/title: "Preflight"/);
    expect(src).toMatch(/schema: PREFLIGHT_SCHEMA/);
    expect(src).toMatch(/bun install --frozen-lockfile/);
    expect(src).toMatch(/DANGLING:/);
    expect(src).toMatch(/phase\("Preflight"\)/);
    expect(src.indexOf("preflight:install")).toBeLessThan(src.indexOf("const batch ="));
  });
});
