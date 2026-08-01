import { test } from "bun:test";
import assert from "node:assert/strict";
import { SubagentInFlightRegistry } from "../src/subagent-in-flight.js";

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

test("endBatch evicts only the named batch; a sibling batch is untouched", () => {
  const reg = new SubagentInFlightRegistry();
  reg.start({ id: "a0", model: "x", taskPreview: "t", startedAt: 0, batchId: "bA" });
  reg.start({ id: "b0", model: "y", taskPreview: "u", startedAt: 0, batchId: "bB" });
  reg.endBatch("bA");
  assert.equal(reg.get("a0"), undefined);
  assert.ok(reg.get("b0"), "bB untouched");
});
