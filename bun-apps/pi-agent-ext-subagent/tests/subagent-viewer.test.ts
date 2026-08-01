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
    toolResultEntry("subagent", "report A", {
      exitCode: 0,
      timedOut: false,
      status: "done",
    } as Partial<SubagentToolDetails>),
  ] as never);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(!out.includes("undefined"), "no undefined leaks");
  assert.ok(out.includes("default"), "falls back to the default model label");
});

// ── inline fzf-style filter (taskPreview + agent) ──

function completedRuns(n: number, agent = "implementer", preview = "task") {
  return reconstructSubagentRuns(
    Array.from({ length: n }, (_, i) =>
      toolResultEntry("subagent", `report ${i}`, {
        exitCode: 0,
        timedOut: false,
        agent,
        model: "x/flash",
        taskPreview: `${preview} ${i}`,
        elapsedMs: 1000,
        status: "done",
      } as Partial<SubagentToolDetails>),
    ) as never,
  );
}

test("filter: typing narrows the list to matches; non-matches hidden", () => {
  const runs = [...completedRuns(1, "implementer", "auth"), ...completedRuns(1, "reviewer", "search")];
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("a");
  viewer.handleInput("u");
  viewer.handleInput("t");
  viewer.handleInput("h");
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("auth 0"), "auth run matches");
  assert.ok(!out.includes("search"), "non-match hidden");
});

test("filter: matches the agent label too (case-insensitive)", () => {
  const runs = [...completedRuns(1, "implementer", "auth"), ...completedRuns(1, "Reviewer", "search")];
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("r");
  viewer.handleInput("e");
  viewer.handleInput("v");
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("search"), "matched via agent label Reviewer");
  assert.ok(!out.includes("auth 0"), "non-match hidden");
});

test("filter: backspace widens the list", () => {
  const runs = [...completedRuns(1, "implementer", "auth"), ...completedRuns(1, "reviewer", "search")];
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("a");
  viewer.handleInput("u");
  viewer.handleInput("\x7f"); // backspace
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("search"), "back to full list after backspace");
});

test("filter: esc clears the filter (first esc) then closes (second esc)", () => {
  let closed = false;
  const runs = [...completedRuns(1, "implementer", "auth")];
  const viewer = new SubagentViewer(
    {
      runs,
      onClose: () => {
        closed = true;
      },
    },
    T,
  );
  viewer.handleInput("a");
  viewer.handleInput("\x1b"); // first esc → clear filter, NOT close
  assert.equal(closed, false);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("auth 0"), "filter cleared, run visible again");
  viewer.handleInput("\x1b"); // second esc (filter empty) → close
  assert.equal(closed, true);
});

test("filter: renders a status line with the query and match count", () => {
  const runs = [...completedRuns(1, "implementer", "auth")];
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("a");
  viewer.handleInput("u");
  const out = viewer.render(80).join("\n");
  assert.match(out, /filter/i);
  assert.ok(out.includes("au"), "status line shows the query");
});

// ── cap 20 most-recent + show-all (cap suspended when filtering) ──

const CAP = 20;

test("cap: empty filter limits completed to the 20 most-recent; footer shows the count", () => {
  const runs = completedRuns(25);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes(`showing ${CAP} of 25`), "footer reports the cap");
  assert.ok(out.includes("task 24"), "most-recent run (#25 → 'task 24') visible");
  assert.ok(!out.includes("task 0"), "oldest run beyond the cap is hidden");
});

test("cap: 'a' reveals all completed runs", () => {
  const runs = completedRuns(25);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("a");
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("task 0"), "oldest run visible after show-all");
  assert.ok(!out.includes("showing"), "no cap footer when showing all");
});

test("cap: a non-empty filter suspends the cap — all matches shown", () => {
  // 25 runs all matching "task"
  const runs = completedRuns(25);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  viewer.handleInput("t");
  viewer.handleInput("a");
  viewer.handleInput("s");
  viewer.handleInput("k");
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("task 0"), "oldest match visible (cap suspended by filter)");
  assert.ok(!out.includes("showing"), "no cap footer while filtering");
});

