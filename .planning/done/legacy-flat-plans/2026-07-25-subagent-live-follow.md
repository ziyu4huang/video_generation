# Subagent Live-Follow View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `follow` view-mode to the `/subagents` viewer that attaches to a running subagent and streams its tool-call trace live, freezing in place with final status/usage on completion.

**Architecture:** Extend the existing stateful `SubagentViewer` (`pi-agent-ext-workflow/src/subagent-viewer.ts`) from two view-modes (`list`/`output`) to three (`list`/`output`/`follow`). The list becomes a unified selectable list spanning Running + Completed rows; `enter` on a Running row enters `follow`, which reads the shared `SubagentInFlightRegistry` live each render (driven by the existing 1 s invalidate timer). When the followed run leaves the registry, follow resolves the final status from a live re-scan of the session branch (`getRuns`), then freezes.

**Tech Stack:** TypeScript, Bun, `@earendil-works/pi-tui` (`truncateToWidth`, `Key`, `matchesKey`), `@earendil-works/pi-coding-agent` (`Theme`), `bun:test`. Two workspace packages: `@repo/pi-agent-ext-subagent` (one export added) and `@repo/pi-agent-ext-workflow` (the viewer + command).

**Spec:** `docs/superpowers/specs/2026-07-25-subagent-live-follow-design.md`

## Global Constraints

- **Shell discipline:** never top-level `cd` — use `( cd <dir> && ... )`. Tests run as `( cd bun-apps/<pkg> && bun test )`.
- **Conversation language** zh-TW; **all written artifacts English** (code, comments, commits).
- **Apple Silicon / Bun workspace** — `bun-apps/` is the workspace root; `@repo/*` resolves workspace source.
- **No schema-cost change** — no new tool, no tool-schema edit. No new extension registration (viewer + command already mounted in `extensions/workflow.ts`).
- **Do not touch** the `subagent` tool's model-resolution logic, `model-tiers.json`, `/workflows-models`, or the tool's `finally`→`inFlight.end()` teardown.
- Reuse existing primitives: `renderActivityRow` / `shortModel` (`pi-agent-ext-workflow/src/display.ts`), `summarizeLatestAction` / `formatHistoryLine` (`@repo/pi-agent-ext-subagent`).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` | tool impl + trace formatters | **export** `formatHistoryLine` (was private) |
| `bun-apps/pi-agent-ext-subagent/src/index.ts` | package public API | re-export `formatHistoryLine` |
| `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts` | `/subagents` viewer (list/output) | **+`follow` view-mode**, unified selectable list, `toolCallId` on `SubagentRun`/`reconstructSubagentRuns`, `getRuns` option |
| `bun-apps/pi-agent-ext-workflow/src/subagents-command.ts` | `/subagents` command wiring | pass live `getRuns` to the viewer |
| `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts` | viewer unit tests | +follow/list/toolCallId tests |
| `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts` | trace formatter tests | +`formatHistoryLine` export test |

Task DAG: **1 → 3 → 4**; **2 → 4**. (1 before 3 because follow's trace body uses `formatHistoryLine`; 2 before 4 because completed-run matching uses `toolCallId`.)

---

## Task 1: Export `formatHistoryLine` from pi-agent-ext-subagent

**Files:**
- Modify: `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts` (the `formatHistoryLine` declaration)
- Modify: `bun-apps/pi-agent-ext-subagent/src/index.ts` (re-export)
- Test: `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts`

**Interfaces:**
- Produces: `export function formatHistoryLine(e: AgentHistoryEntry): string` — renders one history entry as `→ tool <args>` / `← tool ✓ <preview>` / `⚠ error` / first text line. Importable from `@repo/pi-agent-ext-subagent` (root) by downstream packages.

- [ ] **Step 1: Write the failing test**

Append to `bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts`:

```ts
import { formatHistoryLine } from "../src/subagent-tool.js";

