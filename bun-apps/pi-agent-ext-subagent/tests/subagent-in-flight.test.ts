import { test } from "bun:test";
import assert from "node:assert/strict";
import { SubagentInFlightRegistry } from "@repo/pi-agent-ext-core-runtime";

test("registry start/views/end lifecycle", () => {
  const reg = new SubagentInFlightRegistry();
  assert.equal(reg.views().length, 0);
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 1000 });
  reg.start({ id: "b", model: "y", taskPreview: "u", startedAt: 2000, agent: "implementer" });
  assert.equal(reg.views().length, 2);
  assert.equal(reg.views().find((v) => v.id === "b")?.actor, "implementer");
  reg.end("a");
  assert.equal(reg.views().length, 1);
  assert.equal(reg.views()[0].id, "b");
  reg.end("b");
  assert.equal(reg.views().length, 0);
});

test("registry update streams history into the live entry; updates after end are no-ops", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 0 });
  reg.update("a", [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }]);
  assert.equal(reg.views()[0].history[0]?.toolName, "read");
  reg.update("a", [
    { role: "assistant", kind: "toolCall", toolName: "grep", text: "{}" },
    { role: "assistant", kind: "toolCall", toolName: "ls", text: "{}" },
  ]);
  assert.equal(reg.views()[0].toolCallCount, 2);
  reg.end("a");
  // updates after end are no-ops (run gone)
  reg.update("a", [{ role: "assistant", kind: "toolCall", toolName: "zzz", text: "{}" }]);
  assert.equal(reg.views().length, 0);
});

test("view() returns the live projection by id", () => {
  const reg = new SubagentInFlightRegistry();
  assert.equal(reg.view("missing"), undefined);
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 0 });
  assert.equal(reg.view("a")?.modelSeg, "x");
});

test("updateModel records resolvedModel and triggers the bound invalidate", () => {
  const reg = new SubagentInFlightRegistry();
  let invalidated = 0;
  reg.start({ id: "a", model: "tier:medium", taskPreview: "t", startedAt: 0 });
  reg.bindInvalidate("a", () => {
    invalidated++;
  });
  reg.updateModel("a", "google/gemma-4-12b-qat");
  // the projection surfaces the resolved model (provider prefix dropped)
  assert.equal(reg.view("a")?.modelSeg, "gemma-4-12b-qat");
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
  assert.equal(reg.view("a"), undefined);
  assert.equal(invalidated, 0);
});

test("start carries batchId through for batch-tool children; undefined for singular-tool runs", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "c0", model: "x", taskPreview: "t", startedAt: 0, batchId: "batch-1" });
  assert.equal(reg.view("c0")?.batchId, "batch-1");
  // singular-tool children omit it → undefined (backward compatible)
  reg.start({ id: "solo", model: "y", taskPreview: "u", startedAt: 0 });
  assert.equal(reg.view("solo")?.batchId, undefined);
});

test("start carries status; markCompleted flips it; endBatch evicts the whole batch", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "c0", model: "x", taskPreview: "t", startedAt: 0, batchId: "bX" });
  reg.start({ id: "c1", model: "y", taskPreview: "u", startedAt: 0, batchId: "bX" });
  // default status is "running" (the unified ActivityStatus vocabulary; start
  // stamps live runs explicitly, so undefined never leaks through `view()`)
  assert.equal(reg.view("c0")?.status, "running");
  reg.markCompleted("c0");
  assert.equal(reg.view("c0")?.status, "done");
  assert.equal(reg.view("c1")?.status, "running", "sibling still running");
  // both still present (kept for k/N + frozen-trace follow)
  assert.equal(reg.views().length, 2);
  reg.endBatch("bX");
  assert.equal(reg.views().length, 0, "whole batch evicted");
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
  assert.ok(reg.view("a"), "abort does NOT remove the entry (distinct from end)");
  assert.equal(reg.view("a")?.abortable, true, "the projection reports the abort lever as wired");
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
  assert.equal(reg.view("a0"), undefined);
  assert.ok(reg.view("b0"), "bB untouched");
});

test("start defaults foreground to false (background) when the caller omits it", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 0 });
  assert.equal(reg.view("a")?.foreground, false, "omitted foreground normalizes to false (background)");
  // views({foreground}) filters on the same axis — the context box reads it
  assert.equal(reg.views({ foreground: false }).length, 1);
  assert.equal(reg.views({ foreground: true }).length, 0);
});

test("start carries foreground:true through (current-turn / inline run)", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 0, foreground: true });
  assert.equal(reg.view("a")?.foreground, true);
  // views() reflects it too — the context box reads views() and filters !foreground
  assert.equal(reg.views()[0].foreground, true);
});

test("start coerces an explicit foreground:undefined back to false", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "a", model: "x", taskPreview: "t", startedAt: 0, foreground: undefined });
  assert.equal(reg.view("a")?.foreground, false);
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
  const v = reg.view("wf:r1");
  assert.ok(v);
  assert.equal(v.modelSeg, "default", "model is optional — a workflow run omits it, the segment falls back");
  assert.equal(v.actor, "workflow");
  assert.equal(v.foreground, false);
  // latestAction falls back to taskPreview when the run has no tool calls yet
  assert.equal(v.latestAction, "preview_wf · Scan · 1/2 agents");
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
  const v = reg.view("a");
  assert.ok(v);
  assert.equal(v.badgeText, "fallback", "the projection badges the fallback run");
  assert.equal(
    v.modelSeg,
    "?→claude-opus-4-1",
    "modelSeg shows resolved←requested; resolved is '?' until updateModel runs",
  );
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
  assert.equal(reg.view("a"), undefined);
  assert.equal(invalidated, 0);
});