test("cap: cursor clamps to the visible (capped) set", () => {
  const runs = completedRuns(25);
  const viewer = new SubagentViewer({ runs, onClose: () => {} }, T);
  // spam down past the end of the capped list
  for (let i = 0; i < 40; i++) viewer.handleInput("\x1b[B");
  viewer.invalidate();
  assert.doesNotThrow(() => viewer.render(80)); // selected never exceeds entries
});

// ── batch grouping in the Running section (Task 2) ──

test("viewer groups batch children under one header in the Running section", () => {
  const running = [
    runningEntry("batchX:0", { batchId: "batchX", history: [] }),
    runningEntry("batchX:1", { batchId: "batchX", history: [] }),
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  // exactly one batch header for the group
  const headers = out.split("\n").filter((l) => /subagents batch/.test(l));
  assert.equal(headers.length, 1, "one header for the whole batch");
  assert.match(out, /2 running/, "header shows the running count");
  assert.ok(out.includes("doing batchX:0") && out.includes("doing batchX:1"), "both children present");
});

test("ungrouped running entries (no batchId) render flat — no batch header", () => {
  const running = [runningEntry("solo1", { history: [] }), runningEntry("solo2", { history: [] })];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(!out.includes("subagents batch"), "no header for ungrouped runs");
  assert.ok(out.includes("doing solo1") && out.includes("doing solo2"));
});

test("mixed: ungrouped runs flat, batch children grouped under one header", () => {
  const running = [
    runningEntry("solo", { history: [] }),
    runningEntry("batchX:0", { batchId: "batchX", history: [] }),
    runningEntry("batchX:1", { batchId: "batchX", history: [] }),
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("doing solo"), "ungrouped run stays flat");
  assert.match(out, /subagents batch.*2 running/, "batch grouped under one header");
});

test("a batch child is still selectable + followable (cursor unaffected by the header)", () => {
  const running = [runningEntry("batchX:0", { batchId: "batchX" }), runningEntry("batchX:1", { batchId: "batchX" })];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  // entries() is: [header(batchX), batchX:0, batchX:1]. Cursor starts at 0 (the header).
  viewer.handleInput("\x1b[B"); // down → first child (batchX:0)
  viewer.handleInput("\r"); // enter → follow
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("→ read"), "follow streams the selected child's live trace");
});

// ── collapsible batch header (Task 3) ──

