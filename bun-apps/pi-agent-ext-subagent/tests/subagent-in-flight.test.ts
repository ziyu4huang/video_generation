import { test } from "bun:test";
import assert from "node:assert/strict";
import { SubagentInFlightRegistry } from "@repo/pi-agent-ext-core-runtime";

test("registry start/list/end lifecycle", () => {
  const reg = new SubagentInFlightRegistry();
  assert.equal(reg.list().length, 0);
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 1000 });
  reg.start({ id: "b", model: "y", taskPreview: "u", startedAt: 2000, agent: "implementer" });
  assert.equal(reg.list().length, 2);
  assert.equal(reg.list().find((r) => r.id === "b")?.agent, "implementer");
  reg.end("a");
  assert.equal(reg.list().length, 1);
  assert.equal(reg.list()[0].id, "b");
  reg.end("b");
  assert.equal(reg.list().length, 0);
});

test("registry update streams history into the live entry; updates after end are no-ops", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 0 });
  reg.update("a", [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }]);
  assert.equal(reg.list()[0].history?.[0]?.toolName, "read");
  reg.update("a", [
    { role: "assistant", kind: "toolCall", toolName: "grep", text: "{}" },
    { role: "assistant", kind: "toolCall", toolName: "ls", text: "{}" },
  ]);
  assert.equal(reg.list()[0].history?.length, 2);
  reg.end("a");
  // updates after end are no-ops (run gone)
  reg.update("a", [{ role: "assistant", kind: "toolCall", toolName: "zzz", text: "{}" }]);
  assert.equal(reg.list().length, 0);
});

test("get returns the live entry by id", () => {
  const reg = new SubagentInFlightRegistry();
  assert.equal(reg.get("missing"), undefined);
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 0 });
  assert.equal(reg.get("a")?.model, "x");
});

test("updateModel records resolvedModel and triggers the bound invalidate", () => {
  const reg = new SubagentInFlightRegistry();
  let invalidated = 0;
  reg.start({ id: "a", model: "tier:medium", taskPreview: "t", startedAt: 0 });
  reg.bindInvalidate("a", () => {
    invalidated++;
  });
  reg.updateModel("a", "google/gemma-4-12b-qat");
  assert.equal(reg.get("a")?.resolvedModel, "google/gemma-4-12b-qat");
  assert.equal(invalidated, 1);
});

test("updateModel on an unknown or ended id is a no-op", () => {
  const reg = new SubagentInFlightRegistry();
  let invalidated = 0;
  reg.updateModel("ghost", "x/y"); // unknown id — no throw, no invalidate
  reg.start({ id: "a", model: "tier:medium", taskPreview: "t", startedAt: 0 });
  reg.bindInvalidate("a", () => {
    invalidated++;
  });
  reg.end("a");
  reg.updateModel("a", "x/y"); // ended — no-op
  assert.equal(reg.get("a"), undefined);
  assert.equal(invalidated, 0);
});

test("start carries batchId through for batch-tool children; undefined for singular-tool runs", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "c0", model: "x", taskPreview: "t", startedAt: 0, batchId: "batch-1" });
  assert.equal(reg.get("c0")?.batchId, "batch-1");
  // singular-tool children omit it → undefined (backward compatible)
  reg.start({ id: "solo", model: "y", taskPreview: "u", startedAt: 0 });
  assert.equal(reg.get("solo")?.batchId, undefined);
});

test("start carries status; markCompleted flips it; endBatch evicts the whole batch", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "c0", model: "x", taskPreview: "t", startedAt: 0, batchId: "bX" });
  reg.start({ id: "c1", model: "y", taskPreview: "u", startedAt: 0, batchId: "bX" });
  // default status is undefined (treated as running); singular-tool entries omit it
  assert.equal(reg.get("c0")?.status, undefined);
  reg.markCompleted("c0");
  assert.equal(reg.get("c0")?.status, "completed");
  assert.equal(reg.get("c1")?.status, undefined, "sibling still running");
  // both still present (kept for k/N + frozen-trace follow)
  assert.equal(reg.list().length, 2);
  reg.endBatch("bX");
  assert.equal(reg.list().length, 0, "whole batch evicted");
});

