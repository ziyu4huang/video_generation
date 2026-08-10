import { test } from "bun:test";
import assert from "node:assert/strict";
import { attemptLoop, createStdlib, parallelAgents } from "../src/workflow-stdlib.js";

test("attemptLoop returns the value when body signals done before maxAttempts", async () => {
  const seen: number[] = [];
  const out = await attemptLoop(5, async (i) => {
    seen.push(i);
    return { done: i === 2, value: `done@${i}` };
  });
  assert.equal(out, "done@2");
  assert.deepEqual(seen, [0, 1, 2]);
});

test("attemptLoop returns the last value when maxAttempts is exhausted (never done)", async () => {
  const seen: number[] = [];
  const out = await attemptLoop(3, async (i) => {
    seen.push(i);
    return { done: false, value: `try@${i}` };
  });
  assert.equal(out, "try@2");
  assert.deepEqual(seen, [0, 1, 2]);
});

test("parallelAgents fans out count agents labelled via labelBuilder(i) passing schema", async () => {
  const labels: string[] = [];
  const prompts: string[] = [];
  const markerSchema = {
    type: "object",
    properties: { ok: { type: "boolean" } },
  } as unknown as import("typebox").TSchema;
  const fakeAgent = async (prompt: string, opts?: { label?: string; schema?: unknown }) => {
    if (opts?.label) labels.push(opts.label);
    prompts.push(prompt);
    assert.equal(opts?.schema, markerSchema, "schema is forwarded unchanged");
    return { ok: true, prompt, label: opts?.label };
  };
  const fakeParallel = async (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t()));
  const results = await parallelAgents(
    fakeParallel as any,
    fakeAgent as any,
    3,
    (i) => `verify ${i + 1}`,
    (i) => `q${i}`,
    markerSchema,
  );
  assert.equal(results.length, 3);
  assert.deepEqual(labels, ["verify 1", "verify 2", "verify 3"]);
  assert.deepEqual(prompts, ["q0", "q1", "q2"]);
});

/** Stub stdlib harness: records every agent() label, runs thunks via Promise.all. */
function makeStubStdlib() {
  const labels: string[] = [];
  const agent = async (_prompt: string, opts?: { label?: string; schema?: unknown }) => {
    if (opts?.label) labels.push(opts.label);
    // verify() and judgePanel() both expect a `real`/`score` payload; return both.
    return { real: true, score: 0.5, reason: "stub" };
  };
  const parallel = async (thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((t) => t()));
  const stdlib = createStdlib({ agent: agent as any, parallel: parallel as any });
  return { stdlib, labels };
}

test("judgePanel labels use the 'judge X.Y' dot format (regression: pre-#1193)", async () => {
  const { stdlib, labels } = makeStubStdlib();
  await stdlib.judgePanel(["candidate attempt"], { judges: 3 });
  assert.deepEqual(labels, ["judge 1.1", "judge 1.2", "judge 1.3"]);
});

test("judgePanel labels fan out per attempt with the correct outer index", async () => {
  const { stdlib, labels } = makeStubStdlib();
  await stdlib.judgePanel(["a", "b"], { judges: 2 });
  assert.deepEqual(labels, ["judge 1.1", "judge 1.2", "judge 2.1", "judge 2.2"]);
});

test("verify labels are 'verify N' for reviewers:n (regression: pre-#1193)", async () => {
  const { stdlib, labels } = makeStubStdlib();
  await stdlib.verify("some claim", { reviewers: 4 });
  assert.deepEqual(labels, ["verify 1", "verify 2", "verify 3", "verify 4"]);
});
