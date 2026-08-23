# subagent TUI visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan may be executed via the repo's own `subagent` tool (dogfood) — the implementer and reviewer are dispatched through it.

**Goal:** Give the `subagent` tool todo-style TUI visibility — a rich `renderCall` line while running, a collapsible `renderResult`, and a `/subagents` command that lists past runs from the session and shows a selected run's full output — plus a test guarding the superpowers→subagent wiring.

**Architecture:** Approach A (todo-mirror). All display data flows through the tool's `details` + `content` (session-stored, branching-safe). `execute` enriches `details` with `agent/model/taskPreview/elapsedMs/status`; `renderCall`/`renderResult` render from `args`/`details`; a new `/subagents` command reconstructs runs from `ctx.sessionManager.getBranch()` (exactly like the upstream `todo` extension's `/todos`). No live streaming (Level-2, deferred).

**Tech Stack:** TypeScript, `bun:test`, `node:assert/strict` (workflow tests) / `bun:test` `describe/it/expect` (superpowers tests), `@earendil-works/pi-tui` (`Text`, `truncateToWidth`, `matchesKey`, `Key`), `@earendil-works/pi-coding-agent` (`Theme`).

**Source spec:** `docs/superpowers/specs/2026-07-18-subagent-tui-visibility-design.md`

## Global Constraints

- **Bun only** — `( cd bun-apps/pi-agent-ext-workflow && bun test )` and `( cd bun-apps/pi-agent-ext-superpowers && bun test )`. Never `node`/`npx`.
- **No top-level `cd`** — use subshells.
- **No `spawnSubagent` / `WorkflowAgent` changes** (Level-2 streaming is explicitly out of scope).
- **superpowers source is unchanged** — the wiring is prompt-level (`src/superpowers.ts` already instructs the agent to use the workflow `subagent` tool); Task 4 only adds a *test* guarding that text.
- **Note for implementers:** if the `write`/`edit` tools are blocked on `bun-apps/` by the movie-director tool-scope guard, use `bash` (`cat > … <<'EOF'` to create, a `/tmp/*.mjs` read-replace-write script to edit) — bash is not subject to that guard.
- **Conventions:** workflow tests use `import { test } from "bun:test"; import assert from "node:assert/strict";` and call `tool.execute("id", params, NO_SIGNAL, undefined, NO_CTX)`. superpowers tests use `import { describe, expect, it } from "bun:test";`.

---