// ── formatHistoryLine (exported for the /subagents live-follow view) ──
test("formatHistoryLine renders a toolCall as '→ name <args>'", () => {
  const out = formatHistoryLine({ role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"a.ts"}' });
  assert.match(out, /^→ read /);
  assert.ok(out.includes("a.ts"), "surfaces a short args preview");
});

test("formatHistoryLine renders a toolResult as '← name ✓ <preview>'", () => {
  const out = formatHistoryLine({ role: "tool", kind: "toolResult", toolName: "read", text: "file contents here" });
  assert.match(out, /^← read ✓/);
  assert.ok(out.includes("file contents"), "surfaces a short result preview");
});

test("formatHistoryLine renders an error as '⚠ …'", () => {
  const out = formatHistoryLine({ role: "assistant", kind: "error", text: "boom", isError: true });
  assert.match(out, /^⚠ boom/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts )`
Expected: FAIL — `formatHistoryLine is not exported` (it is currently a private `function`).

- [ ] **Step 3: Export the function**

In `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`, change the declaration (search for `function formatHistoryLine(e: AgentHistoryEntry): string {`):

```ts
/** Render one history entry as a single readable trace line (live-output buffer). */
export function formatHistoryLine(e: AgentHistoryEntry): string {
```

(Only add the `export` keyword — the body is unchanged.)

- [ ] **Step 4: Re-export from the package root**

In `bun-apps/pi-agent-ext-subagent/src/index.ts`, find the subagent-tool export block:

```ts
// subagent-tool
export type { SubagentToolDetails, SubagentToolOptions } from "./subagent-tool.js";
export { createSubagentTool } from "./subagent-tool.js";
```

Change the value-export line to include `formatHistoryLine`:

```ts
export { createSubagentTool, formatHistoryLine } from "./subagent-tool.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-tool.test.ts )`
Expected: PASS (3 new tests green; existing tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts bun-apps/pi-agent-ext-subagent/src/index.ts bun-apps/pi-agent-ext-subagent/tests/subagent-tool.test.ts
git commit -m "feat(subagent): export formatHistoryLine for the /subagents live-follow view"
```

---

## Task 2: Carry `toolCallId` on `SubagentRun`

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts` (`SubagentRun` interface, `BranchMessage` interface, `reconstructSubagentRuns`)
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts`

**Interfaces:**
- Consumes: pi's branch toolResult message carries `message.toolCallId` (verified: `dist/core/export-html/template.js:1466`, `export-html/index.js:141`) — the same id `InFlightSubagent.id` is set to.
- Produces: `SubagentRun.toolCallId?: string`, populated by `reconstructSubagentRuns`. Consumed by Task 4's completed-run matching.

- [ ] **Step 1: Write the failing test**

In `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts`, extend the `toolResultEntry` helper to optionally carry `toolCallId`, and add a test. First, update the helper (it currently builds `{ type:"message", message:{ role, toolName, content, details } }`):

```ts
function toolResultEntry(toolName: string, text: string, details?: Partial<SubagentToolDetails>, toolCallId?: string) {
  const message: Record<string, unknown> = { role: "toolResult", toolName, content: [{ type: "text", text }], details };
  if (toolCallId) message.toolCallId = toolCallId;
  return { type: "message", message };
}
```

Then add the test:

```ts
test("reconstructSubagentRuns carries toolCallId through from the branch message", () => {
  const branch = [
    toolResultEntry("subagent", "report A", { exitCode: 0, timedOut: false, status: "done" }, "call-xyz"),
  ];
  const runs = reconstructSubagentRuns(branch as never);
  assert.equal(runs[0].toolCallId, "call-xyz");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )`
Expected: FAIL — `runs[0].toolCallId` is `undefined` (interface lacks the field; `reconstructSubagentRuns` doesn't read it).

- [ ] **Step 3: Add the field + read it**

In `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts`:

(a) Add `toolCallId` to the `SubagentRun` interface (after `index`):

```ts
export interface SubagentRun {
  /** 1-based ordinal among subagent runs on this branch. */
  index: number;
  /** The tool-call id (matches InFlightSubagent.id); used by live-follow to match a completed run. */
  toolCallId?: string;
  agent?: string;
  model: string;
  taskPreview: string;
  status: "done" | "failed" | "timedout" | "budget";
  elapsedMs: number;
  usage?: AgentUsage;
  output: string;
}
```

(b) Add `toolCallId` to the `BranchMessage` interface:

```ts
interface BranchMessage {
  role?: string;
  toolName?: string;
  toolCallId?: string;
  content?: Array<{ type: string; text?: string }>;
  details?: Partial<SubagentToolDetails>;
}
```

(c) In `reconstructSubagentRuns`, read it into the run (add the `toolCallId` line to the pushed object):

```ts
    runs.push({
      index: i,
      toolCallId: msg.toolCallId,
      agent: d?.agent,
      model: d?.model ?? "default",
      taskPreview: d?.taskPreview ?? "",
      status,
      elapsedMs: d?.elapsedMs ?? 0,
      usage: d?.usage,
      output: msg.content?.find((c) => c.type === "text")?.text ?? "",
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )`
Expected: PASS (new test green; all existing viewer tests still green — `toolCallId` is optional).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts
git commit -m "feat(workflow): carry toolCallId on SubagentRun for live-follow matching"
```

---

## Task 3: Follow view (LIVE) + unified selectable list

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts` (`ViewerOpts`, `SubagentViewer` class: fields, `handleInput`, `render`, `renderList`, new `renderFollow`, new `enterFollow`/`clearFollow`/`entries` helpers, module constants + imports)
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts`

**Interfaces:**
- Consumes: `formatHistoryLine` (Task 1), `InFlightSubagent` (existing), `renderActivityRow`/`shortModel`/`ActivityRow` (existing in `./display.ts`).
- Produces: `SubagentViewer` gains a `follow` view-mode; list rows (Running + Completed) are a unified selectable list; `enter` on a Running row enters follow (LIVE). Task 4 adds the COMPLETED resolution on top.

**Scope note:** This task implements the LIVE tail only. When the followed run leaves the registry (completion), Task 3 shows the last snapshot + a neutral `ended` banner (no final status/usage) — Task 4 upgrades that to the real freeze with status/usage via `getRuns`. This is a valid, testable intermediate.

- [ ] **Step 1: Write the failing tests**

Append to `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts`:

```ts
// ── unified selectable list + live-follow (LIVE) ──

function runningEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    agent: "implementer",
    model: "x/flash",
    taskPreview: "doing " + id,
    startedAt: Date.now() - 1500,
    history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"a.ts"}' }],
    ...overrides,
  };
}

test("list cursor spans Running + Completed rows (unified); ▶ marks the selected row", () => {
  const running = [runningEntry("r1")];
  const runs = reconstructSubagentRuns([
    toolResultEntry("subagent", "old report", { exitCode: 0, timedOut: false, status: "done", agent: "reviewer", model: "y/pro", taskPreview: "old", elapsedMs: 1000 }),
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
  viewer.handleInput("\r");   // enter follow
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
  viewer.handleInput("\r");          // enter follow (LIVE)
  viewer.render(80);
  running = [];                      // run completed / left the registry
  viewer.invalidate();
  // exceed the finalize grace so it lands on 'ended'
  for (let i = 0; i < 7; i++) { viewer.invalidate(); viewer.render(80); }
  const out = viewer.render(80).join("\n");
  assert.ok(out.includes("ended"), "lands on the neutral ended banner");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )`
Expected: FAIL — `enter` on a running row does nothing (Running rows aren't selectable); no `follow` view exists.

- [ ] **Step 3: Update imports + add module constants**

At the top of `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts`, replace the two `@repo/pi-agent-ext-subagent` import lines and the `./display.js` import so the file reads:

```ts
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentUsage } from "@repo/pi-agent-ext-subagent";
import { summarizeLatestAction, formatHistoryLine } from "@repo/pi-agent-ext-subagent";
import { type ActivityRow, renderActivityRow, shortModel } from "./display.js";
import type { AgentHistoryEntry, InFlightSubagent } from "@repo/pi-agent-ext-subagent";
import type { SubagentToolDetails } from "@repo/pi-agent-ext-subagent";
```

Add module constants just below the imports (after `interface BranchEntry`/before `reconstructSubagentRuns`, or directly under the imports — anywhere at module scope):

```ts
/** Tail-f window: how many recent trace lines the follow view shows. */
const FOLLOW_TRACE_LINES = 40;
/** Ticks the follow view waits for a completed run to appear in the branch before the `ended` fallback. */
const FOLLOW_FINALIZE_GRACE_TICKS = 5;
```

- [ ] **Step 4: Add follow state to the viewer**

Replace the `ViewerOpts` interface and the `SubagentViewer` field/constructor block. New `ViewerOpts` adds `getRuns?` (used by Task 4; harmless to add now):

```ts
interface ViewerOpts {
  runs: SubagentRun[];
  /** Live in-flight runs (read each render so elapsed stays fresh). */
  getRunning?: () => InFlightSubagent[];
  /** Live re-scan of the branch, used to resolve a followed run's completion (Task 4). */
  getRuns?: () => SubagentRun[];
  onClose: () => void;
}
```

Replace the class field declarations + constructor:

```ts
/** Stateful list↔output↔follow viewer. `view` flips on enter/esc; no second UI mount. */
export class SubagentViewer {
  private runs: SubagentRun[];
  private getRunning?: () => InFlightSubagent[];
  private getRuns?: () => SubagentRun[];
  private view: "list" | "output" | "follow" = "list";
  private selected = 0; // unified cursor over entries() (running first, then completed)
  private outputRun?: SubagentRun; // the completed run open in `output` (decoupled from the list cursor)
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private theme: Theme;
  // follow state
  private followedId?: string;
  private followedSnapshot?: {
    history: AgentHistoryEntry[];
    model: string;
    agent?: string;
    taskPreview: string;
    startedAt: number;
  };
  private followedFinal?: SubagentRun; // set by Task 4 on completion
  private followEnded = false;
  private finalizingTicks = 0;

  constructor(opts: ViewerOpts, theme: Theme) {
    this.runs = opts.runs;
    this.getRunning = opts.getRunning;
    this.getRuns = opts.getRuns;
    this.onClose = opts.onClose;
    this.theme = theme;
  }
```

- [ ] **Step 5: Add the `entries()` helper + follow transitions**

Add these methods to the class (e.g. right after the constructor):

```ts
  /** Flat selectable list: running entries first, then completed, with a divider rendered between. */
  private entries(): Array<{ kind: "running"; ref: InFlightSubagent } | { kind: "completed"; ref: SubagentRun }> {
    const running = this.getRunning?.() ?? [];
    return [
      ...running.map((ref) => ({ kind: "running" as const, ref })),
      ...this.runs.map((ref) => ({ kind: "completed" as const, ref })),
    ];
  }

  private enterFollow(id: string): void {
    this.followedId = id;
    this.followedSnapshot = undefined;
    this.followedFinal = undefined;
    this.followEnded = false;
    this.finalizingTicks = 0;
    this.view = "follow";
    this.invalidate();
  }

  private clearFollow(): void {
    this.followedId = undefined;
    this.followedSnapshot = undefined;
    this.followedFinal = undefined;
    this.followEnded = false;
    this.finalizingTicks = 0;
  }
```

- [ ] **Step 6: Rewrite `handleInput` for the unified cursor + follow**

Replace the entire existing `handleInput` method with:

```ts
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.view === "list") {
        this.onClose();
      } else {
        // output or follow → back to list
        this.view = "list";
        this.clearFollow();
        this.invalidate();
      }
      return;
    }
    if (this.view !== "list") return; // follow/output: no nav keys in v1
    const entries = this.entries();
    if (this.selected > entries.length - 1) this.selected = Math.max(0, entries.length - 1);
    if (matchesKey(data, Key.up) && this.selected > 0) {
      this.selected -= 1;
      this.invalidate();
    } else if (matchesKey(data, Key.down) && this.selected < entries.length - 1) {
      this.selected += 1;
      this.invalidate();
    } else if (matchesKey(data, Key.enter) && entries.length > 0) {
      const e = entries[this.selected];
      if (!e) return;
      if (e.kind === "running") {
        this.enterFollow(e.ref.id);
      } else {
        this.outputRun = e.ref;
        this.view = "output";
        this.invalidate();
      }
    }
  }
```

- [ ] **Step 7: Route `render` to `renderFollow`; rewrite `renderList` (unified); rewrite `renderOutput` (decoupled)**

Replace the existing `render`, `renderList`, and `renderOutput` methods with:

```ts
  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const th = this.theme;
    if (this.view === "list") this.cachedLines = this.renderList(width, th);
    else if (this.view === "follow") this.cachedLines = this.renderFollow(width, th);
    else this.cachedLines = this.renderOutput(width, th);
    this.cachedWidth = width;
    return this.cachedLines;
  }

  private renderList(width: number, th: Theme): string[] {
    const lines: string[] = [""];
    const entries = this.entries();
    if (this.selected > entries.length - 1) this.selected = Math.max(0, entries.length - 1);

    const running = entries.filter((e) => e.kind === "running") as Array<{ kind: "running"; ref: InFlightSubagent }>;
    if (running.length > 0) {
      const runningTitle = th.fg("accent", th.bold(" Running "));
      lines.push(truncateToWidth(runningTitle + th.fg("borderMuted", "─".repeat(Math.max(0, width - 9))), width));
      for (const e of running) {
        const r = e.ref;
        const cur = entries.indexOf(e) === this.selected;
        const toolCalls = r.history?.filter((h) => h.kind === "toolCall").length ?? 0;
        const row: ActivityRow = {
          status: "running",
          actor: r.agent ?? "general-purpose",
          model: r.resolvedModel ?? r.model,
          elapsedMs: Date.now() - r.startedAt,
          toolCalls,
          latestAction: summarizeLatestAction(r.history) ?? truncateToWidth(r.taskPreview, 40),
        };
        const head = renderActivityRow(row, th);
        lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`}`, width));
      }
      lines.push("");
    }

    const title = th.fg("accent", th.bold(" Subagent runs "));
    lines.push(truncateToWidth(title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 15))), width));
    lines.push("");
    const completed = entries.filter((e) => e.kind === "completed") as Array<{ kind: "completed"; ref: SubagentRun }>;
    if (completed.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No subagent runs on this branch.")}`, width));
    } else {
      for (const e of completed) {
        const r = e.ref;
        const cur = entries.indexOf(e) === this.selected;
        const row: ActivityRow = {
          status: r.status,
          actor: r.agent ?? "general-purpose",
          badge: `#${r.index}`,
          detail: r.taskPreview,
        };
        const head = renderActivityRow(row, th, 50);
        lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", `▶ ${head}`) : `  ${head}`}`, width));
      }
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select • enter view/follow • esc close")}`, width));
    lines.push("");
    return lines;
  }

  private renderOutput(width: number, th: Theme): string[] {
    const r = this.outputRun;
    if (!r) return [""];
    const lines: string[] = [""];
    const usageStr = r.usage && r.usage.total > 0 ? ` • $${r.usage.cost.toFixed(3)} • ${r.usage.total} tok` : "";
    lines.push(
      truncateToWidth(
        `  ${th.fg("accent", `#${r.index}`)} ${th.fg("muted", r.agent ?? "general-purpose")} ▸ ${r.model} • ${r.status} • ${(r.elapsedMs / 1000).toFixed(1)}s${usageStr}`,
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
```

- [ ] **Step 8: Implement `renderFollow` (LIVE + Task-3 `ended` fallback)**

Add the `renderFollow` method and its glyph helper (module-scope helper, placed near the other module functions):

```ts
/** Header glyph+color for a follow-view status (covers the statuses follow can show). */
function followGlyph(status: string, th: Theme): string {
  switch (status) {
    case "running":
      return th.fg("warning", "●");
    case "done":
      return th.fg("success", "✓");
    case "failed":
      return th.fg("error", "✗");
    case "timedout":
      return th.fg("warning", "⏱");
    case "budget":
      return th.fg("warning", "⛔");
    case "ended":
      return th.fg("dim", "–");
    default:
      return th.fg("dim", "…"); // finalizing
  }
}
```

And the method on the class:

```ts
  private renderFollow(width: number, th: Theme): string[] {
    const lines: string[] = [""];
    const r = this.followedId ? this.getRunning?.().find((x) => x.id === this.followedId) : undefined;

    let status: string;
    let model: string;
    let elapsedMs: number;
    let usageStr = "";
    let agent: string | undefined;

    if (r) {
      // LIVE — refresh the snapshot from the registry entry each tick.
      this.followedSnapshot = {
        history: r.history ?? [],
        model: r.resolvedModel ?? r.model,
        agent: r.agent,
        taskPreview: r.taskPreview,
        startedAt: r.startedAt,
      };
      this.finalizingTicks = 0;
      status = "running";
      model = this.followedSnapshot.model;
      elapsedMs = Date.now() - r.startedAt;
      agent = r.agent;
    } else {
      // ABSENT — resolve completion. Task 4 fills the real freeze via getRuns;
      // until then (or past grace) show finalizing → ended.
      this.resolveCompletion();
      if (this.followedFinal) {
        const f = this.followedFinal;
        status = f.status;
        model = f.model;
        elapsedMs = f.elapsedMs;
        agent = f.agent;
        const u = f.usage;
        usageStr = u && u.total > 0 ? ` · $${u.cost.toFixed(u.cost >= 0.01 ? 2 : 4)} · ${u.total} tok` : "";
      } else {
        status = this.followEnded ? "ended" : "finalizing";
        model = this.followedSnapshot?.model ?? "default";
        elapsedMs = this.followedSnapshot ? Date.now() - this.followedSnapshot.startedAt : 0;
        agent = this.followedSnapshot?.agent;
      }
    }

    const agentLabel = agent ?? "general-purpose";
    const head = `${followGlyph(status, th)} ${th.fg("accent", agentLabel)} ▸ ${th.fg("muted", shortModel(model) ?? model)} • ${th.fg("muted", status)} • ${(elapsedMs / 1000).toFixed(1)}s${usageStr}`;
    lines.push(truncateToWidth(`  ${head}`, width));
    lines.push(truncateToWidth(th.fg("borderMuted", "─".repeat(Math.max(0, width))), width));

    const trace = (this.followedSnapshot?.history ?? []).slice(-FOLLOW_TRACE_LINES).map(formatHistoryLine);
    if (trace.length === 0) trace.push("…");
    for (const ln of trace) {
      lines.push(truncateToWidth(`  ${th.fg("toolOutput", ln)}`, width));
    }
    lines.push("");
    const hint = status === "finalizing" ? "finalizing… " : "";
    lines.push(truncateToWidth(`  ${hint}${th.fg("dim", "esc back to list")}`, width));
    lines.push("");
    return lines;
  }

  /**
   * Resolve a followed run's completion once it leaves the registry.
   * Task 3 stub: counts finalize ticks → `followEnded`. Task 4 upgrades this to
   * a real branch re-scan via `getRuns`.
   */
  private resolveCompletion(): void {
    if (this.followedFinal || this.followEnded) return;
    this.finalizingTicks += 1;
    if (this.finalizingTicks > FOLLOW_FINALIZE_GRACE_TICKS) this.followEnded = true;
  }
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )`
Expected: PASS — all 6 new tests green AND all pre-existing viewer tests green (the unified cursor is backward-compatible: with no running rows `entries()` reduces to the completed list, so the existing "down→enter opens #2" test still selects `runs[1]`).

- [ ] **Step 10: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts
git commit -m "feat(workflow): /subagents live-follow view (LIVE tail) + unified selectable list"
```

---

## Task 4: Follow COMPLETED resolution + `getRuns` command wiring

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts` (`resolveCompletion` — upgrade from stub to real branch re-scan)
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagents-command.ts` (pass `getRuns`)
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts` (follow completion tests)

**Interfaces:**
- Consumes: `SubagentRun.toolCallId` (Task 2); `ViewerOpts.getRuns` (added in Task 3); the live branch from `createSubagentsCommand`.
- Produces: follow freezes with the real final status/usage when the followed run completes; the command supplies a live `getRuns`.

- [ ] **Step 1: Write the failing tests**

First, extend the test file's existing import to bring in the `SubagentRun` type (used by the `completedRun` helper below). Change:

```ts
import { reconstructSubagentRuns, SubagentViewer } from "../src/subagent-viewer.js";
```

to:

```ts
import { reconstructSubagentRuns, SubagentViewer, type SubagentRun } from "../src/subagent-viewer.js";
```

Append to `bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts`:

```ts
// ── follow COMPLETED resolution (freeze with final status/usage) ──

function completedRun(toolCallId: string, overrides: Record<string, unknown> = {}): SubagentRun {
  return {
    index: 1,
    toolCallId,
    agent: "implementer",
    model: "x/flash",
    taskPreview: "did " + toolCallId,
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )`
Expected: FAIL — the first test never freezes with `✓ done`/usage (the Task-3 `resolveCompletion` stub only sets `followEnded`, never `followedFinal`).

- [ ] **Step 3: Upgrade `resolveCompletion` to a real branch re-scan**

In `bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts`, replace the Task-3 stub `resolveCompletion` with:

```ts
  /**
   * Resolve a followed run's completion once it leaves the registry: re-scan the
   * branch (live `getRuns`) and match by `toolCallId`. Within the grace window
   * the view shows `finalizing…`; past grace it falls back to a neutral `ended`
   * banner. Best-effort: a throwing `getRuns` is swallowed so the view never
   * crashes. Idempotent once `followedFinal`/`followEnded` is set.
   */
  private resolveCompletion(): void {
    if (this.followedFinal || this.followEnded) return;
    try {
      const final = this.getRuns?.().find((x) => x.toolCallId === this.followedId);
      if (final) {
        this.followedFinal = final;
        return;
      }
    } catch {
      // best-effort — fall through to the finalize/ended path
    }
    this.finalizingTicks += 1;
    if (this.finalizingTicks > FOLLOW_FINALIZE_GRACE_TICKS) this.followEnded = true;
  }
```

- [ ] **Step 4: Run viewer tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )`
Expected: PASS — all 3 new completion tests green; Task-3 tests still green.

- [ ] **Step 5: Wire `getRuns` in the command**

In `bun-apps/pi-agent-ext-workflow/src/subagents-command.ts`, find the viewer construction inside `createSubagentsCommand`'s handler:

```ts
        const viewer = new SubagentViewer(
          {
            runs,
            getRunning: () => subagentInFlight.list(),
            onClose: () => {
```

Add a `getRuns` that re-scans the branch live (the list still uses the open-time `runs` snapshot):

```ts
        const viewer = new SubagentViewer(
          {
            runs,
            getRunning: () => subagentInFlight.list(),
            getRuns: () => reconstructSubagentRuns(branch),
            onClose: () => {
```

(`branch` is already captured earlier in the handler as `const branch = (c.sessionManager?.getBranch() ?? []) as never;` — re-scanning it each call reflects runs that complete after the viewer opened.)

- [ ] **Step 6: Run the full workflow-ext test suite + build**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test )`
Expected: PASS — entire suite green (viewer, command, regression-rca, agent, etc.).

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build )`
Expected: builds cleanly (typecheck passes — `formatHistoryLine` import resolves, `getRuns` wired).

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts bun-apps/pi-agent-ext-workflow/src/subagents-command.ts bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts
git commit -m "feat(workflow): /subagents follow freezes with final status via live getRuns re-scan"
```

---

## Self-Review (run after writing, before handoff)

**Spec coverage** — every spec component maps to a task:
- ① `SubagentViewer` follow view-mode + unified list + fields + `renderFollow` + `enterFollow`/`clearFollow`/`entries` → Task 3 (LIVE) + Task 4 (COMPLETED).
- ② `SubagentRun.toolCallId` + `reconstructSubagentRuns` reads `msg.toolCallId` → Task 2 (spec refined: field is `toolCallId` on the message, verified against pi 0.82.0; **no `SubagentToolDetails` change needed**).
- ③ export `formatHistoryLine` → Task 1.
- ④ `createSubagentsCommand` passes `getRuns` → Task 4 Step 5.
- Edge cases (timing window → `finalizing`/`ended`, `getRuns` throws → swallowed, no-running → can't enter follow, esc mid-run → back to list) → Task 3 + Task 4 tests.
- Constants `FOLLOW_TRACE_LINES` / `FOLLOW_FINALIZE_GRACE_TICKS` → Task 3 Step 3.
- `enterFollow` resets `followEnded` → Task 3 Step 5 (matches spec self-review fix).

**Placeholder scan** — none; every code step shows full code.

**Type consistency** — `entries()` returns `{kind,ref}` union consumed identically in `handleInput` and `renderList`; `followedSnapshot` shape is identical in Task 3 (write) and Task 4 (read); `resolveCompletion` signature is identical in Task 3 stub and Task 4 upgrade; `ViewerOpts.getRuns` added in Task 3 is consumed in Task 4; `SubagentRun.toolCallId` (Task 2) is read in Task 4's `resolveCompletion`. ✓

**Note (cadence)** — follow updates at the existing 1 s invalidate-timer cadence (the command's `setInterval` already calls `viewer.invalidate()` + `tui.requestRender()`). Tests simulate ticks with explicit `viewer.invalidate()` calls between renders because `render()` caches by width. This matches production behavior, not a test artifact.
