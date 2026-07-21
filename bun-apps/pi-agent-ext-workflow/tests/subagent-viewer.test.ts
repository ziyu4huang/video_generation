import { test } from "bun:test";
import assert from "node:assert/strict";
import type { SubagentToolDetails } from "../src/subagent-tool.js";
import { reconstructSubagentRuns, SubagentViewer } from "../src/subagent-viewer.js";

// Identity theme so render() returns plain text we can assert on.
const T = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as never;

function toolResultEntry(toolName: string, text: string, details?: Partial<SubagentToolDetails>) {
  return { type: "message", message: { role: "toolResult", toolName, content: [{ type: "text", text }], details } };
}

test("reconstructSubagentRuns collects only subagent toolResults, in order, with 1-based index", () => {
  const branch = [
    toolResultEntry("read", "ignored"),
    toolResultEntry("subagent", "Status: DONE\nreport A", {
      exitCode: 0,
      timedOut: false,
      agent: "implementer",
      model: "x/flash",
      taskPreview: "task A",
      elapsedMs: 1000,
      status: "done",
    }),
    toolResultEntry("bash", "ignored"),
    toolResultEntry("subagent", "failed report B", {
      exitCode: 1,
      timedOut: false,
      agent: "reviewer",
      model: "y/pro",
      taskPreview: "task B",
      elapsedMs: 2000,
      status: "failed",
    }),
  ];
  const runs = reconstructSubagentRuns(branch as never);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].index, 1);
  assert.equal(runs[0].agent, "implementer");
  assert.equal(runs[0].output, "Status: DONE\nreport A");
  assert.equal(runs[1].index, 2);
  assert.equal(runs[1].status, "failed");
});

test("reconstructSubagentRuns tolerates missing details (falls back to done/failed by exitCode)", () => {
  const branch = [
    toolResultEntry("subagent", "legacy", { exitCode: 0, timedOut: false } as Partial<SubagentToolDetails>),
  ];
  const runs = reconstructSubagentRuns(branch as never);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].model, "default");
});

test("viewer list shows all runs; enter opens the selected run's full output; esc goes back", () => {
  const runs = reconstructSubagentRuns([
    toolResultEntry("subagent", "report A line one", {
      exitCode: 0,
      timedOut: false,
      agent: "implementer",
      model: "x/flash",
      taskPreview: "task A",
      elapsedMs: 1000,
      status: "done",
    }),
    toolResultEntry("subagent", "report B line one", {
      exitCode: 1,
      timedOut: false,
      agent: "reviewer",
      model: "y/pro",
      taskPreview: "task B",
      elapsedMs: 2000,
      status: "failed",
    }),
  ] as never);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  const list = viewer.render(80).join("\n");
  assert.ok(list.includes("#1"), "list shows run #1");
  assert.ok(list.includes("#2"), "list shows run #2");
  assert.ok(list.includes("task A"));

  // select the second run (down) then open it (enter)
  viewer.handleInput("\x1b[B"); // down
  viewer.handleInput("\r"); // enter
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("report B line one"), "output view shows the selected run's report");
  assert.ok(!out.includes("report A"), "output view is the selected run only");

  // esc returns to the list
  viewer.handleInput("\x1b"); // escape
  const back = viewer.render(80).join("\n");
  assert.ok(back.includes("#1") && back.includes("#2"), "back to list view");
});

test("reconstructSubagentRuns carries usage through from details", () => {
  const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, cost: 0.0023 };
  const branch = [
    toolResultEntry("subagent", "report", {
      exitCode: 0,
      timedOut: false,
      agent: "implementer",
      model: "x/flash",
      taskPreview: "task A",
      elapsedMs: 1000,
      status: "done",
      usage,
    } as Partial<SubagentToolDetails>),
  ];
  const runs = reconstructSubagentRuns(branch as never);
  assert.deepEqual(runs[0].usage, usage);
});

test("viewer output view shows cost/tokens when usage.total > 0", () => {
  const runs = reconstructSubagentRuns([
    toolResultEntry("subagent", "report A", {
      exitCode: 0,
      timedOut: false,
      agent: "implementer",
      model: "x/flash",
      taskPreview: "task A",
      elapsedMs: 1000,
      status: "done",
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, cost: 0.0023 },
    } as Partial<SubagentToolDetails>),
  ] as never);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("\r"); // enter → output view
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("$0.002"));
  assert.ok(out.includes("150 tok"));
});

test("viewer list shows a Running section with live elapsed when getRunning returns in-flight runs", () => {
  const running = [
    {
      id: "r1",
      agent: "implementer",
      model: "x/flash",
      taskPreview: "doing X",
      startedAt: Date.now() - 1500,
      history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }],
    },
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.match(out, /Running/);
  assert.ok(out.includes("implementer"), "running section shows the agent role");
  assert.ok(out.includes("flash"), "running section shows the (shortened) model");
  assert.match(out, /\d+\.\d+s/, "running section shows live elapsed");
  assert.match(out, /1 call/, "running section shows the live tool-call count");
});

test("viewer list omits the Running section when no in-flight runs", () => {
  const viewer = new SubagentViewer({ runs: [], getRunning: () => [], onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(!out.includes("Running"), "no Running section when getRunning is empty");
});

test("viewer Running section shows the agent's latest tool call instead of the static task preview once it has history", () => {
  const running = [
    {
      id: "r1",
      agent: "implementer",
      model: "x/flash",
      taskPreview: "doing X",
      startedAt: Date.now() - 1500,
      history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }],
    },
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("▸ read"), "shows the live latest tool call");
});

test("viewer Running section falls back to the task preview before any history exists", () => {
  const running = [
    {
      id: "r1",
      agent: "implementer",
      model: "x/flash",
      taskPreview: "doing X",
      startedAt: Date.now() - 1500,
      history: [],
    },
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("doing X"), "falls back to the static task preview before any tool call happened");
});
