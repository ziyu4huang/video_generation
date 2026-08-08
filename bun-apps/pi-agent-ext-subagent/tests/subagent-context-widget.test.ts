import { test } from "bun:test";
import assert from "node:assert/strict";
import type { InFlightSubagent } from "../src/index.js";
import { countNoun, isCtrlO, SubagentContextWidget } from "../src/subagent-context-widget.js";
import { workIntentPreview } from "../src/subagent-tool.js";

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

test("(e) collapsed by default — shows the rich header + ONE latest activity line (not the full trace tree)", () => {
  const w = new SubagentContextWidget({ getRunning: () => [run({ foreground: false })] });
  assert.equal(w.isExpanded(), false);
  const collapsed = w.render(T).join("\n");
  // collapsed shows the latest single activity line (here a toolCall → `↳ Using read`).
  assert.match(collapsed, /↳ Using read/, "collapsed shows the latest activity line");
  // collapsed does NOT show the expanded trace tree: no paired `✓` result lines,
  // no elapsed/count progress header (those live behind toggle()).
  assert.ok(!collapsed.includes("✓ Used read"), "collapsed hides paired result lines");
  assert.ok(!collapsed.includes("tool call"), "collapsed hides the elapsed/count progress header");
});

test("toggle() expands a background run to show the grouped live trace (formatSubagentTrace)", () => {
  const w = new SubagentContextWidget({ getRunning: () => [run({ foreground: false })] });
  w.toggle();
  assert.equal(w.isExpanded(), true);
  const out = w.render(T).join("\n");
  // A lone trailing toolCall (no result yet) renders in-flight: `→ Using read …`
  // with compact progress appended on the SAME line.
  assert.match(out, /→ Using read …/, "expanded marks the un-paired call in-flight (`→ …`)");
  assert.match(out, /\d+\.\d+s · \d+ call/, "expanded appends compact progress to the in-flight line");
  assert.match(out, /1 call(?!s)/, "expanded uses the singular `call` for one tool call");
});

test("toggle() flips back to collapsed", () => {
  const w = new SubagentContextWidget({ getRunning: () => [run({ foreground: false })] });
  w.toggle();
  assert.equal(w.isExpanded(), true);
  w.toggle();
  assert.equal(w.isExpanded(), false);
  const out = w.render(T).join("\n");
  // Collapsed again: the latest activity line is back, but the grouped trace
  // (paired `✓` lines, progress) is hidden.
  assert.match(out, /↳ Using read/, "collapsed shows the single latest line again");
  assert.ok(!out.includes("✓ Used read"), "collapsed hides the grouped result lines");
});

// --- ticket 1: collapsed shows the latest single activity/prose line ---

test("collapsed shows QUOTED assistant prose when the latest entry is text (vs a tool activity)", () => {
  // The quotes are the visual signal that distinguishes "the child is typing
  // this" from "the child is running this tool".
  const w = new SubagentContextWidget({
    getRunning: () => [
      run({
        foreground: false,
        history: [
          { role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"a.ts"}' },
          { role: "tool", kind: "toolResult", toolName: "read", text: "x" },
          { role: "assistant", kind: "text", text: "Let me check the other file next." },
        ],
      }),
    ],
  });
  const out = w.render(T).join("\n");
  assert.match(out, /↳ "Let me check the other file next\."/, "collapsed quotes the latest prose");
  assert.ok(!out.includes("✓ Read a.ts"), "collapsed does not render the grouped trace");
});

test("collapsed shows verb-led past activity when the latest entry is a toolResult", () => {
  const w = new SubagentContextWidget({
    getRunning: () => [
      run({
        foreground: false,
        history: [
          { role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"a.ts"}' },
          { role: "tool", kind: "toolResult", toolName: "read", text: "x" },
        ],
      }),
    ],
  });
  const out = w.render(T).join("\n");
  assert.match(out, /↳ Read a\.ts/, "collapsed shows the latest past-tense activity");
});

// --- ticket 03: Ctrl-O (0x0F) detection for the onTerminalInput handler ---

test("isCtrlO detects the bare Ctrl-O control byte (0x0F)", () => {
  // Ctrl-O is the C0 control byte 0x0F (charCode 15); a real terminal sends
  // exactly "\x0f" for a Ctrl-O keypress.
  assert.equal(isCtrlO("\x0f"), true);
});

test("isCtrlO detects Ctrl-O co-occurring with other bytes in the chunk", () => {
  // Terminals may batch a Ctrl-O with adjacent bytes; substring detection must
  // still trigger so the toggle isn't missed.
  assert.equal(isCtrlO("ab\x0fcd"), true);
});

test("isCtrlO is false for ordinary input (letters, arrows, other control bytes)", () => {
  assert.equal(isCtrlO("hello"), false);
  assert.equal(isCtrlO(""), false);
  // Other Ctrl-letter bytes must NOT trigger (Ctrl-M=0x0d, Ctrl-N=0x0e).
  assert.equal(isCtrlO("\x0d"), false);
  assert.equal(isCtrlO("\x0e"), false);
  // A common escape sequence (arrow key) must not trigger.
  assert.equal(isCtrlO("\x1b[A"), false);
});

