import { mock, test } from "bun:test";
import assert from "node:assert/strict";
import type { InFlightSubagent } from "../src/index.js";
import { countNoun, isCtrlO, SubagentContextWidget } from "../src/subagent-context-widget.js";
import { STREAMING_EXPANDED_TAIL, workIntentPreview } from "../src/subagent-tool-render.js";

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

// --- elapsed freeze for completed runs (regression) ---
// A completed-status run lingers in the registry (k/N progress) until its
// batch reaps it; while it lingers, the expanded trace's elapsed segment must
// FREEZE at `endedAt`, not keep ticking with Date.now() on every render tick.

test("(regression) a completed run's elapsed does NOT grow across render ticks", () => {
  const t0 = 1_000_000;
  const entry = run({
    id: "done-r1",
    foreground: false,
    status: "completed",
    startedAt: t0,
    endedAt: t0 + 5_000,
    history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"a.ts"}' }],
  });
  const w = new SubagentContextWidget({ getRunning: () => [entry] });
  w.toggle(); // expanded — the trace renders the elapsed segment
  const origNow = Date.now;
  const now = mock(() => t0 + 5_000);
  Date.now = now as unknown as typeof Date.now;
  try {
    const first = w.render(T).join("\n");
    assert.match(first, /5\.0s/, "first render shows endedAt-startedAt");
    // A much later tick — the elapsed must stay frozen, not grow to 120.0s.
    now.mockImplementation(() => t0 + 120_000);
    const second = w.render(T).join("\n");
    assert.match(second, /5\.0s/, "elapsed stays frozen at endedAt for a completed run");
    assert.ok(!second.includes("120.0s"), "a lingering completed run never ticks");
  } finally {
    Date.now = origNow;
  }
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
  const rawTask = "Working dir: /Users/x/proj\n" + "\n" + "Audit the subagent display code for fallback consistency.";
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

// --- ticket 05 / finding 4: context-box expanded trace is tail-capped (latent #1104 flicker) ---
// #1104 capped the INLINE streaming-expanded view (STREAMING_EXPANDED_TAIL) so a
// tall box never re-trips the whole-TUI fullRender flicker. The context-box
// expanded branch (renderRun) renders the FULL history with no cap — and
// extensions/subagent.ts wires Ctrl-O with { consume: false }, so Ctrl-O
// expands BOTH surfaces together. A long background trace would re-trip the
// exact flicker #1104 killed, on the surface #1104 didn't touch. The natural
// path is currently unreachable (background runs render a no-trace header), so
// this constructs the scenario directly to lock the cap in.

/** 40-entry history = 20 (toolCall + toolResult) pairs, each reading f<N>.ts,
 *  so formatSubagentTrace emits 20 `✓ Read f<N>.ts` lines + 1 progress line
 *  (21 trace lines) — well over STREAMING_EXPANDED_TAIL. */
function longHistory(): { role: "assistant"; kind: "toolCall"; toolName: string; text: string }[] {
  const entries: { role: "assistant"; kind: "toolCall"; toolName: string; text: string }[] = [];
  for (let i = 0; i < 20; i++) {
    entries.push({ role: "assistant", kind: "toolCall", toolName: "read", text: `{"path":"f${i}.ts"}` });
    entries.push({ role: "tool" as never, kind: "toolResult", toolName: "read", text: "content" } as never);
  }
  return entries as never;
}

test("ticket 05 / finding 4: expanded context-box trace is tail-capped (does not emit the full long history)", () => {
  const w = new SubagentContextWidget({
    getRunning: () => [run({ id: "cap-r1", foreground: false, history: longHistory() as never })],
  });
  w.toggle(); // expanded
  const lines = w.render(T);
  // The cap is: count header (1) + per-run header (1) + ellipsis (1) + last
  // STREAMING_EXPANDED_TAIL trace lines. The trace MUST NOT render all 20 ✓
  // lines (the full history).
  assert.ok(
    lines.length <= 1 + 1 + 1 + STREAMING_EXPANDED_TAIL,
    `capped to ≤ count+header+ellipsis+tail (got ${lines.length})`,
  );
  assert.ok(
    lines.some((l) => l.includes("…")),
    "an ellipsis marks the dropped middle",
  );
  // The oldest entries are dropped (cap keeps the TAIL) — f0 is not rendered.
  const joined = lines.join("\n");
  assert.ok(!joined.includes("f0.ts"), "oldest trace entries are dropped by the tail cap");
  assert.ok(!joined.includes("f4.ts"), "early trace entries are dropped by the tail cap");
  // The newest entries survive — f19 (the last pair) is kept.
  assert.ok(joined.includes("f19.ts"), "the newest trace entries are retained");
  // The progress line (20 calls) survives inside the tail.
  assert.match(joined, /20 calls/, "the compact progress line survives inside the tail");
});
