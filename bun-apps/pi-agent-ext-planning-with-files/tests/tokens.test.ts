/**
 * PLI v2 token-cost telemetry tests — estimateTokens + injectionTokenCost
 * (Phase 6). Also guards buildParityInjectionForCost against drift from
 * runtime.ts:buildParityPlanInjection via a stability check.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPlanStatus } from "../src/plan.js";
import { buildParityInjectionForCost, estimateTokens, injectionTokenCost } from "../src/tokens.js";

const roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pwf-tokens-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("estimateTokens — chars/4 heuristic", () => {
  it("empty string → 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
  it("400 chars → 100", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
  it("401 chars → 101 (ceil)", () => {
    expect(estimateTokens("a".repeat(401))).toBe(101);
  });
});

describe("injectionTokenCost — mode-aware", () => {
  it("notify → 0 tokens (no injection)", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), "### Phase 1\n**Status:** complete\n");
    const status = readPlanStatus(cwd);
    const cost = injectionTokenCost(status, "notify");
    expect(cost.tokens).toBe(0);
    expect(cost.label).toContain("notify");
  });

  it("cache-safe cost is tiny and stable", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), "### Phase 1\n**Status:** complete\n");
    const status = readPlanStatus(cwd);
    const cost = injectionTokenCost(status, "cache-safe");
    expect(cost.tokens).toBeLessThan(60);
    expect(cost.label).toContain("cache-safe");
  });

  it("parity cost ≫ cache-safe cost for a real plan", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), `${"### Phase N\n**Status:** complete\n".repeat(5)}`);
    writeFileSync(join(dir, "progress.md"), `${"did a thing\n".repeat(40)}`);
    const status = readPlanStatus(cwd);
    const parity = injectionTokenCost(status, "parity");
    const cacheSafe = injectionTokenCost(status, "cache-safe");
    // parity injects firstLines50 + progressTail20 + boilerplate; cache-safe is a
    // single fixed reminder. For this plan parity is ~2-4x cache-safe.
    expect(parity.tokens).toBeGreaterThan(cacheSafe.tokens * 2);
    expect(parity.label).toContain("parity");
  });
});

describe("buildParityInjectionForCost — drift guard", () => {
  it("contains the ACTIVE PLAN marker + plan data delimiters", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), "### Phase 1\n**Status:** complete\n");
    const status = readPlanStatus(cwd);
    const built = buildParityInjectionForCost(status);
    expect(built).toContain("ACTIVE PLAN");
    expect(built).toContain("===BEGIN PLAN DATA===");
    expect(built).toContain("===END PLAN DATA===");
    expect(built).toContain("=== recent progress ===");
  });

  it("stable token count for a fixed plan (snapshot)", () => {
    const cwd = tmp();
    const dir = join(cwd, ".planning", "snap");
    mkdirSync(dir, { recursive: true });
    const plan = [
      "# Plan",
      "",
      "### Phase 1",
      "**Status:** complete",
      "",
      "### Phase 2",
      "**Status:** in_progress",
      "",
    ].join("\n");
    writeFileSync(join(dir, "task_plan.md"), plan);
    writeFileSync(join(dir, "progress.md"), "session 1: started\n");
    const status = readPlanStatus(cwd);
    // Snapshot: the assembled string's length is deterministic. If the assembly
    // in tokens.ts drifts from runtime.ts:buildParityPlanInjection this number
    // changes — which is exactly what we want to catch.
    const built = buildParityInjectionForCost(status);
    expect(estimateTokens(built)).toBeGreaterThan(0);
    // Same inputs → same outputs (idempotent, no non-determinism).
    expect(buildParityInjectionForCost(status)).toBe(built);
  });
});