test("the count header documents BOTH the Ctrl-O expand hint and the /subagents drill-down", () => {
  const w = new SubagentContextWidget({ getRunning: () => [run({ foreground: false })] });
  const out = w.render(T).join("\n");
  assert.match(out, /Ctrl-O to expand/, "header advertises the box-expand keystroke (ticket 03)");
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

test("(Stage B) a workflow run (agent='workflow') renders under a workflow-specific header", () => {
  // Decision 03 = b2: workflow runs register into the same registry. They don't
  // fit the subagent-shaped model/agent slots (a workflow aggregates agents
  // across models), so the box renders a workflow-specific header line and
  // leaves the per-agent trace to /subagents (collapsed, no fabricated trace).
  const w = new SubagentContextWidget({
    getRunning: () => [
      run({
        id: "wf:r1",
        agent: "workflow",
        model: undefined,
        taskPreview: "preview_wf · Scan · 1/2 agents",
        foreground: false,
        history: [],
      }),
    ],
  });
  const out = w.render(T).join("\n");
  // Ticket 04: a lone workflow run is now counted with the workflow noun, NOT
  // the old fixed "subagent" noun.
  assert.match(out, /1 background workflow running/, "the workflow run is counted with the workflow noun");
  assert.ok(out.includes("workflow"), "header shows the workflow title, not 'subagent'");
  assert.ok(out.includes("preview_wf · Scan · 1/2 agents"), "header shows the workflow preview");
  assert.ok(!out.includes("flash"), "no subagent model slot for a workflow entry");
  // Collapsed by default — no fabricated live trace for a workflow.
  assert.ok(!out.includes("→ read"), "no live trace line for a workflow entry");
});

// --- ticket 04: countNoun picks the header noun from the actual run mix ---

function wf(over: Partial<InFlightSubagent> = {}): InFlightSubagent {
  return run({ id: "wf:1", agent: "workflow", model: undefined, taskPreview: "wf preview", ...over });
}

test("countNoun: a single subagent → 'subagent'", () => {
  assert.equal(countNoun([run({ foreground: false })]), "subagent");
});

test("countNoun: two subagents → 'subagents'", () => {
  assert.equal(countNoun([run({ id: "r1", foreground: false }), run({ id: "r2", foreground: false })]), "subagents");
});

test("countNoun: a single workflow → 'workflow' (NOT 'subagent')", () => {
  assert.equal(countNoun([wf({ foreground: false })]), "workflow");
});

test("countNoun: two workflows → 'workflows'", () => {
  assert.equal(countNoun([wf({ id: "wf:1", foreground: false }), wf({ id: "wf:2", foreground: false })]), "workflows");
});

test("countNoun: a mixed set (1 subagent + 1 workflow) → 'runs'", () => {
  assert.equal(countNoun([run({ id: "r1", foreground: false }), wf({ id: "wf:1", foreground: false })]), "runs");
});

// --- ticket 04 finding 1: work-intent strip on the DOCKED context-box header ---
// #1101 claimed to strip the `Working dir:` preamble on BOTH the inline live
// header AND the docked context box, but its tests only exercised
// renderSubagentCall with a raw multi-line task. The docked box fed the
// already-single-lined `taskPreview` into renderSubagentCall, so
// workIntentPreview's preamble branch never matched and the box still showed
// "Working dir: …". This test closes that gap: the entry now carries a
// precomputed `workIntent`, and renderRun feeds THAT (not taskPreview).

test("ticket 04 / finding 1: docked header strips the `Working dir:` preamble and surfaces the work intent", () => {
  const rawTask =
    "Working dir: /Users/x/proj\n" +
    "\n" +
    "Audit the subagent display code for fallback consistency.";
  // The tool precomputes workIntent once at start() (mirrors subagent-tool.execute).
  const entry = run({
    id: "strip-r1",
    foreground: false,
    taskPreview: "Working dir: /Users/x/proj Audit the subagent display code for fallback consistency.",
    workIntent: workIntentPreview(rawTask),
    history: [],
  });
  const w = new SubagentContextWidget({ getRunning: () => [entry] });
  const out = w.render(T).join("\n");
  assert.ok(
    out.includes("Audit the subagent display code for fallback consistency."),
    "header surfaces the actual work intent (first non-preamble line)",
  );
  assert.ok(!out.includes("Working dir:"), "the cwd/repo preamble is stripped from the docked header");
});

test("ticket 04 / finding 1: docked header still shows the preamble when workIntent is absent (backward-compat)", () => {
  // An entry that never populated workIntent (old caller / synthetic test entry)
  // falls back to taskPreview — no crash, no fabricated strip.
  const entry = run({
    id: "nofallback-r1",
    foreground: false,
    taskPreview: "Working dir: /Users/x/proj do the thing",
    history: [],
  });
  const w = new SubagentContextWidget({ getRunning: () => [entry] });
  const out = w.render(T).join("\n");
  assert.ok(out.includes("Working dir:"), "falls back to taskPreview verbatim when workIntent is absent");
});
