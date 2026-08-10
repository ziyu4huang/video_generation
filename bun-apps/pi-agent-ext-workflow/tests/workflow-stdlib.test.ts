import { test } from "bun:test";
import assert from "node:assert/strict";
import { attemptLoop, parallelAgents } from "../src/workflow-stdlib.js";

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

test("parallelAgents fans out count agents labelled '<labelPrefix> <i+1>' passing schema", async () => {
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
    "verify",
    (i) => `q${i}`,
    markerSchema,
  );
  assert.equal(results.length, 3);
  assert.deepEqual(labels, ["verify 1", "verify 2", "verify 3"]);
  assert.deepEqual(prompts, ["q0", "q1", "q2"]);
});
