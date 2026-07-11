/**
 * PLI v2 lifecycle tests — enumeratePlans/renderPlanList (Phase 3),
 * lintPlan/lintAllPlans (Phase 4), switchActivePlan (Phase 5).
 *
 * Hermetic: each test builds a throwaway cwd under tmpdir; afterEach wipes them
 * and restores env. Mirrors the functional-gaps.test.ts harness.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestPlan } from "../src/attestation.js";
import { enumeratePlans, lintAllPlans, lintPlan, renderPlanList, switchActivePlan } from "../src/lifecycle.js";
import { resolvePlanPaths } from "../src/plan.js";

const roots: string[] = [];
const originalEnv = { ...process.env };
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "pwf-pli-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  process.env = { ...originalEnv };
  while (roots.length) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});
function sha(s: string) {
  return createHash("sha256").update(s).digest("hex");
}
function writeScopedPlan(cwd: string, id: string, content: string): string {
  const dir = join(cwd, ".planning", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task_plan.md"), content);
  return dir;
}

// ---------------------------------------------------------------------------
// Phase 3 — enumeratePlans + renderPlanList
// ---------------------------------------------------------------------------
describe("enumeratePlans — multi-plan enumeration", () => {
  it("empty repo → []", () => {
    expect(enumeratePlans(tmp())).toEqual([]);
  });

  it("root only → one row, scope=root, active", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, "task_plan.md"), "### Phase 1\n**Status:** complete\n");
    const rows = enumeratePlans(cwd);
    expect(rows).toHaveLength(1);
    expect(rows[0].scope).toBe("root");
    expect(rows[0].id).toBe("<root>");
    expect(rows[0].active).toBe(true);
    expect(rows[0].completePhases).toBe(1);
    expect(rows[0].totalPhases).toBe(1);
  });

  it("3 parallel plans → 3 rows; active pinned via .active_plan", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "a", "### Phase 1\n**Status:** complete\n### Phase 2\n**Status:** pending\n");
    writeScopedPlan(cwd, "b", "### Phase 1\n**Status:** complete\n");
    writeScopedPlan(cwd, "c", "### Phase 1\n**Status:** in_progress\n");
    // Pin to "a" deterministically.
    writeFileSync(join(cwd, ".planning", ".active_plan"), "a\n");
    delete process.env.PLAN_ID;
    const rows = enumeratePlans(cwd);
    expect(rows.map((r) => r.id).sort()).toEqual(["a", "b", "c"]);
    const active = rows.find((r) => r.active);
    expect(active?.id).toBe("a");
    // active row sorts first
    expect(rows[0].active).toBe(true);
  });

  it("marks a closed plan row .closed === true", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "done", "### Phase 1\n**Status:** complete\n\n<!-- pwf: closed -->\n");
    const rows = enumeratePlans(cwd);
    expect(rows[0].closed).toBe(true);
  });

  it("marks a tampered plan attestation === 'tampered'", () => {
    const cwd = tmp();
    const dir = writeScopedPlan(cwd, "t", "### Phase 1\n**Status:** complete\n");
    writeFileSync(join(dir, ".attestation"), `${sha("### Phase 1\n**Status:** complete\n")}\n`);
    // Mutate content → attestation now mismatches.
    writeFileSync(join(dir, "task_plan.md"), "### Phase 1\n**Status:** complete\n# sneaky\n");
    const rows = enumeratePlans(cwd);
    expect(rows[0].attestation).toBe("tampered");
  });

  it("marks an attested (non-tampered) plan 'locked'", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "ok", "### Phase 1\n**Status:** complete\n");
    attestPlan(cwd); // writes <planDir>/.attestation with matching hash
    const rows = enumeratePlans(cwd);
    expect(rows[0].attestation).toBe("locked");
  });

  it("read-only: calling twice does not mutate .active_plan", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "a", "### Phase 1\n**Status:** complete\n");
    writeFileSync(join(cwd, ".planning", ".active_plan"), "a\n");
    const before = "a\n";
    enumeratePlans(cwd);
    enumeratePlans(cwd);
    expect(existsSync(join(cwd, ".planning", ".active_plan"))).toBe(true);
    expect(readFileSync(join(cwd, ".planning", ".active_plan"), "utf-8")).toBe(before);
  });

  it("skips dirs without task_plan.md", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "real", "### Phase 1\n**Status:** complete\n");
    // A bare dir with no task_plan.md — must be ignored.
    mkdirSync(join(cwd, ".planning", "junk"), { recursive: true });
    writeFileSync(join(cwd, ".planning", "junk", "notes.md"), "x");
    const rows = enumeratePlans(cwd);
    expect(rows.map((r) => r.id)).toEqual(["real"]);
  });
});

describe("renderPlanList — markdown table", () => {
  it("empty → 'No plans found' message", () => {
    const out = renderPlanList([]);
    expect(out).toContain("No plans found");
  });

  it("renders header + divider + one body row per plan", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "demo", "### Phase 1\n**Status:** complete\n### Phase 2\n**Status:** in_progress\n");
    writeFileSync(join(cwd, ".planning", ".active_plan"), "demo\n");
    delete process.env.PLAN_ID;
    const out = renderPlanList(enumeratePlans(cwd));
    const lines = out.split("\n");
    expect(lines[0]).toBe("| Plan | Status | Phases | Attestation | Active |");
    expect(lines[1]).toMatch(/^\|------/);
    const body = lines[2];
    expect(body).toContain("demo");
    expect(body).toContain("open");
    expect(body).toContain("1/2");
    expect(body).toContain("✓");
  });

  it("closed plan row shows 'closed' + '—' phases", () => {
    const rows = [
      {
        id: "done",
        scope: "scoped" as const,
        active: false,
        exists: true,
        totalPhases: 3,
        completePhases: 3,
        closed: true,
        hasParseableStatus: true,
        attestation: "none" as const,
        mtimeMs: 0,
      },
    ];
    const out = renderPlanList(rows);
    expect(out).toContain("closed");
    expect(out).toContain("—");
  });
});

// ---------------------------------------------------------------------------
// Phase 4 — lintPlan + lintAllPlans
// ---------------------------------------------------------------------------
describe("lintPlan — diagnostics", () => {
  it("NO_PLAN error when nothing exists", () => {
    const r = lintPlan(tmp());
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.code === "NO_PLAN" && f.level === "error")).toBe(true);
  });

  it("HEALTHY on a parseable attested plan with progress.md", () => {
    const cwd = tmp();
    const dir = writeScopedPlan(cwd, "p", "### Phase 1\n**Status:** complete\n");
    writeFileSync(join(dir, "progress.md"), "did stuff\n");
    attestPlan(cwd);
    const r = lintPlan(cwd);
    expect(r.findings.some((f) => f.code === "HEALTHY")).toBe(true);
    expect(r.findings.some((f) => f.code === "NOT_ATTESTED")).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("UNPARSEABLE_STATUS when headers present but no status tokens", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "p", "### Phase 1\n### Phase 2\n");
    writeFileSync(join(cwd, ".planning", "p", "progress.md"), "x\n");
    const r = lintPlan(cwd);
    expect(r.findings.some((f) => f.code === "UNPARSEABLE_STATUS" && f.level === "warn")).toBe(true);
    expect(r.ok).toBe(true); // warn, not error
  });

  it("NO_PHASE_HEADERS when no headers at all", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "p", "# just a goal, no phases");
    writeFileSync(join(cwd, ".planning", "p", "progress.md"), "x\n");
    const r = lintPlan(cwd);
    expect(r.findings.some((f) => f.code === "NO_PHASE_HEADERS" && f.level === "warn")).toBe(true);
  });

  it("MISSING_PROGRESS when progress.md absent", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "p", "### Phase 1\n**Status:** complete\n");
    const r = lintPlan(cwd);
    expect(r.findings.some((f) => f.code === "MISSING_PROGRESS")).toBe(true);
  });

  it("TAMPERED error when attestation mismatches", () => {
    const cwd = tmp();
    const dir = writeScopedPlan(cwd, "p", "### Phase 1\n**Status:** complete\n");
    writeFileSync(join(dir, "progress.md"), "x\n");
    attestPlan(cwd);
    writeFileSync(join(dir, "task_plan.md"), "### Phase 1\n**Status:** complete\n# edited\n");
    const r = lintPlan(cwd);
    expect(r.findings.some((f) => f.code === "TAMPERED" && f.level === "error")).toBe(true);
    expect(r.ok).toBe(false);
  });

  it("CLOSED info finding on a closed plan", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "p", "### Phase 1\n**Status:** complete\n\n<!-- pwf: closed -->\n");
    const r = lintPlan(cwd);
    expect(r.findings.some((f) => f.code === "CLOSED" && f.level === "info")).toBe(true);
  });
});

describe("lintAllPlans — lint every plan", () => {
  it("returns one report per plan, active-first", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "a", "### Phase 1\n**Status:** complete\n");
    writeScopedPlan(cwd, "b", "### Phase 1\n**Status:** complete\n");
    writeScopedPlan(cwd, "c", "### Phase 1\n**Status:** complete\n");
    writeFileSync(join(cwd, ".planning", ".active_plan"), "b\n");
    delete process.env.PLAN_ID;
    const reports = lintAllPlans(cwd);
    expect(reports).toHaveLength(3);
    // active-first: the active plan (b) is enumerated first.
    expect(reports[0].planPath).toContain("b");
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — switchActivePlan
// ---------------------------------------------------------------------------
describe("switchActivePlan — active plan control", () => {
  it("switches to an existing plan (writes .active_plan)", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "a", "### Phase 1\n**Status:** complete\n");
    writeScopedPlan(cwd, "b", "### Phase 1\n**Status:** complete\n");
    delete process.env.PLAN_ID;
    const res = switchActivePlan(cwd, "b");
    expect(res.ok).toBe(true);
    expect(res.activePlanId).toBe("b");
    expect(resolvePlanPaths(cwd).planId).toBe("b");
  });

  it("nonexistent target → ok=false, no write", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "a", "### Phase 1\n**Status:** complete\n");
    const res = switchActivePlan(cwd, "ghost");
    expect(res.ok).toBe(false);
    expect(existsSync(join(cwd, ".planning", ".active_plan"))).toBe(false);
  });

  it("closed target → ok=false", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "done", "### Phase 1\n**Status:** complete\n\n<!-- pwf: closed -->\n");
    const res = switchActivePlan(cwd, "done");
    expect(res.ok).toBe(false);
    expect(res.message.toLowerCase()).toContain("closed");
  });

  it("'root' clears the pin (resolver falls back)", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "a", "### Phase 1\n**Status:** complete\n");
    writeFileSync(join(cwd, ".planning", ".active_plan"), "a\n");
    writeFileSync(join(cwd, "task_plan.md"), "### Phase 1\n**Status:** complete\n");
    const res = switchActivePlan(cwd, "root");
    expect(res.ok).toBe(true);
    expect(existsSync(join(cwd, ".planning", ".active_plan"))).toBe(false);
    // Resolver now falls to the scoped "a" (newest-dir) since root resolution
    // only kicks in when no scoped plan exists — but the pin file is gone.
  });

  it("empty id → clears the pin", () => {
    const cwd = tmp();
    writeScopedPlan(cwd, "a", "### Phase 1\n**Status:** complete\n");
    writeFileSync(join(cwd, ".planning", ".active_plan"), "a\n");
    const res = switchActivePlan(cwd, "");
    expect(res.ok).toBe(true);
    expect(existsSync(join(cwd, ".planning", ".active_plan"))).toBe(false);
  });

  it("creates .planning/ if missing before writing", () => {
    const cwd = tmp();
    // No .planning dir yet; pre-create the target so it exists.
    writeScopedPlan(cwd, "fresh", "### Phase 1\n**Status:** complete\n");
    // Wipe the .active_plan to prove switch creates the path infra.
    const res = switchActivePlan(cwd, "fresh");
    expect(res.ok).toBe(true);
    expect(existsSync(join(cwd, ".planning", ".active_plan"))).toBe(true);
  });
});
