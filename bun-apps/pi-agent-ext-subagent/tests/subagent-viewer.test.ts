import { test } from "bun:test";
import assert from "node:assert/strict";
import type { SubagentToolDetails } from "../src/index.js";
import { reconstructSubagentRuns, type SubagentRun, SubagentViewer } from "../src/subagent-viewer.js";

// Identity theme so render() returns plain text we can assert on.
const T = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as never;

function toolResultEntry(toolName: string, text: string, details?: Partial<SubagentToolDetails>, toolCallId?: string) {
  const message: Record<string, unknown> = { role: "toolResult", toolName, content: [{ type: "text", text }], details };
  if (toolCallId) message.toolCallId = toolCallId;
  return { type: "message", message };
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

test("viewer Running section shows the resolved model (short) once resolvedModel is set", () => {
  const running = [
    {
      id: "r1",
      agent: "implementer",
      model: "tier:medium",
      resolvedModel: "google/gemma-4-12b-qat",
      taskPreview: "doing X",
      startedAt: Date.now() - 1500,
      history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }],
    },
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("gemma-4-12b-qat"), "running row shows the resolved model, shortened");
  assert.ok(!out.includes("tier:medium"), "running row no longer shows the stale requested tier once resolved");
});

test("viewer Running section falls back to the model field when resolvedModel is absent", () => {
  const running = [
    {
      id: "r1",
      agent: "implementer",
      model: "tier:medium",
      taskPreview: "doing X",
      startedAt: Date.now() - 1500,
      history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }],
    },
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("tier:medium"), "pre-resolution row still shows the requested tier (unchanged behavior)");
});

test("reconstructSubagentRuns carries toolCallId through from the branch message", () => {
  const branch = [
    toolResultEntry("subagent", "report A", { exitCode: 0, timedOut: false, status: "done" }, "call-xyz"),
  ];
  const runs = reconstructSubagentRuns(branch as never);
  assert.equal(runs[0].toolCallId, "call-xyz");
});

// ── unified selectable list + live-follow (LIVE) ──

function runningEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    agent: "implementer",
    model: "x/flash",
    taskPreview: `doing ${id}`,
    startedAt: Date.now() - 1500,
    history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"a.ts"}' }],
    ...overrides,
  };
}

test("list cursor spans Running + Completed rows (unified); ▶ marks the selected row", () => {
  const running = [runningEntry("r1")];
  const runs = reconstructSubagentRuns([
    toolResultEntry("subagent", "old report", {
      exitCode: 0,
      timedOut: false,
      status: "done",
      agent: "reviewer",
      model: "y/pro",
      taskPreview: "old",
      elapsedMs: 1000,
    }),
  ] as never);
  const viewer = new SubagentViewer({ runs, getRunning: () => running as never, onClose: () => {} }, T);
  // selected=0 → first Running row
  let out = viewer.render(80).join("\n");
  assert.ok(out.includes("▶"), "cursor on the first (running) row");
  // down → first Completed row
  viewer.handleInput("\x1b[B"); // down
  viewer.invalidate();
  out = viewer.render(80).join("\n");
  assert.ok(out.includes("#1"), "completed row present");
});

test("enter on a Running row enters follow and streams the live trace", () => {
  const running = [runningEntry("r1")];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  viewer.handleInput("\r"); // enter on the running row
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("●"), "follow header shows the running glyph");
  assert.ok(out.includes("running"), "follow header shows 'running'");
  assert.ok(out.includes("flash"), "follow header shows the (shortened) model");
  assert.ok(out.includes("→ read"), "follow body streams the live trace");
});

test("follow esc returns to the list", () => {
  const running = [runningEntry("r1")];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  viewer.handleInput("\r"); // enter follow
  viewer.handleInput("\x1b"); // esc
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("Subagent runs") || out.includes("Running"), "back to list view");
});

test("follow shows the resolved model (short) once resolvedModel is set", () => {
  const running = [runningEntry("r1", { model: "tier:medium", resolvedModel: "google/gemma-4-12b-qat" })];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  viewer.handleInput("\r");
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("gemma-4-12b-qat"), "follow header shows the resolved model, shortened");
});

test("follow falls back to 'ended' when the run leaves the registry (LIVE-only behavior, pre-Task-4)", () => {
  let running: unknown[] = [runningEntry("r1")];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  viewer.handleInput("\r"); // enter follow (LIVE)
  viewer.render(80);
  running = []; // run completed / left the registry
  viewer.invalidate();
  // exceed the finalize grace so it lands on 'ended'
  for (let i = 0; i < 7; i++) {
    viewer.invalidate();
    viewer.render(80);
  }
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("ended"), "lands on the neutral ended banner");
});

// ── follow COMPLETED resolution (freeze with final status/usage) ──

function completedRun(toolCallId: string, overrides: Record<string, unknown> = {}): SubagentRun {
  return {
    index: 1,
    toolCallId,
    agent: "implementer",
    model: "x/flash",
    taskPreview: `did ${toolCallId}`,
    status: "done",
    elapsedMs: 4200,
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150, cost: 0.0123 },
    output: "final report body",
    ...overrides,
  } as SubagentRun;
}

