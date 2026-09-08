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

  test("auditor gate commands cover check/tsc/test with exit capture", () => {
    expect(src).toMatch(/bun run check/);
    expect(src).toMatch(/bun x tsc --noEmit/);
    expect(src).toMatch(/bun test/);
    expect(src).toMatch(/GATE_TEST_EXIT/);
  });
});
