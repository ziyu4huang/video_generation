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
  reg.bindInvalidate("a", () => { invalidated++; });
  reg.updateModel("a", "google/gemma-4-12b-qat");
  assert.equal(reg.get("a")?.resolvedModel, "google/gemma-4-12b-qat");
  assert.equal(invalidated, 1);
});

test("updateModel on an unknown or ended id is a no-op", () => {
  const reg = new SubagentInFlightRegistry();
  let invalidated = 0;
  reg.updateModel("ghost", "x/y"); // unknown id — no throw, no invalidate
  reg.start({ id: "a", model: "tier:medium", taskPreview: "t", startedAt: 0 });
  reg.bindInvalidate("a", () => { invalidated++; });
  reg.end("a");
  reg.updateModel("a", "x/y"); // ended — no-op
  assert.equal(reg.get("a"), undefined);
  assert.equal(invalidated, 0);
});
