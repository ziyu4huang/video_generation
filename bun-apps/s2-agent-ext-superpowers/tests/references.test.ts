import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Detail moved, not vanished (ADR-superpowers-0010 bootstrap token diet).
 *
 * The bootstrap's two repo-owned sections (piToolMapping, piBoundaryOverrides)
 * were dieted to terse essentials + deferral pointers. Everything they used to
 * carry inline MUST survive in the on-demand reference files this test pins —
 * otherwise the diet silently deleted load-bearing directives instead of
 * relocating them (progressive disclosure only works if the disclosure target
 * still exists and still says the thing).
 */

const refsDir = join(import.meta.dir, "..", "skills", "using-superpowers", "references");
const piTools = readFileSync(join(refsDir, "pi-tools.md"), "utf8");
const piRouting = readFileSync(join(refsDir, "pi-routing.md"), "utf8");

describe("references/pi-tools.md carries the full tool contract the bootstrap defers to", () => {
  it("exists beside the bootstrap skill", () => {
    expect(existsSync(join(refsDir, "pi-tools.md"))).toBe(true);
    expect(existsSync(join(refsDir, "pi-routing.md"))).toBe(true);
  });

  it("keeps the documented spawn_subagent param surface the terse section dropped", () => {
    for (const token of [
      "capability?",
      "tokenBudget",
      "spendBudget",
      "timeoutMs",
      "schema",
      "agentType",
      "watchdog",
      "commitScope",
      "tier",
    ]) {
      expect(piTools).toContain(token);
    }
  });

  it("keeps the fan-out + no-Task-call directives", () => {
    expect(piTools).toContain("parallel()");
    expect(piTools).toContain("run_workflow");
    expect(piTools).toContain("do not fabricate");
  });
});

describe("references/pi-routing.md carries the full routing detail the bootstrap defers to", () => {
  it("keeps the artifact-home path table", () => {
    for (const token of [
      ".planning/<effort>/spec.md",
      ".planning/<effort>/plan.md",
      ".planning/<effort>/sdd/<plan-basename>/",
      ".planning/<effort>/sdd/<plan-basename>/progress.md",
      ".planning/<effort>/brainstorm/",
      "PI_PLANNING_EFFORT",
      "sdd-workspace PLAN_FILE",
    ]) {
      expect(piRouting).toContain(token);
    }
  });

  it("keeps the no-effort fallbacks (ADR-0009)", () => {
    expect(piRouting).toContain(".planning/specs/");
    expect(piRouting).toContain(".planning/plans/");
  });

  it("keeps the full five-stage table with wayfind/superpowers skill names", () => {
    for (const token of [
      "DECIDE",
      "SYNTHESIZE",
      "DESIGN",
      "PLAN",
      "EXECUTE",
      "grilling",
      "to-spec",
      "brainstorming",
      "writing-plans",
    ]) {
      expect(piRouting).toContain(token);
    }
    expect(piRouting).toContain("Four of five stages are a disk check");
  });
});
