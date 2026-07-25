import { test } from "bun:test";
import assert from "node:assert/strict";
import type { InFlightSubagent } from "@repo/pi-agent-ext-subagent";
import { SubagentProgressWidget } from "../src/subagent-progress-widget.js";

// Identity theme so render() returns plain text we can assert on (mirrors subagent-viewer.test.ts).
const T = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as never;

function run(over: Partial<InFlightSubagent> = {}): InFlightSubagent {
  return {
    id: "r1",
    agent: "implementer",
    model: "x/flash",
    taskPreview: "doing X",
    startedAt: Date.now() - 1500,
    history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }],
    ...over,
  };
}

test("widget renders nothing when no subagent is running", () => {
  const w = new SubagentProgressWidget({ getRunning: () => [] });
  assert.deepEqual(w.render(T), []);
});

test("widget renders a header + one row per running subagent", () => {
  const w = new SubagentProgressWidget({ getRunning: () => [run()] });
  const out = w.render(T).join("\n");
  assert.match(out, /1 subagent running/);
  assert.ok(out.includes("implementer"), "shows the agent role");
  assert.ok(out.includes("flash"), "shows the shortened model (provider prefix dropped)");
  assert.match(out, /\d+\.\d+s/, "shows live elapsed");
  assert.match(out, /1 call/, "shows the live tool-call count");
  assert.ok(out.includes("▸ read"), "shows the latest tool call via summarizeLatestAction");
});

test("widget pluralizes and lists every running subagent", () => {
  const w = new SubagentProgressWidget({
    getRunning: () => [run({ id: "r1" }), run({ id: "r2", agent: "reviewer", model: "y/pro" })],
  });
  const out = w.render(T).join("\n");
  assert.match(out, /2 subagents running/);
  assert.ok(out.includes("implementer") && out.includes("reviewer"));
});

test("widget prefers resolvedModel over the requested model", () => {
  const w = new SubagentProgressWidget({ getRunning: () => [run({ resolvedModel: "google/gemma-4-12b-qat" })] });
  const out = w.render(T).join("\n");
  assert.ok(out.includes("gemma-4-12b-qat"), "shows the resolved model");
  assert.ok(!out.includes("flash"), "does not show the pre-resolution requested model");
});

test("widget falls back to the task preview before any history exists", () => {
  const w = new SubagentProgressWidget({ getRunning: () => [run({ history: [] })] });
  const out = w.render(T).join("\n");
  assert.ok(out.includes("doing X"), "falls back to the static task preview before any tool call");
});
