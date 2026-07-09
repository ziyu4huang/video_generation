import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIntervalSpec } from "../src/commands.js";
import { checkCompleteReport } from "../src/scripts.js";

const tempRoots: string[] = [];

function makeCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pwf-scripts-"));
  tempRoots.push(cwd);
  return cwd;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

describe("checkCompleteReport (port of check-complete.sh advisory path)", () => {
  it("reports ALL PHASES COMPLETE when every phase is complete", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task_plan.md"), "### Phase 1\n**Status:** complete\n### Phase 2\n**Status:** complete\n");

    const report = checkCompleteReport(cwd);

    expect(report).toContain("ALL PHASES COMPLETE (2/2)");
  });

  it("reports in-progress with remaining counts", () => {
    const cwd = makeCwd();
    const dir = join(cwd, ".planning", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "task_plan.md"),
      "### Phase 1\n**Status:** complete\n### Phase 2\n**Status:** in_progress\n### Phase 3\n**Status:** pending\n",
    );

    const report = checkCompleteReport(cwd);

    expect(report).toContain("Task in progress (1/3");
    expect(report).toContain("1 phase(s) still in progress");
    expect(report).toContain("1 phase(s) pending");
  });

  it("reports no active session when no plan exists", () => {
    const cwd = makeCwd();
    expect(checkCompleteReport(cwd)).toContain("No task_plan.md");
  });
});

describe("parseIntervalSpec", () => {
  it("parses s/m/h/d units into milliseconds", () => {
    expect(parseIntervalSpec("30s")).toBe(30_000);
    expect(parseIntervalSpec("10m")).toBe(600_000);
    expect(parseIntervalSpec("2h")).toBe(7_200_000);
    expect(parseIntervalSpec("1d")).toBe(86_400_000);
  });

  it("returns undefined for invalid specs", () => {
    expect(parseIntervalSpec(undefined)).toBeUndefined();
    expect(parseIntervalSpec("10")).toBeUndefined();
    expect(parseIntervalSpec("abc")).toBeUndefined();
    expect(parseIntervalSpec("0m")).toBeUndefined();
  });
});
