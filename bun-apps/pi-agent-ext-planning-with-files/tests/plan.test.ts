import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAllPhasesComplete,
  isCloseMarker,
  isPlanClosed,
  isPlanIncomplete,
  readPlanStatus,
  resolvePlanPaths,
  summarizePlan,
} from "../src/plan.js";

const tempRoots: string[] = [];
const originalEnv = { ...process.env };

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pwf-plan-"));
  tempRoots.push(cwd);
  return cwd;
}

function writeScoped(cwd: string, slug: string, content: string): string {
  const dir = join(cwd, ".planning", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task_plan.md"), content);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
  process.env = { ...originalEnv };
  delete process.env.PLAN_ID;
});

describe("readPlanStatus", () => {
  it("counts primary **Status:** phases in a scoped plan", () => {
    const cwd = makeCwd();
    writeScoped(
      cwd,
      "demo",
      ["# P", "", "### Phase 1", "**Status:** complete", "", "### Phase 2", "**Status:** in_progress", ""].join("\n"),
    );

    const status = readPlanStatus(cwd);

    expect(status.exists).toBe(true);
    expect(status.scope).toBe("scoped");
    expect(status.totalPhases).toBe(2);
    expect(status.completePhases).toBe(1);
    expect(status.inProgressPhases).toBe(1);
    expect(status.pendingPhases).toBe(0);
  });

  it("falls back to inline [status] markers when no primary status lines exist", () => {
    const cwd = makeCwd();
    writeScoped(cwd, "demo", ["### Phase 1", "[complete]", "### Phase 2", "[pending]"].join("\n"));

    const status = readPlanStatus(cwd);

    expect(status.totalPhases).toBe(2);
    expect(status.completePhases).toBe(1);
    expect(status.pendingPhases).toBe(1);
  });

  it("reports exists=false when no plan is present", () => {
    const cwd = makeCwd();
    const status = readPlanStatus(cwd);
    expect(status.exists).toBe(false);
    expect(status.scope).toBe("none");
  });

  it("captures the progress tail and plan head slices", () => {
    const cwd = makeCwd();
    const dir = writeScoped(cwd, "demo", "### Phase 1\n**Status:** complete\n");
    writeFileSync(join(dir, "progress.md"), "line-a\nline-b\nline-c\n");

    const status = readPlanStatus(cwd);
    expect(status.progressTail20).toContain("line-c");
    expect(status.firstLines50).toContain("### Phase 1");
  });
});

describe("readPlanStatus — emoji / inline status tolerance", () => {
  it("recognizes ✅/⏸ emoji markers on phase headers (prd-distill style)", () => {
    const cwd = makeCwd();
    writeScoped(
      cwd,
      "prd",
      [
        "# PRD distill",
        "",
        "### Phase 1 — Inventory & setup  ✅ complete",
        "",
        "### Phase 2 — Distill PRDs → notes  ⏸ BLOCKED",
        "",
        "### Phase 3 — Verify output  ⏸ blocked by Phase 2",
        "",
        "### Phase 4 — Graph health audit  ⏸ blocked by Phase 2",
        "",
      ].join("\n"),
    );

    const status = readPlanStatus(cwd);
    expect(status.totalPhases).toBe(4);
    expect(status.completePhases).toBe(1);
    // ⏸ maps to pending (blocked / not done).
    expect(status.pendingPhases).toBe(3);
    expect(status.hasParseableStatus).toBe(true);
    // Accurate now: 1/4 — genuinely incomplete, so it DOES count as incomplete.
    expect(isPlanIncomplete(status)).toBe(true);
  });

  it("recognizes 🔄 in_progress emoji", () => {
    const cwd = makeCwd();
    writeScoped(cwd, "demo", "### Phase 1\n🔄 working on it\n### Phase 2\n✅ done\n");
    const status = readPlanStatus(cwd);
    expect(status.inProgressPhases).toBe(1);
    expect(status.completePhases).toBe(1);
  });

  it("does NOT miscount an unrecognized status format as 0/N incomplete", () => {
    // No Status: line, no brackets, no emoji → fully unparseable.
    const cwd = makeCwd();
    writeScoped(cwd, "demo", "### Phase 1\nsome custom marker XYZ\n### Phase 2\nalso custom\n");
    const status = readPlanStatus(cwd);
    expect(status.totalPhases).toBe(2);
    expect(status.hasParseableStatus).toBe(false);
    // Critical: ambiguous status must NOT trigger the incomplete nag.
    expect(isPlanIncomplete(status)).toBe(false);
    expect(summarizePlan(status)).toBe("2 phases (status format unrecognized)");
  });

  it("handles mixed Status: + bracket formats per-phase", () => {
    const cwd = makeCwd();
    writeScoped(cwd, "demo", "### Phase 1\n**Status:** complete\n### Phase 2\n[pending]\n");
    const status = readPlanStatus(cwd);
    expect(status.completePhases).toBe(1);
    expect(status.pendingPhases).toBe(1);
  });
});

