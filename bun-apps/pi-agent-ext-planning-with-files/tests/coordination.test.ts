/**
 * Plan A coordination seam tests (planning-with-files side).
 *
 * Covers:
 *   - coordination.isGoalActive: reads globalThis.__piGoalActive, graceful fallback
 *   - isPlanIncompleteInDir: pure cwd-based gate (exists + not closed + incomplete)
 *   - close marker (/plan done) is the release valve
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExternalDriverActive, isGoalActive, isWayfindActive } from "../src/coordination.js";
import { isPlanIncompleteInDir, planProgressLine, readPlanPhases, readPlanStatus } from "../src/plan.js";

const GOAL_KEY = "__piGoalActive";
const WAYFIND_KEY = "__piWayfindActive";
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

// ─── coordination.isWayfindActive (Phase 4: pi-agent-ext-wayfind seam) ───────

describe("coordination.isWayfindActive", () => {
  let saved: unknown;
  beforeEach(() => {
    saved = (globalThis as Record<string, unknown>)[WAYFIND_KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete (globalThis as Record<string, unknown>)[WAYFIND_KEY];
    else (globalThis as Record<string, unknown>)[WAYFIND_KEY] = saved;
  });

  it("returns false when wayfind global is absent (standalone planning-with-files)", () => {
    delete (globalThis as Record<string, unknown>)[WAYFIND_KEY];
    expect(isWayfindActive()).toBe(false);
  });

  it("returns the published value when the global is a function", () => {
    (globalThis as Record<string, unknown>)[WAYFIND_KEY] = () => true;
    expect(isWayfindActive()).toBe(true);
    (globalThis as Record<string, unknown>)[WAYFIND_KEY] = () => false;
    expect(isWayfindActive()).toBe(false);
  });

  it("returns false when the global is present but not a function", () => {
    (globalThis as Record<string, unknown>)[WAYFIND_KEY] = 42;
    expect(isWayfindActive()).toBe(false);
  });
});

// ─── coordination.isExternalDriverActive (OR of goal + wayfind) ─────────────

describe("coordination.isExternalDriverActive", () => {
  let savedGoal: unknown;
  let savedWayfind: unknown;
  beforeEach(() => {
    savedGoal = (globalThis as Record<string, unknown>)[GOAL_KEY];
    savedWayfind = (globalThis as Record<string, unknown>)[WAYFIND_KEY];
  });
  afterEach(() => {
    const g = globalThis as Record<string, unknown>;
    if (savedGoal === undefined) delete g[GOAL_KEY];
    else g[GOAL_KEY] = savedGoal;
    if (savedWayfind === undefined) delete g[WAYFIND_KEY];
    else g[WAYFIND_KEY] = savedWayfind;
  });

  it("is false when neither driver is active", () => {
    const g = globalThis as Record<string, unknown>;
    delete g[GOAL_KEY];
    delete g[WAYFIND_KEY];
    expect(isExternalDriverActive()).toBe(false);
  });

  it("is true when only /goal is active", () => {
    const g = globalThis as Record<string, unknown>;
    delete g[WAYFIND_KEY];
    g[GOAL_KEY] = () => true;
    expect(isExternalDriverActive()).toBe(true);
  });

  it("is true when only a wayfind grill is active", () => {
    const g = globalThis as Record<string, unknown>;
    delete g[GOAL_KEY];
    g[WAYFIND_KEY] = () => true;
    expect(isExternalDriverActive()).toBe(true);
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

const CLOSED_MARKER = "\n\n---\n<!-- pwf: closed -->\nPlan closed via /plan done (2026-07-11)\n";

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

  it("returns null for a closed plan (/plan done)", () => {
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

  it("returns false for a closed plan (/plan done is the release valve)", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), PARTIAL_PLAN + CLOSED_MARKER);
    // Sanity: status is closed before asserting the gate.
    expect(readPlanStatus(cwd).closed).toBe(true);
    expect(isPlanIncompleteInDir(cwd)).toBe(false);
  });
});

// ─── readPlanPhases (reverse seam: globalThis.__piPlanPhases, ADR-0001) ────────
// Per-phase {id, status, ticketIds?} surfaced so wayfind's syncChainState can
// close the originating ticket when a phase completes (the loop's feedback half).
describe("readPlanPhases (reverse seam reader)", () => {
  it("returns per-phase {id, status, ticketIds?} for a plan with [ticket-id] headers", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "task_plan.md"),
      [
        "# Plan",
        "### Phase 1 — [03-foo] wire storage",
        "**Status:** complete",
        "### Phase 2 — no ticket here",
        "**Status:** in_progress",
        "### Phase 3 — [07-bar, 08-baz] multi",
        "**Status:** pending",
      ].join("\n"),
    );
    expect(readPlanPhases(cwd)).toEqual([
      { id: "1", status: "complete", ticketIds: ["03-foo"] },
      { id: "2", status: "in_progress" },
      { id: "3", status: "pending", ticketIds: ["07-bar", "08-baz"] },
    ]);
  });

  it("omits ticketIds when no [id] ref is present in the header", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), ["# Plan", "### Phase 1", "**Status:** complete"].join("\n"));
    const phases = readPlanPhases(cwd);
    expect(phases).toEqual([{ id: "1", status: "complete" }]);
    expect(phases[0]).not.toHaveProperty("ticketIds");
  });

  it("returns [] when no plan exists", () => {
    expect(readPlanPhases(makeCwd())).toEqual([]);
  });

  it("returns [] for a closed plan (closed/abandoned → inert, no tickets surfaced)", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "task_plan.md"),
      ["# Plan", "### Phase 1 — [01-x]", "**Status:** complete", CLOSED_MARKER].join("\n"),
    );
    expect(readPlanPhases(cwd)).toEqual([]);
  });
});