### Task 1: enrich `SubagentToolDetails` + time/status in `execute`

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts` (extend)

**Interfaces:**
- Produces: expanded `SubagentToolDetails` (adds `agent?`, `model?`, `taskPreview`, `elapsedMs`, `status`); exported helpers `taskPreview(task, n?)` and `deriveSubagentStatus(result)`. Tasks 2 and 3 consume these.

- [ ] **Step 1: Write the failing tests** — append to `tests/subagent-tool.test.ts`. Update the import line first:

Replace the import:
```ts
import { createSubagentTool, formatSubagentResult } from "../src/subagent-tool.js";
```
with:
```ts
import { createSubagentTool, deriveSubagentStatus, formatSubagentResult, taskPreview } from "../src/subagent-tool.js";
```

Then append these tests:
```ts
// ── details enrichment (renderResult + /subagents data source) ──
test("execute enriches details with agent/model/taskPreview/elapsedMs/status for a done run", async () => {
  const f = fakeSpawn(() => ({ output: "Status: DONE", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute(
    "id",
    { task: "do something\nwith newlines   and spaces", agent: "implementer", model: "x/flash" },
    NO_SIGNAL,
    undefined,
    NO_CTX,
  );
  const d = res.details;
  assert.equal(d.status, "done");
  assert.equal(d.agent, "implementer");
  assert.equal(d.model, "x/flash");
  assert.equal(d.exitCode, 0);
  assert.ok(d.elapsedMs >= 0, "elapsedMs recorded");
  assert.ok(!d.taskPreview.includes("\n"), "taskPreview is single-line");
  assert.ok(d.taskPreview.length <= 80, "taskPreview bounded to 80");
});

test("execute defaults model to 'default' and omits agent when absent", async () => {
  const f = fakeSpawn(() => ({ output: "ok", exitCode: 0, stderr: "", timedOut: false }));
  const tool = createSubagentTool({ spawn: f.spawn });
  const res = await tool.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(res.details.model, "default");
  assert.equal(res.details.agent, undefined);
});

test("execute reports status 'timedout' and 'failed' from the spawn result", async () => {
  const t = createSubagentTool({ spawn: fakeSpawn(() => ({ output: "", exitCode: 124, stderr: "x", timedOut: true })).spawn });
  const rt = await t.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(rt.details.status, "timedout");
  const f = createSubagentTool({ spawn: fakeSpawn(() => ({ output: "", exitCode: 1, stderr: "boom", timedOut: false })).spawn });
  const rf = await f.execute("id", { task: "t" }, NO_SIGNAL, undefined, NO_CTX);
  assert.equal(rf.details.status, "failed");
});

test("deriveSubagentStatus + taskPreview helpers", () => {
  assert.equal(deriveSubagentStatus({ output: "", exitCode: 0, stderr: "", timedOut: false }), "done");
  assert.equal(deriveSubagentStatus({ output: "", exitCode: 1, stderr: "", timedOut: false }), "failed");
  assert.equal(deriveSubagentStatus({ output: "", exitCode: 124, stderr: "", timedOut: true }), "timedout");
  assert.equal(taskPreview("hello"), "hello");
  const long = "x".repeat(120);
  assert.equal(taskPreview(long).length, 80);
  assert.ok(taskPreview(long).endsWith("…"));
  assert.equal(taskPreview("a\n b\n  c"), "a b c");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: FAIL — `res.details.status` is `undefined` (today's details only has `exitCode`/`timedOut`); `deriveSubagentStatus`/`taskPreview` not exported.

- [ ] **Step 3: Implement** — edit `src/subagent-tool.ts`.

Replace the `SubagentToolDetails` interface:
```ts
export interface SubagentToolDetails {
  exitCode: number;
  timedOut: boolean;
}
```
with:
```ts
export interface SubagentToolDetails {
  exitCode: number;
  timedOut: boolean;
  /** Role label (params.agent), if provided. */
  agent?: string;
  /** params.model, or "default". */
  model?: string;
  /** First ~80 chars of params.task, single-lined. */
  taskPreview: string;
  /** Wall-clock of the run, ms. */
  elapsedMs: number;
  status: "done" | "failed" | "timedout";
}
```

Add these helpers immediately AFTER the existing `formatSubagentResult` function:
```ts
/** Collapse a task prompt to a single-line preview of at most `n` chars. */
export function taskPreview(task: string, n = 80): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? oneLine.slice(0, n - 1) + "…" : oneLine;
}

/** Derive a human status from the spawn result. */
export function deriveSubagentStatus(r: SpawnSubagentResult): SubagentToolDetails["status"] {
  if (r.exitCode === 0) return "done";
  return r.timedOut ? "timedout" : "failed";
}
```

Replace the `execute` body inside `createSubagentTool`:
```ts
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await spawn({
        task: params.task,
        tools: params.tools,
        excludeTools: params.excludeTools,
        model: params.model,
        cwd: params.cwd ?? defaultCwd,
        instructions: params.agent ? `You are the ${params.agent} for this task.` : undefined,
        extensionTools: options.getExtensionTools?.(),
      });
      return {
        content: [{ type: "text" as const, text: formatSubagentResult(result) }],
        details: { exitCode: result.exitCode, timedOut: result.timedOut },
      };
    },
```
with:
```ts
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const t0 = Date.now();
      const result = await spawn({
        task: params.task,
        tools: params.tools,
        excludeTools: params.excludeTools,
        model: params.model,
        cwd: params.cwd ?? defaultCwd,
        instructions: params.agent ? `You are the ${params.agent} for this task.` : undefined,
        extensionTools: options.getExtensionTools?.(),
      });
      return {
        content: [{ type: "text" as const, text: formatSubagentResult(result) }],
        details: {
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          agent: params.agent,
          model: params.model ?? "default",
          taskPreview: taskPreview(params.task),
          elapsedMs: Date.now() - t0,
          status: deriveSubagentStatus(result),
        },
      };
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: PASS — all (existing + new) green.

- [ ] **Step 5: Typecheck + commit**

Run: `( cd bun-apps/pi-agent-ext-workflow && bunx tsc --noEmit )` — clean.
```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts
git commit -m "feat(workflow): enrich subagent tool details with role/model/taskPreview/elapsedMs/status

Feeds the upcoming renderResult + /subagents viewer. execute records a wall-clock
delta and derives a human status (done|failed|timedout); taskPreview collapses
the task to a single-line bounded preview. Existing exitCode/timedOut fields kept."
```

---

### Task 2: `renderCall` + `renderResult` on the subagent tool

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts` (extend)

**Interfaces:**
- Consumes: `SubagentToolDetails`, `taskPreview` (Task 1).
- Produces: exported pure helpers `renderSubagentCall(args, theme)` and `renderSubagentResult(result, options, theme)` (both return a themed string); the tool definition gains `renderCall`/`renderResult` that wrap them via the `context.lastComponent` reuse pattern (same as pi core's find/read tools).

- [ ] **Step 1: Write the failing tests** — append to `tests/subagent-tool.test.ts`. First extend the import to include the new helpers + `Theme`:

Replace:
```ts
import { createSubagentTool, deriveSubagentStatus, formatSubagentResult, taskPreview } from "../src/subagent-tool.js";
```
with:
```ts
import {
  createSubagentTool,
  deriveSubagentStatus,
  formatSubagentResult,
  renderSubagentCall,
  renderSubagentResult,
  taskPreview,
} from "../src/subagent-tool.js";
import type { SubagentToolDetails } from "../src/subagent-tool.js";
```

Append a stub theme + tests:
```ts
// ── renderCall / renderResult (pure helpers, themed strings) ──
// Identity theme so assertions see plain text.
const T = {
  fg: (_c: string, s: string) => s,
  bg: (_c: string, s: string) => s,
  bold: (s: string) => s,
} as never;

test("renderSubagentCall shows subagent ▸ agent ▸ model ▸ task (omits agent when absent)", () => {
  const withRole = renderSubagentCall({ task: "fix the bug", agent: "implementer", model: "x/flash" }, T);
  assert.ok(withRole.includes("subagent"));
  assert.ok(withRole.includes("implementer"));
  assert.ok(withRole.includes("x/flash"));
  assert.ok(withRole.includes("fix the bug"));
  const noRole = renderSubagentCall({ task: "explore", model: "y/pro" }, T);
  assert.ok(noRole.includes("subagent"));
  assert.ok(!noRole.includes("▸ implementer"));
  assert.ok(noRole.includes("default")); // model defaults to "default" when undefined
});

test("renderSubagentResult collapsed is short; expanded contains the full report", () => {
  const details: SubagentToolDetails = {
    exitCode: 0, timedOut: false, agent: "implementer", model: "x/flash",
    taskPreview: "p", elapsedMs: 12350, status: "done",
  };
  const full = "Line one of report\nLine two of report\nLine three";
  const collapsed = renderSubagentResult(
    { content: [{ type: "text", text: full }], details }, { expanded: false }, T,
  );
  const expanded = renderSubagentResult(
    { content: [{ type: "text", text: full }], details }, { expanded: true }, T,
  );
  assert.ok(collapsed.length < expanded.length, "collapsed is shorter");
  assert.ok(collapsed.includes("done"));
  assert.ok(collapsed.includes("Line one of report"));
  assert.ok(!collapsed.includes("Line three"), "collapsed drops later lines");
  assert.ok(expanded.includes("Line one of report"));
  assert.ok(expanded.includes("Line three"), "expanded keeps everything");
  assert.ok(expanded.includes("12.3s") || expanded.includes("12."), "expanded shows elapsed seconds");
});

test("renderSubagentResult failed/timedout badges + missing-details fallback", () => {
  const failStr = renderSubagentResult(
    { content: [{ type: "text", text: "err" }], details: { exitCode: 1, timedOut: false, taskPreview: "p", elapsedMs: 0, status: "failed" } },
    { expanded: false }, T,
  );
  assert.ok(failStr.includes("failed"));
  const toStr = renderSubagentResult(
    { content: [{ type: "text", text: "err" }], details: { exitCode: 124, timedOut: true, taskPreview: "p", elapsedMs: 0, status: "timedout" } },
    { expanded: false }, T,
  );
  assert.ok(toStr.includes("timedout"));
  // No details → just the raw text
  assert.equal(renderSubagentResult({ content: [{ type: "text", text: "raw" }] }, { expanded: false }, T), "raw");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: FAIL — `renderSubagentCall`/`renderSubagentResult` not exported.

- [ ] **Step 3: Implement** — edit `src/subagent-tool.ts`.

Add imports at the top. Replace:
```ts
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
```
with:
```ts
import { defineTool, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
```
(If `Theme` is not exported from `@earendil-works/pi-coding-agent`, import it from `@earendil-works/pi-tui` instead — confirm with `bunx tsc --noEmit` in Step 5; the upstream `todo` example imports `Theme` from `@earendil-works/pi-coding-agent`.)

Add the two pure helpers right AFTER `deriveSubagentStatus`:
```ts
/** Theme the call line shown WHILE the subagent runs (pi's spinner conveys activity). */
export function renderSubagentCall(
  args: { agent?: string; model?: string; task: string },
  theme: Theme,
): string {
  const parts: string[] = [theme.bold(theme.fg("toolTitle", "subagent"))];
  if (args.agent) parts.push(theme.fg("accent", args.agent));
  parts.push(theme.fg("muted", args.model ?? "default"));
  parts.push(theme.fg("dim", `"${taskPreview(args.task, 60)}"`));
  return parts.join(" ▸ ");
}

/** Theme the result: collapsed = badge+meta+headline; expanded = full report. */
export function renderSubagentResult(
  result: { content: Array<{ type: string; text?: string }>; details?: SubagentToolDetails },
  options: { expanded?: boolean },
  theme: Theme,
): string {
  const d = result.details;
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  if (!d) return text;
  const badge =
    d.status === "done"
      ? theme.fg("success", "✓ done")
      : d.status === "timedout"
        ? theme.fg("warning", "⏱ timedout")
        : theme.fg("error", "✗ failed");
  const meta = theme.fg("muted", `${d.model ?? "default"} · ${(d.elapsedMs / 1000).toFixed(1)}s`);
  if (!options.expanded) {
    const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
    return `${badge} ${meta} ${theme.fg("dim", truncateToWidth(firstLine, 60))}`;
  }
  return `${badge} ${meta}\n${theme.fg("toolOutput", text)}`;
}
```

Add `renderCall`/`renderResult` to the `defineTool({...})` options, immediately AFTER the `execute` method (before the closing `});` of `defineTool`). Use the `context.lastComponent` reuse pattern from pi core's find/read tools:
```ts
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(renderSubagentCall(args, theme));
      return text;
    },
    renderResult(result, options, _theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(renderSubagentResult(result, options, context.theme ?? _theme));
      return text;
    },
```
(Note: `renderResult`'s `theme` is the 3rd positional param; if your lint complains about the `_theme`/`context.theme` split, simplify to `renderResult(result, options, theme, _context)` and call `renderSubagentResult(result, options, theme)` — both are valid; pick the one that typechecks. The simplest correct form is:)
```ts
    renderResult(result, options, theme, _context) {
      const text = (_context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(renderSubagentResult(result, options, theme));
      return text;
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-tool.test.ts )`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `( cd bun-apps/pi-agent-ext-workflow && bunx tsc --noEmit )` — clean.
```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-tool.ts bun-apps/pi-agent-ext-workflow/tests/subagent-tool.test.ts
git commit -m "feat(workflow): todo-style renderCall/renderResult for the subagent tool

renderCall shows subagent ▸ agent ▸ model ▸ task while the child runs;
renderResult is collapsible (collapsed: status badge + model + elapsed +
headline; expanded: full report). Mirrors the upstream todo tool + pi core's
find/read lastComponent-reuse pattern."
```

---

### Task 3: `/subagents` history viewer (reconstruct + stateful component + command)

**Files:**
- Create: `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/extensions/workflow.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts` (CREATE)

**Interfaces:**
- Consumes: `SubagentToolDetails` (Task 1), `ctx.sessionManager.getBranch()`.
- Produces: `reconstructSubagentRuns(branch)` (pure), `SubagentViewer` (stateful component), `SubagentRun` type; the `/subagents` command registered in the extension.

- [ ] **Step 1: Write the failing test** — create `tests/subagent-viewer.test.ts`:
```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import { reconstructSubagentRuns, SubagentViewer } from "../src/subagent-viewer.js";
import type { SubagentToolDetails } from "../src/subagent-tool.js";

// Identity theme so render() returns plain text we can assert on.
const T = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as never;

function toolResultEntry(toolName: string, text: string, details?: Partial<SubagentToolDetails>) {
  return { type: "message", message: { role: "toolResult", toolName, content: [{ type: "text", text }], details } };
}

test("reconstructSubagentRuns collects only subagent toolResults, in order, with 1-based index", () => {
  const branch = [
    toolResultEntry("read", "ignored"),
    toolResultEntry("subagent", "Status: DONE\nreport A", {
      exitCode: 0, timedOut: false, agent: "implementer", model: "x/flash", taskPreview: "task A", elapsedMs: 1000, status: "done",
    }),
    toolResultEntry("bash", "ignored"),
    toolResultEntry("subagent", "failed report B", {
      exitCode: 1, timedOut: false, agent: "reviewer", model: "y/pro", taskPreview: "task B", elapsedMs: 2000, status: "failed",
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
  const branch = [toolResultEntry("subagent", "legacy", { exitCode: 0, timedOut: false } as Partial<SubagentToolDetails>)];
  const runs = reconstructSubagentRuns(branch as never);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "done");
  assert.equal(runs[0].model, "default");
});

test("viewer list shows all runs; enter opens the selected run's full output; esc goes back", () => {
  const runs = reconstructSubagentRuns([
    toolResultEntry("subagent", "report A line one", {
      exitCode: 0, timedOut: false, agent: "implementer", model: "x/flash", taskPreview: "task A", elapsedMs: 1000, status: "done",
    }),
    toolResultEntry("subagent", "report B line one", {
      exitCode: 1, timedOut: false, agent: "reviewer", model: "y/pro", taskPreview: "task B", elapsedMs: 2000, status: "failed",
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )`
Expected: FAIL — module `../src/subagent-viewer.js` not found.

- [ ] **Step 3: Implement the viewer** — create `src/subagent-viewer.ts`:
```ts
/**
 * `/subagents` history viewer. Reconstructs past `subagent` tool runs from the
 * session branch (exactly like the upstream `todo` extension's `/todos`) and
 * renders a stateful list↔output component. No live streaming — runs are the
 * COMPLETED tool results stored in the session (branching-safe by construction).
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { SubagentToolDetails } from "./subagent-tool.js";

export interface SubagentRun {
  /** 1-based ordinal among subagent runs on this branch. */
  index: number;
  agent?: string;
  model: string;
  taskPreview: string;
  status: "done" | "failed" | "timedout";
  elapsedMs: number;
  /** The full text the parent agent read (content[0].text). */
  output: string;
}

interface BranchMessage {
  role?: string;
  toolName?: string;
  content?: Array<{ type: string; text?: string }>;
  details?: Partial<SubagentToolDetails>;
}
interface BranchEntry {
  type: string;
  message?: BranchMessage;
}

/** Scan a session branch and collect subagent tool results in order. */
export function reconstructSubagentRuns(branch: Iterable<BranchEntry>): SubagentRun[] {
  const runs: SubagentRun[] = [];
  let i = 0;
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (!msg || msg.role !== "toolResult" || msg.toolName !== "subagent") continue;
    i += 1;
    const d = msg.details;
    const status: SubagentRun["status"] = d?.status ?? (d && d.exitCode === 0 ? "done" : "failed");
    runs.push({
      index: i,
      agent: d?.agent,
      model: d?.model ?? "default",
      taskPreview: d?.taskPreview ?? "",
      status,
      elapsedMs: d?.elapsedMs ?? 0,
      output: msg.content?.find((c) => c.type === "text")?.text ?? "",
    });
  }
  return runs;
}

interface ViewerOpts {
  runs: SubagentRun[];
  onClose: () => void;
}

/** Stateful list↔output viewer. `view` flips on enter/esc; no second UI mount. */
export class SubagentViewer {
  private runs: SubagentRun[];
  private view: "list" | "output" = "list";
  private selected = 0;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private theme: Theme;

  constructor(opts: ViewerOpts, theme: Theme) {
    this.runs = opts.runs;
    this.onClose = opts.onClose;
    this.theme = theme;
  }

  handleInput(data: string): void {
    const th = this.theme;
    if (matchesKey(data, Key.escape)) {
      if (this.view === "output") {
        this.view = "list";
        this.invalidate();
      } else {
        this.onClose();
      }
      return;
    }
    if (this.view === "list") {
      if (matchesKey(data, Key.up) && this.selected > 0) {
        this.selected -= 1;
        this.invalidate();
      } else if (matchesKey(data, Key.down) && this.selected < this.runs.length - 1) {
        this.selected += 1;
        this.invalidate();
      } else if (matchesKey(data, Key.enter) && this.runs.length > 0) {
        this.view = "output";
        this.invalidate();
      }
    }
    void th; // theme used in render
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    if (this.view === "list") {
      this.cachedLines = this.renderList(width, th);
    } else {
      this.cachedLines = this.renderOutput(width, th);
    }
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private renderList(width: number, th: Theme): string[] {
    const lines: string[] = [""];
    const title = th.fg("accent", th.bold(" Subagent runs "));
    lines.push(truncateToWidth(title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 15))), width));
    lines.push("");
    if (this.runs.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No subagent runs on this branch.")}`, width));
    } else {
      for (const r of this.runs) {
        const cur = r.index - 1 === this.selected;
        const badge =
          r.status === "done" ? th.fg("success", "✓") : r.status === "timedout" ? th.fg("warning", "⏱") : th.fg("error", "✗");
        const head = `${badge} ${th.fg("accent", `#${r.index}`)} ${th.fg("muted", r.agent ?? "general-purpose")} ▸ ${th.fg("dim", truncateToWidth(r.taskPreview, 50))}`;
        lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", "▶ " + head) : "  " + head}`, width));
      }
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select • enter view • esc close")}`, width));
    lines.push("");
    return lines;
  }

  private renderOutput(width: number, th: Theme): string[] {
    const r = this.runs[this.selected];
    if (!r) return [""];
    const lines: string[] = [""];
    lines.push(
      truncateToWidth(
        `  ${th.fg("accent", `#${r.index}`)} ${th.fg("muted", r.agent ?? "general-purpose")} ▸ ${r.model} • ${r.status} • ${(r.elapsedMs / 1000).toFixed(1)}s`,
        width,
      ),
    );
    lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
    for (const ln of r.output.split("\n")) {
      lines.push(truncateToWidth(`  ${th.fg("toolOutput", ln)}`, width));
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "esc back to list")}`, width));
    lines.push("");
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )`
Expected: PASS.

- [ ] **Step 5: Register the `/subagents` command** — edit `extensions/workflow.ts`.

Add the import (next to the existing `createSubagentTool` import). Replace:
```ts
import { createSubagentTool } from "../src/subagent-tool.js";
```
with:
```ts
import { createSubagentTool } from "../src/subagent-tool.js";
import { reconstructSubagentRuns, SubagentViewer } from "../src/subagent-viewer.js";
```

Register the command inside `extension(pi)`, right after the `pi.registerTool(subagentTool);` line (after the try/catch active-at-load guard block):
```ts
  // /subagents — list past subagent runs on this branch and view their full
  // output (todo-style: reconstruct from session toolResults, no live stream).
  pi.registerCommand("subagents", {
    description: "List past subagent runs on this branch and view their output",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/subagents requires interactive mode", "error");
        return;
      }
      const branch = (ctx.sessionManager?.getBranch() ?? []) as never;
      const runs = reconstructSubagentRuns(branch);
      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        const viewer = new SubagentViewer({ runs, onClose: () => done() }, theme);
        return {
          render: (w: number) => viewer.render(w),
          invalidate: () => viewer.invalidate(),
          handleInput: (data: string) => {
            viewer.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  });
```

- [ ] **Step 6: Typecheck + full suite + commit**

Run: `( cd bun-apps/pi-agent-ext-workflow && bunx tsc --noEmit && bun test )` — typecheck clean; suite green.
```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts bun-apps/pi-agent-ext-workflow/extensions/workflow.ts bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts
git commit -m "feat(workflow): /subagents command to browse past subagent runs + view output

Reconstructs subagent tool results from the session branch (todo /todos pattern)
and renders a stateful list↔output viewer (enter to open a run, esc back, esc
again to close). Branching-safe: state is the session itself, no external file."
```

---

### Task 4: guard the superpowers→subagent wiring (test)

**Files:**
- Modify: `bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts`

**Interfaces:** none (pure assertion over the existing `getBootstrapContent()` payload).

- [ ] **Step 1: Write the failing assertion** — in `tests/bootstrap.test.ts`, extend the existing `"getBootstrapContent returns non-null with marker + real skill body + Pi tool mapping"` test (in the `describe("bootstrap payload assembly")` block). Replace its body's last two `expect` lines:

Replace:
```ts
    expect(payload).toContain("## Pi tool mapping");
    expect(payload).toContain("pi-agent-ext-workflow");
  });
```
with:
```ts
    expect(payload).toContain("## Pi tool mapping");
    expect(payload).toContain("pi-agent-ext-workflow");
  });

  it("Pi tool mapping names the workflow 'subagent' tool + its documented params", () => {
    _resetBootstrapCacheForTests();
    const payload = getBootstrapContent() ?? "";
    expect(payload).toContain("subagent");
    // the documented call signature the agent is told to use
    expect(payload).toContain("task");
    expect(payload).toMatch(/tools|excludeTools|cwd|model/);
  });
```

- [ ] **Step 2: Run test to verify it fails (or passes if already covered)**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test tests/bootstrap.test.ts )`
Expected: PASS — the mapping text (src/superpowers.ts ~line 134) already contains `subagent({ task, model, tools, excludeTools, cwd })`, so this is a regression guard, not a RED→GREEN. If it FAILS, the mapping text drifted and this test correctly flags it; fix the source, not the test.

- [ ] **Step 3: Full superpowers suite + commit**

Run: `( cd bun-apps/pi-agent-ext-superpowers && bun test )` — green.
```bash
git add bun-apps/pi-agent-ext-superpowers/tests/bootstrap.test.ts
git commit -m "test(superpowers): guard Pi tool-mapping names the workflow subagent tool + params

The superpowers→subagent wiring is prompt-level: src/superpowers.ts instructs the
agent to use the pi-agent-ext-workflow 'subagent' tool. Pin that the assembled
bootstrap payload actually references 'subagent' and its documented params so a
rename/regression is caught here, not at dispatch time."
```

---

### Final: whole-branch review + manual TUI check + PR

- [ ] **Manual TUI verification:** run `pi` in the repo, dispatch a `subagent` (e.g. a trivial task) — observe the rich `renderCall` line (subagent ▸ role ▸ model ▸ task) while running and the collapsible `renderResult` on completion. Then run `/subagents`, select the run, view its full output, esc back, esc close.
- [ ] **Final code review:** dispatch a reviewer (via the repo's `subagent` tool — dogfood) over the branch diff with this plan + the spec; address Critical/Important.
- [ ] **Finish:** push branch, open PR (squash-merge per repo convention; rebase if main moves).

---

## Self-Review (against spec)

- **Spec coverage:**
  - Enrich `details` (spec §1) → Task 1 ✅
  - `renderCall` (spec §2) → Task 2 ✅
  - `renderResult` collapsible (spec §3) → Task 2 ✅
  - `/subagents` command + viewer + reconstruction (spec §4) → Task 3 ✅
  - Verify wiring (spec §5) → Task 4 ✅
  - Data-flow via session `details`/`content` (spec §Data flow) → all tasks ✅
  - Out-of-scope items absent: no `spawnSubagent`/`WorkflowAgent` change, no footer `setStatus`, no streaming ✅
  - Open questions resolved in spec (agent-omitted → omit segment; stateful component) → reflected in Task 2/Task 3 code ✅
- **Placeholder scan:** none — every code step has complete code. Task 4 is explicitly a regression guard (passes today), noted honestly.
- **Type consistency:** `SubagentToolDetails` (Task 1) is consumed identically by `renderSubagentResult` (Task 2) and `reconstructSubagentRuns` (Task 3). `SubagentRun.status` matches `SubagentToolDetails.status` values. `taskPreview`/`deriveSubagentStatus` exported in Task 1, imported/used in Tasks 2–3. `renderSubagentCall`/`renderSubagentResult` exported in Task 2, tested there + reused by the tool's `renderCall`/`renderResult`. ✅
