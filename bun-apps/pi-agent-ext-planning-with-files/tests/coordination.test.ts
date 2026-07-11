/**
 * Plan A coordination seam tests (planning-with-files side).
 *
 * Covers:
 *   - coordination.isGoalActive: reads globalThis.__piGoalActive, graceful fallback
 *   - isPlanIncompleteInDir: pure cwd-based gate (exists + not closed + incomplete)
 *   - close marker (/plan-done) is the release valve
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGoalActive } from "../src/coordination.js";
import { isPlanIncompleteInDir, planProgressLine, readPlanStatus } from "../src/plan.js";

const GOAL_KEY = "__piGoalActive";
const tempRoots: string[] = [];

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pwf-coord-"));
  tempRoots.push(cwd);
  return cwd;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

// ─── coordination.isGoalActive ──────────────────────────────────────────────

describe("coordination.isGoalActive", () => {
  let saved: unknown;
  beforeEach(() => {
    saved = (globalThis as Record<string, unknown>)[GOAL_KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete (globalThis as Record<string, unknown>)[GOAL_KEY];
    else (globalThis as Record<string, unknown>)[GOAL_KEY] = saved;
  });

  it("returns false when power-tool global is absent (standalone planning-with-files)", () => {
    delete (globalThis as Record<string, unknown>)[GOAL_KEY];
    expect(isGoalActive()).toBe(false);
  });

  it("returns the published value when the global is a function", () => {
    (globalThis as Record<string, unknown>)[GOAL_KEY] = () => true;
    expect(isGoalActive()).toBe(true);
    (globalThis as Record<string, unknown>)[GOAL_KEY] = () => false;
    expect(isGoalActive()).toBe(false);
  });

  it("returns false when the global is present but not a function", () => {
    (globalThis as Record<string, unknown>)[GOAL_KEY] = "not-a-function";
    expect(isGoalActive()).toBe(false);
  });
});

// ─── isPlanIncompleteInDir (goal completion gate, pure file check) ──────────

const PARTIAL_PLAN = [
  "# Task Plan",
  "### Phase 1",
  "**Status:** complete",
  "### Phase 2",
  "**Status:** in_progress",
  "### Phase 3",
  "**Status:** pending",
].join("\n");

const COMPLETE_PLAN = [
  "# Task Plan",
  "### Phase 1",
  "**Status:** complete",
  "### Phase 2",
  "**Status:** complete",
].join("\n");

const CLOSED_MARKER = "\n\n---\n<!-- pwf: closed -->\nPlan closed via /plan-done (2026-07-11)\n";

describe("planProgressLine (fusion: roadmap summary for goal)", () => {
  it("returns null when no plan exists", () => {
    expect(planProgressLine(makeCwd())).toBeNull();
  });

  it("returns 'Phase X/Y' for a partial plan", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "task_plan.md"),
      [
        "# Plan",
        "### Phase 1",
        "**Status:** complete",
        "### Phase 2",
        "**Status:** in_progress",
        "### Phase 3",
        "**Status:** pending",
      ].join("\n"),
    );
    expect(planProgressLine(cwd)).toBe("Phase 1/3 — see task_plan.md");
  });

  it("marks all-complete plans", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), ["# Plan", "### Phase 1", "**Status:** complete"].join("\n"));
    expect(planProgressLine(cwd)).toBe("Phase 1/1 (all complete) — see task_plan.md");
  });

  it("returns null for a closed plan (/plan-done)", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "task_plan.md"),
      ["# Plan", "### Phase 1", "**Status:** complete", "### Phase 2", "**Status:** in_progress", CLOSED_MARKER].join(
        "\n",
      ),
    );
    expect(planProgressLine(cwd)).toBeNull();
  });
});

describe("isPlanIncompleteInDir (goal completion gate)", () => {
  it("returns false when no plan exists", () => {
    expect(isPlanIncompleteInDir(makeCwd())).toBe(false);
  });

  it("returns true when a plan has open phases", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), PARTIAL_PLAN);
    expect(isPlanIncompleteInDir(cwd)).toBe(true);
  });

  it("returns false when all phases are complete", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), COMPLETE_PLAN);
    expect(isPlanIncompleteInDir(cwd)).toBe(false);
  });

  it("returns false for a closed plan (/plan-done is the release valve)", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), PARTIAL_PLAN + CLOSED_MARKER);
    // Sanity: status is closed before asserting the gate.
    expect(readPlanStatus(cwd).closed).toBe(true);
    expect(isPlanIncompleteInDir(cwd)).toBe(false);
  });
});
