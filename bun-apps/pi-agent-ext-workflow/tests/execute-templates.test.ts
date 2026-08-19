// execute-templates.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const samples = join(import.meta.dir, "../samples");

/** Structural checks: the template must parse as a workflow script (meta +
 * phases declared, pipeline/agent usage present) without a model round-trip. */
describe("execute-t1 template", () => {
  const src = readFileSync(join(samples, "execute-t1.js"), "utf8");

  test("meta declares name and single phase", () => {
    expect(src).toContain('name: "execute-t1"');
    expect(src).toMatch(/phases:\s*\[\s*\{\s*title:\s*"Execute"\s*\}/);
  });
  test("dispatches one impl agent and one verify agent with evidence-base caps", () => {
    expect(src).toMatch(/label:\s*"impl"/);
    expect(src).toMatch(/label:\s*"verify"/);
    expect(src).toMatch(/tokenBudget|budget/);
  });
  test("validates args at the top", () => {
    expect(src).toContain("const a = args ?? {}");
    expect(src).toContain('if (!a.task)');
    expect(src).toContain("stage: \"args\"");
  });
  test("gate check happens before any agent dispatch", () => {
    const gateIdx = src.indexOf('call("shell.run"');
    const agentIdx = src.indexOf("await agent(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(agentIdx);
  });
});

describe("execute-plan template", () => {
  const src = readFileSync(join(samples, "execute-plan.js"), "utf8");

  test("meta declares name and all four phases in order", () => {
    expect(src).toContain('name: "execute-plan"');
    const order = ["Gate", "Execute", "Janitor", "Report"].filter((p) => src.includes(`"${p}"`));
    expect(order).toEqual(["Gate", "Execute", "Janitor", "Report"]);
  });
  test("Execute phase pipelines tickets through impl+verify stages", () => {
    expect(src).toMatch(/pipeline\(/);
    expect(src).toMatch(/label:\s*`impl:/);
    expect(src).toMatch(/label:\s*`verify:/);
  });
  test("Gate phase runs before pipeline and exits on red", () => {
    const gateIdx = src.indexOf("pipeline-gate");
    const pipelineIdx = src.indexOf("pipeline(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(pipelineIdx);
    expect(src).toMatch(/return\s*\{\s*ok:\s*false,\s*stage:\s*"gate"/);
  });
  test("Report phase emits ledger rows with outcome and sha columns", () => {
    expect(src).toMatch(/\|\s*ticket\s*\|\s*outcome\s*\|\s*sha\s*\|/);
  });
});