test("abort(id) fires the entry's abort lever; no-op for unknown/ended ids; entry stays", () => {
  const reg = new SubagentInFlightRegistry();
  let abortCalls = 0;
  reg.start({
    id: "a",
    model: "x",
    taskPreview: "t",
    startedAt: 0,
    abort: () => {
      abortCalls++;
    },
  });
  reg.abort("a");
  assert.equal(abortCalls, 1, "the abort lever fires once");
  assert.ok(reg.get("a"), "abort does NOT remove the entry (distinct from end)");
  // unknown id — no throw, no-op
  reg.abort("ghost");
  assert.equal(abortCalls, 1);
  // ended id — no-op (mirrors update/updateModel)
  reg.end("a");
  reg.abort("a");
  assert.equal(abortCalls, 1, "no-op after end()");
});

test("endBatch evicts only the named batch; a sibling batch is untouched", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "a0", model: "x", taskPreview: "t", startedAt: 0, batchId: "bA" });
  reg.start({ id: "b0", model: "y", taskPreview: "u", startedAt: 0, batchId: "bB" });
  reg.endBatch("bA");
  assert.equal(reg.get("a0"), undefined);
  assert.ok(reg.get("b0"), "bB untouched");
});

test("start defaults foreground to false (background) when the caller omits it", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 0 });
  assert.equal(reg.get("a")?.foreground, false, "omitted foreground normalizes to false (background)");
});

test("start carries foreground:true through (current-turn / inline run)", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 0, foreground: true });
  assert.equal(reg.get("a")?.foreground, true);
  // list() reflects it too — the context box reads list() and filters !foreground
  assert.equal(reg.list()[0].foreground, true);
});

test("start coerces an explicit foreground:undefined back to false", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 0, foreground: undefined });
  assert.equal(reg.get("a")?.foreground, false);
});

test("start accepts an entry with no model (a workflow run aggregates agents across models)", () => {
  // Decision 03 = b2: a workflow run registers with agent="workflow" and NO
  // model — it has no single model. The context box renders a workflow-specific
  // header; /subagents omits the model segment for entries without one.
  const reg = new SubagentInFlightRegistry();
  reg.start({
    id: "wf:r1",
    agent: "workflow",
    taskPreview: "preview_wf · Scan · 1/2 agents",
    startedAt: 0,
    foreground: false,
  });
  const entry = reg.get("wf:r1");
  assert.ok(entry);
  assert.equal(entry.model, undefined, "model is optional — a workflow run omits it");
  assert.equal(entry.agent, "workflow");
  assert.equal(entry.foreground, false);
  assert.equal(entry.taskPreview, "preview_wf · Scan · 1/2 agents");
});

// ── markFallback (ticket 03: model-fallback display) ──

test("markFallback sets requestedModel + fellBack without touching resolvedModel", () => {
  const reg = new SubagentInFlightRegistry();
  let invalidated = 0;
  reg.start({ id: "a", model: "anthropic/claude-opus-4-1", taskPreview: "t", startedAt: 0 });
  reg.bindInvalidate("a", () => {
    invalidated++;
  });
  reg.markFallback("a", "anthropic/claude-opus-4-1");
  const entry = reg.get("a");
  assert.equal(entry?.requestedModel, "anthropic/claude-opus-4-1");
  assert.equal(entry?.fellBack, true);
  assert.equal(entry?.resolvedModel, undefined, "resolvedModel is NOT set by markFallback — updateModel handles that");
  assert.equal(invalidated, 1, "markFallback triggers the bound invalidate");
});

test("markFallback on an unknown or ended id is a no-op", () => {
  const reg = new SubagentInFlightRegistry();
  let invalidated = 0;
  reg.markFallback("ghost", "x/y"); // unknown id — no throw, no invalidate
  reg.start({ id: "a", model: "tier:medium", taskPreview: "t", startedAt: 0 });
  reg.bindInvalidate("a", () => {
    invalidated++;
  });
  reg.end("a");
  reg.markFallback("a", "x/y"); // ended — no-op
  assert.equal(reg.get("a"), undefined);
  assert.equal(invalidated, 0);
});
