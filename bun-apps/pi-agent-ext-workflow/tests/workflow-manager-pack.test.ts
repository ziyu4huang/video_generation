import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { createRunPersistence } from "../src/run-persistence.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { runWorkflow } from "../src/workflow.js";

/** A mock agent that returns a canned string without any provider call. */
const mockAgent = {
  async run(_prompt: string) {
    return "mocked";
  },
};

test("onAgentJournal entries carry the assigned phase (T4)", async () => {
  const seen: Array<{ index: number; phase?: string }> = [];
  await runWorkflow(
    `export const meta = { name: 't4', description: 'phase emit', phases: [{ title: 'research' }] }
     phase('research')
     await agent('do research')
     return {}`,
    {
      agent: mockAgent,
      onAgentJournal: (e) => seen.push({ index: e.index, phase: e.phase }),
    },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].phase, "research");
});

test("a pack run (stateRoot set) persists its run file under <stateRoot>/runs, not the cwd store (T5)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  const { runId } = mgr.startInBackground(
    `export const meta={name:"p",description:"d"};export default async({agent})=>{await agent("x");};`,
    {},
    { stateRoot, packId: "demo-abc123" },
  );
  // give the background run a tick to persist
  await new Promise((r) => setTimeout(r, 50));
  expect(existsSync(join(stateRoot, "runs", `${runId}.json`))).toBe(true);
  // the cwd store must NOT contain it
  const cwdStore = createRunPersistence(cwd);
  expect(cwdStore.load(runId)).toBeNull();
});

test("an inline run (no stateRoot) still persists to the cwd store (backward-compat) (T5)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  const { runId } = mgr.startInBackground(
    `export const meta={name:"p",description:"d"};export default async({agent})=>{await agent("x");};`,
    {},
    {},
  );
  await new Promise((r) => setTimeout(r, 50));
  expect(createRunPersistence(cwd).load(runId)?.runId).toBe(runId);
});

test("onAgentJournal mirrors to intermediate/ when io.intermediate.persist is true (T6)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  // Script without export default — agent/phase are vm globals injected by runWorkflow
  mgr.startInBackground(
    `export const meta={name:"p",description:"d",phases:[{title:"research"}]};phase("research");await agent("x");`,
    {},
    { stateRoot, packId: "demo-x", intermediateDir: join(stateRoot,"intermediate"), io: { intermediate: { persist: true } } },
  );
  await new Promise((r) => setTimeout(r, 80));
  const researchDir = join(stateRoot, "intermediate", "research");
  expect(existsSync(researchDir)).toBe(true);
  expect(readdirSync(researchDir).length).toBeGreaterThan(0);
});

test("intermediate mirror is NOT written when io.intermediate.persist is absent (default off) (T6)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  mgr.startInBackground(
    `export const meta={name:"p",description:"d"};await agent("x");`,
    {},
    { stateRoot, packId: "demo-y", intermediateDir: join(stateRoot,"intermediate"), io: {} },
  );
  await new Promise((r) => setTimeout(r, 80));
  // intermediate dir should NOT exist because mirrorIntermediate is never called
  // when io.intermediate.persist is absent (decision 12 gate)
  expect(existsSync(join(stateRoot, "intermediate"))).toBe(false);
});

test("run end appends outputs/<ts>/result.json + run-meta.json (T6, decision 11)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const outputsDir = join(stateRoot, "outputs");
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  await mgr.runSync(
    `export const meta={name:"p",description:"d"};await agent("x");return {ok:true};`,
    { topic: "cats" },
    { stateRoot, packId: "demo-z", outputsDir },
  );
  const tsDirs = readdirSync(outputsDir);
  expect(tsDirs.length).toBe(1);
  const runDir = join(outputsDir, tsDirs[0]);
  expect(existsSync(join(runDir, "result.json"))).toBe(true);
  const meta = JSON.parse(readFileSync(join(runDir, "run-meta.json"), "utf-8"));
  expect(meta.inputHash).toMatch(/^[0-9a-f]{12}$/);
  expect(meta.packId).toBe("demo-z");
});

test("a repeat run appends a NEW <ts> subdir (no overwrite, decision 11) (T6)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const outputsDir = join(stateRoot, "outputs");
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  const script = `export const meta={name:"p",description:"d"};await agent("x");return {ok:true};`;
  for (let i = 0; i < 2; i++) {
    await mgr.runSync(script, { topic: "cats" }, { stateRoot, packId: "demo-r", outputsDir });
  }
  expect(readdirSync(outputsDir).length).toBe(2);
});