describe("close marker / closed plan", () => {
  it("detects the comment close marker written by /plan done", () => {
    expect(isCloseMarker("# Plan\n<!-- pwf: closed -->\n")).toBe(true);
    expect(isCloseMarker("# Plan\n<!-- pwf:closed -->\n")).toBe(true);
  });

  it("detects a human-written heading close marker", () => {
    expect(isCloseMarker("# Plan\n## Plan Status: closed\n")).toBe(true);
    expect(isCloseMarker("# Plan\n## Plan Status: **closed**\n")).toBe(true);
  });

  it("does NOT treat unrelated ## Status: lines as closed (prd-distill has '## Status: **UNBLOCKED**')", () => {
    expect(isCloseMarker("## Status: **UNBLOCKED**\n")).toBe(false);
  });

  it("a closed plan is inert: isPlanClosed true, isPlanIncomplete false, isAllPhasesComplete false", () => {
    const cwd = makeCwd();
    writeScoped(
      cwd,
      "demo",
      "### Phase 1\n**Status:** pending\n### Phase 2\n**Status:** pending\n\n<!-- pwf: closed -->\n",
    );
    const status = readPlanStatus(cwd);
    expect(status.closed).toBe(true);
    expect(isPlanClosed(status)).toBe(true);
    // Even though 0/2, a closed plan must not nag.
    expect(isPlanIncomplete(status)).toBe(false);
    // And must not report "all complete" either (it's closed, not completed).
    expect(isAllPhasesComplete(status)).toBe(false);
    expect(summarizePlan(status)).toBe("Plan closed (via /plan done)");
  });
});

describe("completion helpers", () => {
  it("isAllPhasesComplete / isPlanIncomplete", () => {
    const cwd = makeCwd();
    writeScoped(cwd, "a", "### Phase 1\n**Status:** complete\n### Phase 2\n**Status:** complete\n");
    const done = readPlanStatus(cwd);
    expect(isAllPhasesComplete(done)).toBe(true);
    expect(isPlanIncomplete(done)).toBe(false);

    writeScoped(cwd, "b", "### Phase 1\n**Status:** complete\n### Phase 2\n**Status:** pending\n");
    const partial = readPlanStatus(cwd);
    expect(isAllPhasesComplete(partial)).toBe(false);
    expect(isPlanIncomplete(partial)).toBe(true);
  });

  it("summarizePlan produces a human-readable one-liner", () => {
    const cwd = makeCwd();
    writeScoped(cwd, "demo", "### Phase 1\n**Status:** complete\n### Phase 2\n**Status:** in_progress\n");
    expect(summarizePlan(readPlanStatus(cwd))).toBe("1/2 phases complete");
  });
});

describe("resolvePlanPaths", () => {
  it("resolves a PLAN_ID-pinned plan first", () => {
    const cwd = makeCwd();
    writeScoped(cwd, "alpha", "### Phase 1\n**Status:** complete\n");
    writeScoped(cwd, "beta", "### Phase 1\n**Status:** complete\n");
    process.env.PLAN_ID = "beta";

    const paths = resolvePlanPaths(cwd);

    expect(paths.scope).toBe("scoped");
    expect(paths.planId).toBe("beta");
  });

  it("falls back to legacy root task_plan.md", () => {
    const cwd = makeCwd();
    writeFileSync(join(cwd, "task_plan.md"), "### Phase 1\n**Status:** complete\n");

    const paths = resolvePlanPaths(cwd);

    expect(paths.scope).toBe("root");
    expect(paths.planPath).toBe(join(cwd, "task_plan.md"));
    expect(paths.attestationCandidates).toEqual([join(cwd, ".plan-attestation")]);
  });
});
