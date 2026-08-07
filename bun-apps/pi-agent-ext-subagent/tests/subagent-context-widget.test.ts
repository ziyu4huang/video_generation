import { test } from "bun:test";
import assert from "node:assert/strict";
import type { InFlightSubagent } from "../src/index.js";
import { SubagentContextWidget } from "../src/subagent-context-widget.js";

// Identity theme so render() returns plain text we can assert on (mirrors the
// old subagent-progress-widget.test.ts).
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

test("(a) box renders nothing when no subagent is running — zero screen footprint", () => {
  const w = new SubagentContextWidget({ getRunning: () => [] });
  assert.deepEqual(w.render(T), []);
});

test("(b) box renders a background run (foreground:false) with the rich header", () => {
  const w = new SubagentContextWidget({ getRunning: () => [run({ foreground: false })] });
  const out = w.render(T).join("\n");
  assert.match(out, /1 background subagent running/);
  // rich header reuses renderSubagentCall → subagent ▸ agent ▸ model ▸ "task"
  assert.ok(out.includes("subagent"), "header shows the tool title");
  assert.ok(out.includes("implementer"), "header shows the agent role");
  assert.ok(out.includes("flash"), "header shows the model");
  assert.ok(out.includes("doing X"), "header shows the task preview");
});

test("(c) box EXCLUDES a foreground run (foreground:true) — no duplication with Surface A", () => {
  const w = new SubagentContextWidget({
    getRunning: () => [run({ id: "inline", foreground: true })],
  });
  assert.deepEqual(w.render(T), [], "a foreground (inline) run never appears in the box");
});

test("box shows background runs and hides foreground ones when both are live", () => {
  const w = new SubagentContextWidget({
    getRunning: () => [
      run({ id: "bg", foreground: false }),
      run({ id: "inline", foreground: true, agent: "reviewer", taskPreview: "inline task" }),
    ],
  });
  const out = w.render(T).join("\n");
  assert.match(out, /1 background subagent running/, "only the background run is counted");
  assert.ok(!out.includes("reviewer"), "the foreground run is excluded");
  assert.ok(!out.includes("inline task"), "the foreground run's task is excluded");
});

test("box treats a run with omitted foreground as background (the registry default)", () => {
  // A caller that omits foreground entirely is treated as background and shown
  // (the registry's start() normalizes omitted → false; the filter !foreground
  // also catches undefined here).
  const w = new SubagentContextWidget({ getRunning: () => [run()] });
  const out = w.render(T).join("\n");
  assert.match(out, /1 background subagent running/);
});

test("box pluralizes the count header for multiple background runs", () => {
  const w = new SubagentContextWidget({
    getRunning: () => [run({ id: "r1", foreground: false }), run({ id: "r2", foreground: false, agent: "reviewer" })],
  });
  const out = w.render(T).join("\n");
  assert.match(out, /2 background subagents running/);
  assert.ok(out.includes("implementer") && out.includes("reviewer"));
});

test("(e) collapsed by default — the live tool tree is NOT shown until toggle()", () => {
  const w = new SubagentContextWidget({ getRunning: () => [run({ foreground: false })] });
  assert.equal(w.isExpanded(), false);
  const collapsed = w.render(T).join("\n");
  // collapsed shows only the count header + the rich header line — no trace
  // markers produced by formatSubagentLive (→ toolName / "tool call").
  assert.ok(!collapsed.includes("→ read"), "collapsed hides the live trace lines");
  assert.ok(!collapsed.includes("tool call"), "collapsed hides the elapsed/count line");
});

test("toggle() expands a background run to show the live tool tree (formatSubagentLive)", () => {
  const w = new SubagentContextWidget({ getRunning: () => [run({ foreground: false })] });
  w.toggle();
  assert.equal(w.isExpanded(), true);
  const out = w.render(T).join("\n");
  assert.ok(out.includes("→ read"), "expanded shows the live tool trace");
  assert.match(out, /\d+\.\d+s elapsed/, "expanded shows live elapsed");
  assert.match(out, /1 tool call/, "expanded shows the tool-call count");
});

test("toggle() flips back to collapsed", () => {
  const w = new SubagentContextWidget({ getRunning: () => [run({ foreground: false })] });
  w.toggle();
  assert.equal(w.isExpanded(), true);
  w.toggle();
  assert.equal(w.isExpanded(), false);
  const out = w.render(T).join("\n");
  assert.ok(!out.includes("→ read"), "collapsed again hides the trace");
});

test("the count header documents the /subagents drill-down", () => {
  const w = new SubagentContextWidget({ getRunning: () => [run({ foreground: false })] });
  const out = w.render(T).join("\n");
  assert.match(out, /\/subagents for detail/);
});

test("a background run with NO history still renders its header (pre-first-tool-call)", () => {
  const w = new SubagentContextWidget({
    getRunning: () => [run({ foreground: false, history: [] })],
  });
  const out = w.render(T).join("\n");
  assert.ok(out.includes("doing X"), "header still shows before any history");
  // and toggle() is a safe no-op-on-render when there is no history
  w.toggle();
  const expanded = w.render(T).join("\n");
  assert.ok(!expanded.includes("tool call"), "no trace fabricated from empty history");
});
