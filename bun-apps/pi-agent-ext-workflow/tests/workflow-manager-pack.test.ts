import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { resolvePackRunContext } from "../src/pack-run-context.js";
import { createRunPersistence } from "../src/run-persistence.js";
import { runWorkflow } from "../src/workflow.js";
import { uniqueOutputDir, WorkflowManager } from "../src/workflow-manager.js";

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
    {
      stateRoot,
      packId: "demo-x",
      intermediateDir: join(stateRoot, "intermediate"),
      io: { intermediate: { persist: true } },
    },
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
    { stateRoot, packId: "demo-y", intermediateDir: join(stateRoot, "intermediate"), io: {} },
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

test("uniqueOutputDir disambiguates same-ms collisions (-2, -3, …) without overwriting (decision 11)", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "uniq-out-"));
  const base = "2026-07-25T07-00-05-519Z";
  // Fresh: base name available -> no suffix.
  expect(uniqueOutputDir(dir, base)).toBe(join(dir, base));
  // Seed a collision: base taken -> -2.
  mkdirSync(join(dir, base));
  expect(uniqueOutputDir(dir, base)).toBe(`${join(dir, base)}-2`);
  // Seed -2 as well -> -3 (loop keeps advancing; never overwrites).
  mkdirSync(`${join(dir, base)}-2`);
  expect(uniqueOutputDir(dir, base)).toBe(`${join(dir, base)}-3`);
});

test("workflow-tool passes pack context into ExecOptions when a pack is named (T7 wiring)", () => {
  // Unit-level shape lock: resolvePackRunContext is the single source of truth the
  // tool spreads into ExecOptions. Pins the 5 fields the manager routes to
  // pack-scoped persistence / intermediate mirror / outputs append.
  const repo = mkdtempSync(join(os.tmpdir(), "repo-"));
  const packDir = join(repo, ".pi", "workflows", "wired");
  const ctx = resolvePackRunContext({ name: "wired", packDir, repoRoot: repo });
  const execFields = (({ packId, stateRoot, intermediateDir, outputsDir, io }) => ({
    packId,
    stateRoot,
    intermediateDir,
    outputsDir,
    io,
  }))(ctx);
  expect(execFields.packId).toBeDefined();
  expect(execFields.stateRoot).toBe(packDir);
  expect(execFields.intermediateDir).toBe(join(packDir, "intermediate"));
  expect(execFields.outputsDir).toBe(join(packDir, "outputs"));
});

test("read/delivery path locates + delivers + deletes a pack run across stores (T5b)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  const { runId } = mgr.startInBackground(
    `export const meta={name:"p",description:"d"};await agent("x");`,
    {},
    { stateRoot, packId: "demo-t5b" },
  );
  await new Promise((r) => setTimeout(r, 100));
  // getPersistedRun finds it in the pack store, NOT the cwd store
  const run = mgr.getPersistedRun(runId);
  expect(run).not.toBeNull();
  expect(run?.packId).toBe("demo-t5b");
  expect(createRunPersistence(cwd).load(runId)).toBeNull();
  // markDelivered stamps deliveredAt on the pack-store record
  mgr.markDelivered(runId);
  expect(mgr.getPersistedRun(runId)?.deliveredAt).toBeDefined();
  // deleteRun removes it from the pack store
  expect(mgr.deleteRun(runId)).toBe(true);
  expect(mgr.getPersistedRun(runId)).toBeNull();
});

test("listUndelivered includes a finished pack run from a cached pack store (T5b)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  const { runId } = mgr.startInBackground(
    `export const meta={name:"p",description:"d"};await agent("x");`,
    {},
    { stateRoot, packId: "demo-t5b-list" },
  );
  await new Promise((r) => setTimeout(r, 100));
  expect(mgr.listUndeliveredCompletedBackgroundRuns().some((r) => r.runId === runId)).toBe(true);
});

test("a pack run's persisted exec carries stateRoot + packId so resume routes to the pack store (T5b)", async () => {
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  const { runId } = mgr.startInBackground(
    `export const meta={name:"p",description:"d"};await agent("x");`,
    {},
    {
      stateRoot,
      packId: "demo-t5b-exec",
      intermediateDir: join(stateRoot, "intermediate"),
      outputsDir: join(stateRoot, "outputs"),
      io: { intermediate: { persist: true } },
    },
  );
  await new Promise((r) => setTimeout(r, 100));
  const run = mgr.getPersistedRun(runId);
  expect(run?.exec?.stateRoot).toBe(stateRoot);
  expect(run?.exec?.packId).toBe("demo-t5b-exec");
  expect(run?.exec?.intermediateDir).toBe(join(stateRoot, "intermediate"));
  expect(run?.exec?.io?.intermediate?.persist).toBe(true);
});

test("an `export default async function` pack entry executes + completes (export-default blocker fix)", async () => {
  // Packs (reference-pack + scaffold template) use `export default async function`.
  // Pre-fix this SyntaxErrored inside the IIFE wrap and stalled at "running".
  const cwd = mkdtempSync(join(os.tmpdir(), "mgr-cwd-"));
  const stateRoot = mkdtempSync(join(os.tmpdir(), "pack-state-"));
  const mgr = new WorkflowManager({ cwd, agent: mockAgent as any });
  const { runId } = mgr.startInBackground(
    `export const meta={name:"p",description:"d"};export default async function({agent}){ return await agent("x"); };`,
    {},
    { stateRoot, packId: "demo-entry" },
  );
  await new Promise((r) => setTimeout(r, 120));
  const run = mgr.getPersistedRun(runId);
  expect(run?.status).toBe("completed");
  expect(run?.agents?.length).toBe(1);
  expect(run?.result).toBe("mocked");
});