test("follow freezes with final status + usage when the run completes (matched by toolCallId)", () => {
  let running: unknown[] = [runningEntry("r1")];
  let completed: SubagentRun[] = [];
  const viewer = new SubagentViewer(
    { runs: [], getRunning: () => running as never, getRuns: () => completed, onClose: () => {} },
    T,
  );
  viewer.handleInput("\r"); // enter follow (LIVE)
  viewer.render(80);
  // run completes: leaves the registry, lands in the branch
  running = [];
  completed = [completedRun("r1")];
  viewer.invalidate();
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("✓"), "frozen header shows the done glyph");
  assert.ok(out.includes("done"), "frozen header shows 'done'");
  assert.ok(out.includes("4.2s"), "elapsed frozen at the completed run's elapsedMs");
  assert.ok(out.includes("$0.01") || out.includes("$0.0123"), "frozen header shows cost");
  assert.ok(out.includes("150 tok"), "frozen header shows tokens");
  assert.ok(out.includes("→ read"), "trace frozen at the last live snapshot");
});

test("follow shows finalizing… within the grace window when the run is gone but not yet in the branch", () => {
  let running: unknown[] = [runningEntry("r1")];
  const completed: SubagentRun[] = [];
  const viewer = new SubagentViewer(
    { runs: [], getRunning: () => running as never, getRuns: () => completed, onClose: () => {} },
    T,
  );
  viewer.handleInput("\r");
  viewer.render(80);
  running = []; // gone, but getRuns still returns []
  viewer.invalidate();
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("finalizing"), "within grace → finalizing hint (no throw)");
});

test("follow never throws if getRuns throws (best-effort fallback)", () => {
  let running: unknown[] = [runningEntry("r1")];
  const viewer = new SubagentViewer(
    {
      runs: [],
      getRunning: () => running as never,
      getRuns: () => {
        throw new Error("boom");
      },
      onClose: () => {},
    },
    T,
  );
  viewer.handleInput("\r"); // enter follow (LIVE)
  viewer.render(80);
  running = []; // run gone → resolveCompletion will call the throwing getRuns
  let out = "";
  assert.doesNotThrow(() => {
    for (let i = 0; i < 8; i++) {
      viewer.invalidate();
      out = viewer.render(80).join("\n");
    }
  });
  assert.ok(out.includes("ended") || out.includes("finalizing"), "lands on a safe banner, no crash");
});

test("reconstructSubagentRuns carries startedAt through from details", () => {
  const branch = [
    toolResultEntry("subagent", "report A", {
      exitCode: 0,
      timedOut: false,
      agent: "implementer",
      model: "x/flash",
      taskPreview: "task A",
      elapsedMs: 1000,
      status: "done",
      startedAt: 1_700_000_000_000,
    } as Partial<SubagentToolDetails>),
  ];
  const runs = reconstructSubagentRuns(branch as never);
  assert.equal(runs[0].startedAt, 1_700_000_000_000);
});

test("reconstructSubagentRuns leaves startedAt undefined when details omit it (legacy)", () => {
  const branch = [
    toolResultEntry("subagent", "legacy", { exitCode: 0, timedOut: false } as Partial<SubagentToolDetails>),
  ];
  const runs = reconstructSubagentRuns(branch as never);
  assert.equal(runs[0].startedAt, undefined);
});

test("viewer list completed row shows relative time + model + elapsed + cost", () => {
  const startedAt = Date.now() - 5 * 60_000; // 5m ago
  const runs = reconstructSubagentRuns([
    toolResultEntry("subagent", "report A", {
      exitCode: 0,
      timedOut: false,
      agent: "implementer",
      model: "x/flash",
      taskPreview: "task A",
      elapsedMs: 2100,
      status: "done",
      startedAt,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0.03 },
    } as Partial<SubagentToolDetails>),
  ] as never);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("5m ago"), "row shows relative start time");
  assert.ok(out.includes("flash"), "row shows short model");
  assert.ok(out.includes("2.1s"), "row shows elapsed");
  assert.ok(out.includes("$0.03"), "row shows cost");
});

test("viewer output header shows absolute HH:MM start time", () => {
  const startedAt = new Date(2024, 0, 1, 14, 32).getTime();
  const runs = reconstructSubagentRuns([
    toolResultEntry("subagent", "report A", {
      exitCode: 0,
      timedOut: false,
      agent: "implementer",
      model: "x/flash",
      taskPreview: "task A",
      elapsedMs: 1000,
      status: "done",
      startedAt,
    } as Partial<SubagentToolDetails>),
  ] as never);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("\r"); // enter → output view
  const out = viewer.render(80).join("\n");
  assert.match(out, /\b14:32\b/, "output header shows absolute start time");
});

test("viewer completed row degrades gracefully when startedAt/model/cost are absent", () => {
  const runs = reconstructSubagentRuns([
    toolResultEntry("subagent", "report A", { exitCode: 0, timedOut: false, status: "done" } as Partial<SubagentToolDetails>),
  ] as never);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(!out.includes("undefined"), "no undefined leaks");
  assert.ok(out.includes("default"), "falls back to the default model label");
});
