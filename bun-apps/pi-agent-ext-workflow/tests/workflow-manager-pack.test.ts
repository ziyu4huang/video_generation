import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
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
