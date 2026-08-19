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