test("batch header is selectable; enter collapses its children, enter again expands", () => {
  const running = [
    runningEntry("batchX:0", { batchId: "batchX", history: [] }),
    runningEntry("batchX:1", { batchId: "batchX", history: [] }),
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  let out = viewer.render(80).join("\n");
  assert.ok(out.includes("doing batchX:0"), "expanded by default — children visible");
  assert.match(out, /▼/, "expanded glyph");
  // cursor starts on the header (first entry); enter collapses
  viewer.handleInput("\r");
  out = viewer.render(80).join("\n");
  assert.ok(!out.includes("doing batchX:0") && !out.includes("doing batchX:1"), "collapsed — children hidden");
  assert.match(out, /▶/, "collapsed glyph");
  assert.match(out, /2 running/, "count still shown when collapsed");
  viewer.handleInput("\r"); // expand again
  out = viewer.render(80).join("\n");
  assert.ok(out.includes("doing batchX:0"), "expanded again");
});

test("collapsed batch children are skipped by the cursor (down jumps header→next)", () => {
  const running = [
    runningEntry("batchX:0", { batchId: "batchX" }),
    runningEntry("batchX:1", { batchId: "batchX" }),
    runningEntry("solo"), // ungrouped, after the batch
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  // entries: [header(batchX), solo] once collapsed (children excluded)
  viewer.handleInput("\r"); // collapse the header (cursor on header)
  viewer.handleInput("\x1b[B"); // down → solo
  viewer.handleInput("\r"); // enter on solo (running) → follow
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("→ read"), "landed on solo's follow, not a hidden child");
});

test("collapsing one batch does not collapse another", () => {
  const running = [
    runningEntry("bA:0", { batchId: "bA", history: [] }),
    runningEntry("bB:0", { batchId: "bB", history: [] }),
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  viewer.handleInput("\r"); // collapse bA (header is entry 0)
  const out = viewer.render(80).join("\n");
  assert.ok(!out.includes("doing bA:0"), "bA collapsed");
  assert.ok(out.includes("doing bB:0"), "bB still expanded");
});

test("filter narrows batch children: matching children keep a (recounted) header; a non-matching batch leaves no orphan header", () => {
  const running = [
    runningEntry("batchX:0", { batchId: "batchX", history: [], taskPreview: "auth service" }),
    runningEntry("batchX:1", { batchId: "batchX", history: [], taskPreview: "auth tokens" }),
    runningEntry("batchY:0", { batchId: "batchY", history: [], taskPreview: "billing report" }),
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  viewer.handleInput("a");
  viewer.handleInput("u");
  viewer.handleInput("t");
  viewer.handleInput("h"); // filter "auth"
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("auth service") && out.includes("auth tokens"), "matching batchX children shown");
  assert.ok(!out.includes("billing report"), "non-matching batchY child hidden");
  // batchX header present with the MATCHING count (2); no batchY header
  const headers = out.split("\n").filter((l) => /subagents batch/.test(l));
  assert.equal(headers.length, 1, "one header — batchY dropped entirely, no orphan");
  assert.match(headers[0], /2 running/, "header count reflects matching children only");
});

// ── batch header k/N counts + completed-status children (Task 2: 4a) ──

test("batch header shows k running / N done as children complete", () => {
  const running = [
    runningEntry("bX:0", { batchId: "bX", status: "completed" }),
    runningEntry("bX:1", { batchId: "bX" }), // still running
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  assert.match(out, /1 running/, "running count is the non-completed child");
  assert.match(out, /1 done/, "done count is the completed child");
});

test("a completed batch child renders (greyed) and is still selectable → follow shows frozen trace", () => {
  const running = [
    runningEntry("bX:0", {
      batchId: "bX",
      status: "completed",
      history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }],
    }),
    runningEntry("bX:1", { batchId: "bX" }),
  ];
  const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
  const out = viewer.render(80).join("\n");
  // The completed child still renders under the header, greyed with a ✓
  // checkmark (Task 2's signature completed-row render; the ✓ only appears
  // for completed-status children). With history present the row shows the
  // latest action (▸ read), not the taskPreview — so we assert the ✓ marker.
  assert.ok(out.includes("✓"), "completed child renders greyed (✓) under the header");
  // cursor on header (entry 0); down → first child (bX:0, the completed one); enter → follow
  viewer.handleInput("\x1b[B");
  viewer.handleInput("\r");
  const followed = viewer.render(80).join("\n");
  assert.ok(followed.includes("→ read"), "completed child is selectable → follow shows its frozen trace");
});

test("counts update as more children complete (2 running → 1 running 1 done → 0 running 2 done)", () => {
  // step 0: both running — header shows only the running count.
  {
    const running = [runningEntry("bX:0", { batchId: "bX" }), runningEntry("bX:1", { batchId: "bX" })];
    const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
    const out = viewer.render(80).join("\n");
    assert.match(out, /2 running/, "step 0: header shows the running count");
    assert.doesNotMatch(out, /done/, "step 0: no done count yet");
  }
  // step 1: one child completed — header splits into running / done.
  {
    const running = [
      runningEntry("bX:0", { batchId: "bX", status: "completed" }),
      runningEntry("bX:1", { batchId: "bX" }),
    ];
    const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
    const out = viewer.render(80).join("\n");
    assert.match(out, /1 running \/ 1 done/, "step 1: header shows 1 running / 1 done");
  }
  // step 2: both completed — header still renders (0 running / 2 done); the
  // whole-batch eviction is the tool's job (endBatch), not the viewer's, so
  // the header persists while completed children remain in getRunning().
  {
    const running = [
      runningEntry("bX:0", { batchId: "bX", status: "completed" }),
      runningEntry("bX:1", { batchId: "bX", status: "completed" }),
    ];
    const viewer = new SubagentViewer({ runs: [], getRunning: () => running as never, onClose: () => {} }, T);
    const out = viewer.render(80).join("\n");
    assert.match(out, /0 running \/ 2 done/, "step 2: header persists with 0 running / 2 done");
  }
});
