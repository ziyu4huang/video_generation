# Workflow Live Agent Activity (ActivityRow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a running `workflow()` agent's current tool call visible live in the bottom task panel, the `/workflows` navigator (list + auto-scrolling detail tail), and the `/subagents` viewer — via one shared `ActivityRow` rendering primitive instead of three hand-built string templates.

**Architecture:** Extend `src/display.ts` with a generic `ActivityRow` type + `renderActivityRow()` pure formatter (no domain-type adapters live there, to avoid circular imports). Extend `src/agent-history.ts` with `summarizeLatestAction()`. Fix the missing `"agentHistory"` event subscription in `task-panel.ts` and `workflow-ui.ts`. Each of the three consumer files (`task-panel.ts`, `subagent-viewer.ts`, `workflow-ui.ts`) gets a small local adapter that maps its own domain type to `ActivityRow` and calls the shared renderer. `workflow-ui.ts`'s `NavigatorState` also gains a `followLive` auto-scroll flag for the agent-detail live tail.

**Tech Stack:** TypeScript, `bun:test` + `node:assert/strict`, Biome (format/lint), `tsc` (build). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-20-workflow-live-agent-activity-design.md`

**Git strategy:** This plan assumes execution starts from a **fresh branch off `origin/main`** — NOT the current `fix/pi-workflow-review-f1-f4` branch, which is stale (even with `main`; its own F1–F4 work already merged as #709). Cherry-pick commit `ae3d82f4` (the spec doc) onto the new branch first, or just re-add the spec file — either is fine.

---

### Task 1: Consolidate `shortModel` and `fmtTokensShort` into `display.ts`

Pure relocation, no behavior change. Both are currently duplicated/scattered (`shortModel` lives in `workflow-ui.ts`, `fmtTokensShort` lives in `task-panel.ts`) even though both files already share `display.ts`. This gives `renderActivityRow` (Task 3) one place to call them from without new circular imports.

**Files:**
- Modify: `src/display.ts`
- Modify: `src/workflow-ui.ts:80-84` (remove local `shortModel`, import from `display.js`)
- Modify: `src/task-panel.ts:16` and `~290-295` (remove local `fmtTokensShort`, import from `display.js`)

- [ ] **Step 1: Add `shortModel` and `fmtTokensShort` to `display.ts`**

Open `src/display.ts`. Find the `statusIcon` function (currently near the end of the file, right before `function unique`). Insert these two new exported functions immediately above `export function statusIcon`:

```ts
/** Short, human-friendly model label: drop the provider prefix for display. */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

/** Compact token count for space-constrained rows: 980, 12.4K, 1.3M. */
export function fmtTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
```

- [ ] **Step 2: Update `workflow-ui.ts` to import `shortModel` instead of defining it**

In `src/workflow-ui.ts`, delete the local definition (lines 79-84):

```ts
/** Short, human-friendly model label: drop the provider prefix for display. */
export function shortModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}
```

Change the existing import at the top of the file:

```ts
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "./display.js";
```

to:

```ts
import { shortModel, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
```

`shortModel` is still used at lines ~402 and ~412 in this file — no other change needed there, the import now resolves to the relocated function.

- [ ] **Step 3: Update `task-panel.ts` to import `shortModel` and `fmtTokensShort` from `display.js`**

In `src/task-panel.ts`, delete the local `fmtTokensShort` function definition (currently ~lines 289-295):

```ts
/** Compact token count for the space-constrained panel: 980, 12.4K, 1.3M. */
function fmtTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
```

Change the two import lines near the top of the file from:

```ts
import { shorten, statusIcon, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
```

and

```ts
import { shortModel } from "./workflow-ui.js";
```

to:

```ts
import {
  fmtTokensShort,
  shortModel,
  shorten,
  statusIcon,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
```

(drop the `./workflow-ui.js` import entirely — `shortModel` now comes from `display.js`).

- [ ] **Step 4: Run the full test suite to confirm zero behavior change**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )`
Expected: build succeeds, all tests pass exactly as before this task (this is a pure relocation — any failure here means an import path was missed).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/display.ts bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts bun-apps/pi-agent-ext-workflow/src/task-panel.ts
git commit -m "refactor(pi-agent-ext-workflow): consolidate shortModel/fmtTokensShort into display.ts"
```

---

### Task 2: `summarizeLatestAction` in `agent-history.ts`

**Files:**
- Modify: `src/agent-history.ts`
- Test: `tests/agent-history.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/agent-history.test.ts` (after the existing `import` lines, add `summarizeLatestAction` to the import; then append these `test(...)` blocks at the end of the file):

Change the import line:

```ts
import { compactAgentHistory } from "../src/agent-history.js";
```

to:

```ts
import { compactAgentHistory, summarizeLatestAction } from "../src/agent-history.js";
```

Append at the end of the file:

```ts
test("summarizeLatestAction returns undefined for empty or missing history", () => {
  assert.equal(summarizeLatestAction(undefined), undefined);
  assert.equal(summarizeLatestAction([]), undefined);
});

test("summarizeLatestAction summarizes a toolCall entry", () => {
  const action = summarizeLatestAction([
    { role: "assistant", kind: "toolCall", toolName: "grep", text: '{"pattern":"foo"}' },
  ]);
  assert.equal(action, "▸ grep");
});

test("summarizeLatestAction summarizes a successful toolResult entry", () => {
  const action = summarizeLatestAction([
    { role: "tool", kind: "toolResult", toolName: "grep", text: "3 matches", isError: false },
  ]);
  assert.equal(action, "grep done");
});

test("summarizeLatestAction summarizes a failed toolResult entry", () => {
  const action = summarizeLatestAction([
    { role: "tool", kind: "toolResult", toolName: "bash", text: "exit 1", isError: true },
  ]);
  assert.equal(action, "✗ bash");
});

test("summarizeLatestAction summarizes an error entry", () => {
  const action = summarizeLatestAction([{ role: "assistant", kind: "error", text: "model failed" }]);
  assert.equal(action, "✗ error");
});

test("summarizeLatestAction summarizes a plain text entry as thinking", () => {
  const action = summarizeLatestAction([{ role: "assistant", kind: "text", text: "I will look at this next." }]);
  assert.equal(action, "…thinking");
});

test("summarizeLatestAction only looks at the LAST entry", () => {
  const action = summarizeLatestAction([
    { role: "assistant", kind: "toolCall", toolName: "read", text: "{}" },
    { role: "tool", kind: "toolResult", toolName: "read", text: "content", isError: false },
  ]);
  assert.equal(action, "read done");
});

test("summarizeLatestAction falls back to a generic 'tool' label when toolName is missing", () => {
  const action = summarizeLatestAction([{ role: "assistant", kind: "toolCall", text: "{}" }]);
  assert.equal(action, "▸ tool");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/agent-history.test.ts )`
Expected: FAIL — `summarizeLatestAction is not a function` (or a TypeScript import error), since it does not exist yet.

- [ ] **Step 3: Implement `summarizeLatestAction`**

In `src/agent-history.ts`, append this function at the end of the file (after `asRecord`):

```ts
/**
 * A terse "what is it doing right now" label from an agent's compact history —
 * derived from only the LAST entry. Full content stays available via the
 * existing History block; this is a status-line snippet, not content.
 */
export function summarizeLatestAction(history?: AgentHistoryEntry[]): string | undefined {
  const last = history?.[history.length - 1];
  if (!last) return undefined;
  if (last.kind === "toolCall") return `▸ ${last.toolName ?? "tool"}`;
  if (last.kind === "toolResult") {
    return last.isError ? `✗ ${last.toolName ?? "tool"}` : `${last.toolName ?? "tool"} done`;
  }
  if (last.kind === "error") return "✗ error";
  return "…thinking";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/agent-history.test.ts )`
Expected: PASS — all tests in the file, including the 8 new ones.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/agent-history.ts bun-apps/pi-agent-ext-workflow/tests/agent-history.test.ts
git commit -m "feat(pi-agent-ext-workflow): add summarizeLatestAction for live agent status lines"
```

---

### Task 3: `ActivityRow` + `activityGlyph` + `renderActivityRow` in `display.ts`

**Files:**
- Modify: `src/display.ts`
- Test: `tests/workflow-display.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/workflow-display.test.ts` already loads `../src/display.js` via a shared `async function loadDisplay() { return import("../src/display.js"); }` helper (defined at line 49) and destructures what each test needs from it — e.g. `const { preview } = await loadDisplay();`. Follow that exact convention (no static top-level import needed). Append these tests near the "Pure helpers: preview, shorten, statusIcon, statusLine" section (around line 472, after the existing `preview` tests):

```ts
describe("activityGlyph", () => {
  it("returns the expected icon for every agent-level status", async () => {
    const { activityGlyph } = await loadDisplay();
    assert.equal(activityGlyph("queued").icon, "○");
    assert.equal(activityGlyph("running").icon, "●");
    assert.equal(activityGlyph("done").icon, "✓");
    assert.equal(activityGlyph("error").icon, "✗");
    assert.equal(activityGlyph("failed").icon, "✗");
    assert.equal(activityGlyph("skipped").icon, "-");
    assert.equal(activityGlyph("timedout").icon, "⏱");
  });
});

describe("renderActivityRow", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

  it("renders icon, actor, model, and tokens", async () => {
    const { renderActivityRow } = await loadDisplay();
    const line = renderActivityRow(
      { status: "done", actor: "audit_routes", model: "anthropic/claude-haiku-4-5", tokens: 2100 },
      theme,
    );
    assert.ok(line.includes("✓ audit_routes"), `expected icon+actor, got: ${line}`);
    assert.ok(line.includes("claude-haiku-4-5"), `expected shortened model, got: ${line}`);
    assert.ok(line.includes("2.1K tok"), `expected short token count, got: ${line}`);
  });

  it("shows the badge before the icon when present", async () => {
    const { renderActivityRow } = await loadDisplay();
    const line = renderActivityRow({ status: "running", actor: "audit_auth", badge: "[2]" }, theme);
    assert.ok(line.startsWith("[2] ● audit_auth"), `expected badge prefix, got: ${line}`);
  });

  it("shows latestAction when present, taking priority over detail", async () => {
    const { renderActivityRow } = await loadDisplay();
    const line = renderActivityRow(
      { status: "running", actor: "worker", latestAction: "▸ grep", detail: "static task text" },
      theme,
    );
    assert.ok(line.includes("▸ grep"), `expected latestAction, got: ${line}`);
    assert.ok(!line.includes("static task text"), "detail should be suppressed when latestAction is present");
  });

  it("falls back to detail (truncated) when latestAction is absent", async () => {
    const { renderActivityRow } = await loadDisplay();
    const line = renderActivityRow({ status: "done", actor: "worker", detail: "a finished task" }, theme);
    assert.ok(line.includes("a finished task"), `expected detail text, got: ${line}`);
  });

  it("omits every optional segment cleanly when absent", async () => {
    const { renderActivityRow } = await loadDisplay();
    const line = renderActivityRow({ status: "queued", actor: "worker" }, theme);
    assert.equal(line.trim(), "○ worker");
  });

  it("shows elapsed time and tool-call count when present", async () => {
    const { renderActivityRow } = await loadDisplay();
    const line = renderActivityRow({ status: "running", actor: "worker", elapsedMs: 1500, toolCalls: 1 }, theme);
    assert.match(line, /1\.5s/);
    assert.match(line, /1 call\b/);
  });

  it("pluralizes tool-call count", async () => {
    const { renderActivityRow } = await loadDisplay();
    const line = renderActivityRow({ status: "running", actor: "worker", toolCalls: 3 }, theme);
    assert.match(line, /3 calls/);
  });
});

describe("statusIcon (unchanged for existing agent statuses)", () => {
  it("matches the pre-refactor icons for queued/running/done/error/skipped", async () => {
    const { statusIcon } = await loadDisplay();
    assert.equal(statusIcon("queued"), "○");
    assert.equal(statusIcon("running"), "●");
    assert.equal(statusIcon("done"), "✓");
    assert.equal(statusIcon("error"), "✗");
    assert.equal(statusIcon("skipped"), "-");
  });
});
```

If the existing `describe("renderWorkflowLines edge cases", ...)` block or the file's helper import pattern differs from what's assumed above, match whatever pattern the top of `tests/workflow-display.test.ts` already uses for importing from `../src/display.js` (read the file's first ~30 lines before writing this step) rather than introducing a second import style in the same file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-display.test.ts )`
Expected: FAIL — `activityGlyph`/`renderActivityRow is not a function` (neither exists yet); the `statusIcon` describe block passes already (no change needed there yet).

- [ ] **Step 3: Implement `ActivityRow`, `activityGlyph`, `renderActivityRow`; make `statusIcon` delegate to `activityGlyph`**

In `src/display.ts`, replace the existing `statusIcon` function:

```ts
export function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}
```

with this block (which now defines `activityGlyph` as the canonical mapping and makes `statusIcon` a thin wrapper, plus adds `ActivityRow`/`renderActivityRow` immediately after it):

```ts
export interface ActivityRow {
  /** Covers the union of statuses across workflow agents, subagent runs, and in-flight subagents. */
  status: WorkflowAgentStatus | "failed" | "timedout";
  actor: string;
  model?: string;
  elapsedMs?: number;
  tokens?: number;
  cost?: number;
  toolCalls?: number;
  /** One-line "what is it doing right now" — present only while running and history exists. */
  latestAction?: string;
  /** Static description shown when latestAction is absent (e.g. a finished run's taskPreview). */
  detail?: string;
  badge?: string;
}

/** Canonical icon+color for an agent-level status. Single source of truth for all agent rows. */
export function activityGlyph(status: ActivityRow["status"]): { icon: string; color: string } {
  switch (status) {
    case "queued":
      return { icon: "○", color: "dim" };
    case "running":
      return { icon: "●", color: "warning" };
    case "done":
      return { icon: "✓", color: "success" };
    case "error":
    case "failed":
      return { icon: "✗", color: "error" };
    case "skipped":
      return { icon: "-", color: "dim" };
    case "timedout":
      return { icon: "⏱", color: "warning" };
  }
}

export function statusIcon(status: WorkflowAgentStatus): string {
  return activityGlyph(status).icon;
}

function fmtElapsed(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Shared one-line renderer for an agent/subagent's live status — used by the
 * bottom task panel, the /workflows navigator's agent list and detail
 * live-tail, and the /subagents viewer, so all three surfaces speak one
 * visual language. `latestAction` (dynamic) always wins over `detail` (static).
 */
export function renderActivityRow(row: ActivityRow, theme: ThemeLike, maxDetailWidth = 50): string {
  const { icon, color } = activityGlyph(row.status);
  const dim = (t: string) => theme.fg("dim", t);
  const badge = row.badge ? `${theme.fg("accent", row.badge)} ` : "";
  const head = `${badge}${theme.fg(color, icon)} ${theme.fg("muted", row.actor)}`;
  const meta = [
    row.model ? shortModel(row.model) : undefined,
    row.tokens ? `${fmtTokensShort(row.tokens)} tok` : undefined,
    typeof row.cost === "number" && row.cost > 0 ? `$${row.cost.toFixed(row.cost >= 0.01 ? 2 : 4)}` : undefined,
    typeof row.elapsedMs === "number" ? fmtElapsed(row.elapsedMs) : undefined,
    typeof row.toolCalls === "number" ? `${row.toolCalls} call${row.toolCalls === 1 ? "" : "s"}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const metaStr = meta ? dim(` ${meta}`) : "";
  const tail = row.latestAction ?? (row.detail ? shorten(row.detail, maxDetailWidth) : undefined);
  const tailStr = tail ? dim(` — ${tail}`) : "";
  return `${head}${metaStr}${tailStr}`;
}
```

Note: `shortModel`, `fmtTokensShort`, and `shorten` are all already in this file (the first two from Task 1; `shorten` already existed) — no new imports needed inside `display.ts` itself. `ThemeLike` is already defined earlier in this file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-display.test.ts )`
Expected: PASS — all tests including the new `activityGlyph`/`renderActivityRow`/`statusIcon` blocks.

- [ ] **Step 5: Run the full suite to confirm no regression in other consumers of `statusIcon`**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run build && bun test )`
Expected: build succeeds, all tests pass (in particular, `renderWorkflowLines`-based tests, which call `statusIcon` internally, must be unaffected since `statusIcon`'s output is byte-identical to before).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/display.ts bun-apps/pi-agent-ext-workflow/tests/workflow-display.test.ts
git commit -m "feat(pi-agent-ext-workflow): add shared ActivityRow renderer to display.ts"
```

---

### Task 4: Wire `ActivityRow` into `task-panel.ts` + fix the `agentHistory` event gap

**Files:**
- Modify: `src/task-panel.ts`
- Test: `tests/task-panel.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/task-panel.test.ts`, add `"agentHistory"` re-render coverage inside the existing `describe("installTaskPanel mode selection", ...)` block (after the `activeManager()` helper, before/after the three existing `it(...)` blocks — append this new one right after `"uses detailed rendering when the mode is detailed"`):

```ts
  it("re-renders when the manager emits an agentHistory event", () => {
    const manager = activeManager();
    let renderCount = 0;
    let factory: ((tui: { requestRender(): void }, theme: unknown) => { render(w: number): string[] }) | undefined;
    const ui = {
      setWidget: (_n: string, f: typeof factory) => {
        factory = f;
      },
    };
    mod.installTaskPanel(null, manager as never, ui as never);
    factory?.(
      {
        requestRender: () => {
          renderCount += 1;
        },
      },
      theme,
    );
    manager.emit("agentHistory", { runId: "r1" });
    assert.ok(renderCount > 0, "widget requests a re-render on agentHistory events");
  });
```

Add a second new test in the `describe("renderPanelDetailed", ...)` block (append right after the existing `"suppresses tok/s for paused runs"` test, before the closing `});` of that `describe`):

```ts
  it("shows the running agent's latest tool call as a live activity line", async () => {
    const { renderPanelDetailed, clearTokenSamples } = await import("../src/task-panel.js");
    clearTokenSamples("r1");
    const manager = detailedManager(2100);
    const running = manager.getRun("r1")?.snapshot.agents.find((a: { id: number }) => a.id === 2) as {
      history?: unknown[];
    };
    running.history = [{ role: "assistant", kind: "toolCall", toolName: "grep", text: "{}" }];
    const lines = renderPanelDetailed(manager as never, theme as never, undefined, 8, 1000);
    assert.ok(
      lines.some((l) => l.includes("[2] ● audit_auth") && l.includes("▸ grep")),
      `expected the running agent's latest tool call, got:\n${lines.join("\n")}`,
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/task-panel.test.ts )`
Expected: FAIL — the `agentHistory` test fails because `renderCount` stays 0 (event not subscribed yet); the "latest tool call" test fails because the rendered line has no `▸ grep` segment yet.

- [ ] **Step 3: Add `"agentHistory"` to `RUN_EVENTS` and wire `renderActivityRow` into `renderRunBody`**

In `src/task-panel.ts`, change the `RUN_EVENTS` array:

```ts
const RUN_EVENTS = [
  "agentStart",
  "agentEnd",
  "phase",
  "log",
  "tokenUsage",
  "complete",
  "error",
  "stopped",
  "paused",
  "resumed",
];
```

to:

```ts
const RUN_EVENTS = [
  "agentStart",
  "agentEnd",
  "agentHistory",
  "phase",
  "log",
  "tokenUsage",
  "complete",
  "error",
  "stopped",
  "paused",
  "resumed",
];
```

Add imports at the top of the file (extending the `display.js` import from Task 1, and adding a new `agent-history.js` import):

```ts
import {
  fmtTokensShort,
  shortModel,
  shorten,
  statusIcon,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
```

becomes:

```ts
import {
  type ActivityRow,
  fmtTokensShort,
  renderActivityRow,
  shorten,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
import { summarizeLatestAction } from "./agent-history.js";
```

(`statusIcon` and `shortModel` are no longer called directly in this file after this step — `renderActivityRow` handles both internally.)

Replace the per-agent loop inside `renderRunBody`:

```ts
    const visible = phaseAgents.slice(-maxAgents);
    for (const a of visible) {
      const tok = a.tokens ? dim(` ${fmtTokensShort(a.tokens)} tok`) : "";
      const mdl = shortModel(a.model);
      const model = mdl ? dim(` · ${mdl}`) : "";
      lines.push(`    [${a.id}] ${statusIcon(a.status)} ${shorten(a.label, 40)}${tok}${model}`);
    }
```

with:

```ts
    const visible = phaseAgents.slice(-maxAgents);
    for (const a of visible) {
      const row: ActivityRow = {
        status: a.status,
        actor: shorten(a.label, 40),
        model: a.model,
        tokens: a.tokens,
        badge: `[${a.id}]`,
        latestAction: a.status === "running" ? summarizeLatestAction(a.history) : undefined,
      };
      lines.push(`    ${renderActivityRow(row, theme)}`);
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/task-panel.test.ts )`
Expected: PASS — both new tests, and every pre-existing test in the file (the `[id] icon label tok model` substrings are preserved byte-for-byte by `renderActivityRow`'s output ordering).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/task-panel.ts bun-apps/pi-agent-ext-workflow/tests/task-panel.test.ts
git commit -m "feat(pi-agent-ext-workflow): live per-agent activity in the bottom task panel"
```

---

### Task 5: Wire `ActivityRow` into `subagent-viewer.ts`

**Files:**
- Modify: `src/subagent-viewer.ts`
- Test: `tests/subagent-viewer.test.ts`

- [ ] **Step 1: Update the existing model-format expectation and add new tests**

`renderActivityRow` always shortens the model string (drops the provider prefix), unifying with the task panel and navigator. `subagent-viewer.ts` currently shows the RAW model string in the Running row — this is a deliberate, documented behavior change. In `tests/subagent-viewer.test.ts`, change:

```ts
  assert.ok(out.includes("x/flash"), "running section shows the model");
```

to:

```ts
  assert.ok(out.includes("flash"), "running section shows the (shortened) model");
```

(this is inside the `"viewer list shows a Running section with live elapsed..."` test — only this one line changes, nothing else in that test).

Append two new tests at the end of the file:

```ts
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
```

- [ ] **Step 2: Run the tests to verify the new/changed ones fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )`
Expected: FAIL — `out.includes("flash")` fails (still literal "x/flash" today, which also still contains "flash" as a substring — so this specific assertion may actually already pass; the two NEW tests fail, since `▸ read` and the fallback path don't exist yet). Confirm at least the two new tests fail with a clear diff before proceeding.

- [ ] **Step 3: Implement — switch `renderList`'s two row groups to `renderActivityRow`**

In `src/subagent-viewer.ts`, add imports at the top of the file:

```ts
import type { AgentUsage } from "./agent.js";
import type { InFlightSubagent } from "./subagent-in-flight.js";
import type { SubagentToolDetails } from "./subagent-tool.js";
```

becomes:

```ts
import type { AgentUsage } from "./agent.js";
import { summarizeLatestAction } from "./agent-history.js";
import { type ActivityRow, renderActivityRow } from "./display.js";
import type { InFlightSubagent } from "./subagent-in-flight.js";
import type { SubagentToolDetails } from "./subagent-tool.js";
```

Replace the `renderList` method body:

```ts
  private renderList(width: number, th: Theme): string[] {
    const lines: string[] = [""];
    // Running section — live in-flight subagents (read fresh each render so a
    // 1s invalidate timer keeps elapsed counting up). Closes the gap that
    // running subagents were invisible in /subagents until they finished.
    const running = this.getRunning?.() ?? [];
    if (running.length > 0) {
      const runningTitle = th.fg("accent", th.bold(" Running "));
      lines.push(truncateToWidth(runningTitle + th.fg("borderMuted", "─".repeat(Math.max(0, width - 9))), width));
      for (const r of running) {
        const elapsedS = ((Date.now() - r.startedAt) / 1000).toFixed(1);
        const toolCalls = r.history?.filter((h) => h.kind === "toolCall").length ?? 0;
        const head = `${th.fg("warning", "⏳")} ${th.fg("muted", r.agent ?? "general-purpose")} ▸ ${th.fg("dim", r.model)} • ${elapsedS}s • ${toolCalls} call${toolCalls === 1 ? "" : "s"} • ${truncateToWidth(r.taskPreview, 40)}`;
        lines.push(truncateToWidth(`  ${head}`, width));
      }
      lines.push("");
    }
    const title = th.fg("accent", th.bold(" Subagent runs "));
    lines.push(truncateToWidth(title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 15))), width));
    lines.push("");
    if (this.runs.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No subagent runs on this branch.")}`, width));
    } else {
      for (const r of this.runs) {
        const cur = r.index - 1 === this.selected;
        const badge =
          r.status === "done"
            ? th.fg("success", "✓")
            : r.status === "timedout"
              ? th.fg("warning", "⏱")
              : th.fg("error", "✗");
        const head = `${badge} ${th.fg("accent", `#${r.index}`)} ${th.fg("muted", r.agent ?? "general-purpose")} ▸ ${th.fg("dim", truncateToWidth(r.taskPreview, 50))}`;
        lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", "▶ " + head) : "  " + head}`, width));
      }
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select • enter view • esc close")}`, width));
    lines.push("");
    return lines;
  }
```

with:

```ts
  private renderList(width: number, th: Theme): string[] {
    const lines: string[] = [""];
    // Running section — live in-flight subagents (read fresh each render so a
    // 1s invalidate timer keeps elapsed counting up). Closes the gap that
    // running subagents were invisible in /subagents until they finished.
    const running = this.getRunning?.() ?? [];
    if (running.length > 0) {
      const runningTitle = th.fg("accent", th.bold(" Running "));
      lines.push(truncateToWidth(runningTitle + th.fg("borderMuted", "─".repeat(Math.max(0, width - 9))), width));
      for (const r of running) {
        const toolCalls = r.history?.filter((h) => h.kind === "toolCall").length ?? 0;
        const row: ActivityRow = {
          status: "running",
          actor: r.agent ?? "general-purpose",
          model: r.model,
          elapsedMs: Date.now() - r.startedAt,
          toolCalls,
          latestAction: summarizeLatestAction(r.history) ?? truncateToWidth(r.taskPreview, 40),
        };
        lines.push(truncateToWidth(`  ${renderActivityRow(row, th)}`, width));
      }
      lines.push("");
    }
    const title = th.fg("accent", th.bold(" Subagent runs "));
    lines.push(truncateToWidth(title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 15))), width));
    lines.push("");
    if (this.runs.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "No subagent runs on this branch.")}`, width));
    } else {
      for (const r of this.runs) {
        const cur = r.index - 1 === this.selected;
        const row: ActivityRow = {
          status: r.status,
          actor: r.agent ?? "general-purpose",
          badge: `#${r.index}`,
          detail: r.taskPreview,
        };
        const head = renderActivityRow(row, th, 50);
        lines.push(truncateToWidth(` ${cur ? th.bg("selectedBg", "▶ " + head) : "  " + head}`, width));
      }
    }
    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "↑↓ select • enter view • esc close")}`, width));
    lines.push("");
    return lines;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-viewer.test.ts )`
Expected: PASS — all tests, including the changed model-format assertion and the two new tests.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-viewer.ts bun-apps/pi-agent-ext-workflow/tests/subagent-viewer.test.ts
git commit -m "feat(pi-agent-ext-workflow): /subagents Running section shows live latest tool call"
```

---

### Task 6: Wire `ActivityRow` into `workflow-ui.ts`'s agents list + fix the navigator's `agentHistory` event gap

**Files:**
- Modify: `src/workflow-ui.ts`
- Test: `tests/workflow-ui.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/workflow-ui.test.ts` (after the existing `test("renderNavigator shows model info in agent rows", ...)` block, ~line 484):

```ts
function runningAgentManager(): Pick<WorkflowManager, "listRuns" | "getRun"> {
  const snapshot: WorkflowSnapshot = {
    name: "audit",
    phases: ["Scan"],
    currentPhase: "Scan",
    logs: [],
    agents: [
      {
        id: 1,
        label: "scan a",
        phase: "Scan",
        prompt: "scan the code",
        status: "running",
        history: [{ role: "assistant", kind: "toolCall", toolName: "grep", text: "{}" }],
      },
    ],
    agentCount: 1,
    runningCount: 1,
    doneCount: 0,
    errorCount: 0,
  };
  return {
    listRuns: () =>
      [
        { runId: "run-2", workflowName: "audit", status: "running", phases: ["Scan"], agents: snapshot.agents, logs: [] },
      ] as unknown as PersistedRunState[],
    getRun: (id: string) =>
      id === "run-2" ? ({ runId: "run-2", status: "running", snapshot } as unknown as ManagedRun) : undefined,
  };
}

test("renderNavigator agents view shows a running agent's latest tool call", () => {
  const model = new NavigatorModel(runningAgentManager());
  const state = new NavigatorState();
  state.drill(model); // runs -> phases
  state.drill(model); // phases -> agents
  const text = renderNavigator(state, model, 80).join("\n");
  assert.ok(text.includes("▸ grep"), `expected the live tool call in the agents list, got:\n${text}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-ui.test.ts )`
Expected: FAIL — the new test fails because `NavigatorModel.agents()` does not yet carry `history` and the agents-view branch does not render it.

- [ ] **Step 3: Implement**

In `src/workflow-ui.ts`, Task 1 already changed the `display.js` import line to:

```ts
import { shortModel, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
```

Update it to also pull in `ActivityRow`/`renderActivityRow`, and add two new `agent-history.js` imports:

```ts
import type { AgentHistoryEntry } from "./agent-history.js";
import { summarizeLatestAction } from "./agent-history.js";
import { type ActivityRow, renderActivityRow, shortModel, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
```

Add `history` to the `AgentRow` interface:

```ts
interface AgentRow {
  id: number;
  label: string;
  status: string;
  phase?: string;
  tokens?: number;
  model?: string;
}
```

becomes:

```ts
interface AgentRow {
  id: number;
  label: string;
  status: string;
  phase?: string;
  tokens?: number;
  model?: string;
  history?: AgentHistoryEntry[];
}
```

Update `NavigatorModel.agents()` to pass `history` through:

```ts
  agents(runId: string, phase: string): AgentRow[] {
    const snap = this.snapshot(runId)?.snapshot;
    if (!snap) return [];
    return snap.agents
      .filter((a) => (a.phase ?? "(no phase)") === phase)
      .map((a) => ({ id: a.id, label: a.label, status: a.status, phase: a.phase, tokens: a.tokens, model: a.model }));
  }
```

becomes:

```ts
  agents(runId: string, phase: string): AgentRow[] {
    const snap = this.snapshot(runId)?.snapshot;
    if (!snap) return [];
    return snap.agents
      .filter((a) => (a.phase ?? "(no phase)") === phase)
      .map((a) => ({
        id: a.id,
        label: a.label,
        status: a.status,
        phase: a.phase,
        tokens: a.tokens,
        model: a.model,
        history: a.history,
      }));
  }
```

Replace the `"agents"` branch of `renderNavigator`:

```ts
  } else if (state.kind === "agents" && state.runId && state.phase) {
    const agents = model.agents(state.runId, state.phase);
    state.clamp(agents.length);
    lines.push(theme.bold(`${model.runName(state.runId)} › ${state.phase}`));
    agents.forEach((a, i) => {
      const icon = STATUS_ICON[a.status] ?? "?";
      const mdl = shortModel(a.model);
      const meta = [mdl, a.tokens ? fmtTokens(a.tokens) : undefined].filter(Boolean).join(" · ");
      lines.push(sel(i, `${icon} ${a.label}${meta ? dim(`  ${meta}`) : ""}`));
    });
```

with:

```ts
  } else if (state.kind === "agents" && state.runId && state.phase) {
    const agents = model.agents(state.runId, state.phase);
    state.clamp(agents.length);
    lines.push(theme.bold(`${model.runName(state.runId)} › ${state.phase}`));
    agents.forEach((a, i) => {
      const row: ActivityRow = {
        status: a.status as ActivityRow["status"],
        actor: a.label,
        model: a.model,
        tokens: a.tokens,
        latestAction: a.status === "running" ? summarizeLatestAction(a.history) : undefined,
      };
      lines.push(sel(i, renderActivityRow(row, theme)));
    });
```

Leave `STATUS_ICON` and `fmtTokens` (the local helper defined near `pad`) as-is — do not delete either. `STATUS_ICON` is still used in the `"runs"` branch (`icon = STATUS_ICON[r.status]`), and `fmtTokens` is still used in the `"phases"` branch (`fmtTokens(p.tokens)`); the `"agents"` branch was not their only call site.

Finally, add `"agentHistory"` to the navigator's live-event subscription list inside `openWorkflowNavigator`:

```ts
      const events = ["agentStart", "agentEnd", "phase", "log", "complete", "error", "stopped", "paused", "resumed"];
```

becomes:

```ts
      const events = [
        "agentStart",
        "agentEnd",
        "agentHistory",
        "phase",
        "log",
        "complete",
        "error",
        "stopped",
        "paused",
        "resumed",
      ];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-ui.test.ts )`
Expected: PASS — the new test, and all pre-existing tests (confirmed compatible: `renderNavigator shows agents view` checks `/❯ ✓ scan a/` and `/scan b/`, both still produced verbatim since `renderActivityRow` with no `badge` starts with `icon actor`; `renderNavigator shows model info in agent rows` checks `/model/`, still produced by `shortModel` inside `renderActivityRow`).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts bun-apps/pi-agent-ext-workflow/tests/workflow-ui.test.ts
git commit -m "feat(pi-agent-ext-workflow): navigator agents list shows live latest tool call"
```

---

### Task 7: `NavigatorState.followLive` auto-scroll for the running-agent detail tail

**Files:**
- Modify: `src/workflow-ui.ts`
- Test: `tests/workflow-ui.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/workflow-ui.test.ts`:

```ts
function runningDetailManager(historyLen: number): Pick<WorkflowManager, "listRuns" | "getRun"> {
  const history = Array.from({ length: historyLen }, (_, i) => ({
    role: "assistant" as const,
    kind: "toolCall" as const,
    toolName: "read",
    text: `entry-${i}`,
  }));
  const snapshot: WorkflowSnapshot = {
    name: "wf",
    phases: ["P"],
    currentPhase: "P",
    logs: [],
    agents: [{ id: 1, label: "worker", phase: "P", prompt: "p", status: "running", history }],
    agentCount: 1,
    runningCount: 1,
    doneCount: 0,
    errorCount: 0,
  };
  return {
    listRuns: () =>
      [{ runId: "r", workflowName: "wf", status: "running", phases: ["P"], agents: snapshot.agents, logs: [] }] as unknown as PersistedRunState[],
    getRun: (id: string) =>
      id === "r" ? ({ runId: "r", status: "running", snapshot } as unknown as ManagedRun) : undefined,
  };
}

test("detail view of a running agent auto-follows to the bottom and shows a live tag", () => {
  const model = new NavigatorModel(runningDetailManager(30));
  const state = new NavigatorState();
  state.drill(model); // runs -> phases
  state.drill(model); // phases -> agents
  state.drill(model); // agents -> detail
  assert.equal(state.followLive, true);

  const text = renderNavigator(state, model, 40, undefined, 14).join("\n");
  assert.match(text, /live/);
  assert.ok(text.includes("entry-29"), "last history entry visible at the bottom");
  assert.ok(!text.includes("entry-0"), "oldest entries scrolled out of view");
});

test("scrolling up in a running agent's detail view disables auto-follow", () => {
  const model = new NavigatorModel(runningDetailManager(30));
  const state = new NavigatorState();
  state.drill(model);
  state.drill(model);
  state.drill(model);
  renderNavigator(state, model, 40, undefined, 14); // establish the followed-to-bottom scroll position
  state.move(-1, 0);
  assert.equal(state.followLive, false);
  const text = renderNavigator(state, model, 40, undefined, 14).join("\n");
  assert.ok(!/live/.test(text), "live tag hidden once auto-follow is paused");
});

test("scrolling back to the bottom re-enables auto-follow", () => {
  const model = new NavigatorModel(runningDetailManager(30));
  const state = new NavigatorState();
  state.drill(model);
  state.drill(model);
  state.drill(model);
  renderNavigator(state, model, 40, undefined, 14);
  state.move(-1, 0);
  assert.equal(state.followLive, false);
  state.move(1000, 0); // scroll back to (or past) the bottom
  const text = renderNavigator(state, model, 40, undefined, 14).join("\n");
  assert.equal(state.followLive, true);
  assert.match(text, /live/);
});

test("a finished agent's detail view never shows the live tag, even with a long history", () => {
  const manager = runningDetailManager(30);
  const run = manager.getRun("r") as unknown as { snapshot: WorkflowSnapshot };
  run.snapshot.agents[0].status = "done";
  const model = new NavigatorModel(manager);
  const state = new NavigatorState();
  state.drill(model);
  state.drill(model);
  state.drill(model);
  const text = renderNavigator(state, model, 40, undefined, 14).join("\n");
  assert.ok(!/live/.test(text), "no live tag for a finished agent");
  assert.equal(state.scroll, 0, "starts at the top (not auto-scrolled) for a finished agent");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-ui.test.ts )`
Expected: FAIL — `state.followLive` does not exist yet (TypeScript/runtime error), and none of the auto-scroll behavior is implemented.

- [ ] **Step 3: Implement `followLive` on `NavigatorState`**

In `src/workflow-ui.ts`, add the field to `NavigatorState`:

```ts
export class NavigatorState {
  private stack: StackFrame[] = [{ kind: "runs", cursor: 0 }];
  scroll = 0;
```

becomes:

```ts
export class NavigatorState {
  private stack: StackFrame[] = [{ kind: "runs", cursor: 0 }];
  scroll = 0;
  /** Auto-scroll-to-bottom for a running agent's detail live tail (Task 7). */
  followLive = true;
```

Update `move()`:

```ts
  move(delta: number, count: number) {
    if (this.kind === "detail" || this.kind === "savedDetail") {
      this.scroll = Math.max(0, this.scroll + delta);
      return;
    }
    if (count <= 0) return;
    const t = this.top();
    t.cursor = (t.cursor + delta + count) % count;
  }
```

becomes:

```ts
  move(delta: number, count: number) {
    if (this.kind === "detail" || this.kind === "savedDetail") {
      if (this.kind === "detail" && delta < 0) this.followLive = false;
      this.scroll = Math.max(0, this.scroll + delta);
      return;
    }
    if (count <= 0) return;
    const t = this.top();
    t.cursor = (t.cursor + delta + count) % count;
  }
```

Update `drill()`'s agents→detail branch to reset `followLive` on entry:

```ts
    if (t.kind === "agents" && t.runId && t.phase) {
      const agents = model.agents(t.runId, t.phase);
      const ag = agents[t.cursor];
      if (!ag) return false;
      this.scroll = 0;
      this.stack.push({ kind: "detail", cursor: 0, runId: t.runId, phase: t.phase, agentId: ag.id });
      return true;
    }
```

becomes:

```ts
    if (t.kind === "agents" && t.runId && t.phase) {
      const agents = model.agents(t.runId, t.phase);
      const ag = agents[t.cursor];
      if (!ag) return false;
      this.scroll = 0;
      this.followLive = true;
      this.stack.push({ kind: "detail", cursor: 0, runId: t.runId, phase: t.phase, agentId: ag.id });
      return true;
    }
```

- [ ] **Step 4: Wire `followLive` into `pushScrollable` and the detail branch's render**

Update `pushScrollable` inside `renderNavigator`:

```ts
  const pushScrollable = (body: string[]) => {
    const viewport = Math.max(5, viewportRows - 4); // reserve title + blank + footer + indicator
    const maxScroll = Math.max(0, body.length - viewport);
    state.scroll = Math.min(Math.max(0, state.scroll), maxScroll);
    lines.push(...body.slice(state.scroll, state.scroll + viewport));
    if (body.length > viewport) {
      const end = Math.min(state.scroll + viewport, body.length);
      lines.push(dim(`  [${state.scroll + 1}-${end} / ${body.length}]`));
    }
  };
```

becomes:

```ts
  const pushScrollable = (body: string[], live = false) => {
    const viewport = Math.max(5, viewportRows - 4); // reserve title + blank + footer + indicator
    const maxScroll = Math.max(0, body.length - viewport);
    if (live && state.followLive) {
      state.scroll = maxScroll;
    } else {
      state.scroll = Math.min(Math.max(0, state.scroll), maxScroll);
    }
    if (live) state.followLive = state.scroll >= maxScroll;
    lines.push(...body.slice(state.scroll, state.scroll + viewport));
    if (body.length > viewport) {
      const end = Math.min(state.scroll + viewport, body.length);
      const liveTag = live && state.followLive ? `${dim("live")} ` : "";
      lines.push(dim(`  ${liveTag}[${state.scroll + 1}-${end} / ${body.length}]`));
    }
  };
```

Update the one call site in the `"detail"` branch — find:

```ts
      if (a.history?.length) {
        body.push("", dim("History:"));
        for (const entry of a.history) {
          body.push(...wrap(`${historyLabel(entry)}: ${entry.text}`, width));
        }
      }
      pushScrollable(body);
    }
  } else if (state.kind === "savedDetail" && state.savedName) {
```

change `pushScrollable(body);` to:

```ts
      pushScrollable(body, a.status === "running");
```

Leave the `"savedDetail"` branch's `pushScrollable(body);` call untouched (no `live` argument — saved scripts never receive live updates, so it defaults to `false`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/workflow-ui.test.ts )`
Expected: PASS — the 4 new tests, AND the pre-existing `"detail view scrolls within a fixed viewport and does not collapse"` test (its fixture agent has `status: "done"`, so `live=false` there — the old clamp-only path runs unchanged) and `"NavigatorState cursor wraps and detail scroll clamps at 0"` (calls `state.move()` directly, unaffected by the render-side `followLive` logic).

- [ ] **Step 6: Run the full package suite**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run check && bun run build && bun run test:unit )`
Expected: all three commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/workflow-ui.ts bun-apps/pi-agent-ext-workflow/tests/workflow-ui.test.ts
git commit -m "feat(pi-agent-ext-workflow): navigator auto-follows a running agent's live history tail"
```

---

### Task 8: `CONTEXT.md` glossary entry

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/CONTEXT.md`

- [ ] **Step 1: Add the "Activity row" term**

In `bun-apps/pi-agent-ext-workflow/CONTEXT.md`, find this existing block (under `### Execution lifecycle`):

```markdown
**`workflow_control`**:
The model-callable control surface for a background run — `stop`/`pause`/`resume`/`status`/`list`/`wait` — mirroring `/workflows`'s human-typed surface but reachable by the LLM itself without a user typing a command. Only knows `workflow`-tool run ids; a `subagent`-tool call has no run identity to control.
_Avoid_: task management, subagent control

### Quality & control
```

Change it to:

```markdown
**`workflow_control`**:
The model-callable control surface for a background run — `stop`/`pause`/`resume`/`status`/`list`/`wait` — mirroring `/workflows`'s human-typed surface but reachable by the LLM itself without a user typing a command. Only knows `workflow`-tool run ids; a `subagent`-tool call has no run identity to control.
_Avoid_: task management, subagent control

**Activity row**:
The shared one-line renderer (`display.ts`, `renderActivityRow`) for an agent/subagent's live status — icon, actor, model, tokens, and (while running) its most recent tool call — used by the bottom task panel, the `/workflows` navigator's agent list and detail live-tail, and the `/subagents` viewer, so the three surfaces speak one visual language.
_Avoid_: three independent hand-built status-line templates (the pre-existing state this replaces)

### Quality & control
```

- [ ] **Step 2: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/CONTEXT.md
git commit -m "docs(pi-agent-ext-workflow): add Activity row glossary entry"
```

---

### Task 9: Full verification + manual test pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated suite**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun run check && bun run build && bun run test:unit )`
Expected: `bun run check` (Biome) exits 0, `bun run build` (tsc) exits 0, `bun run test:unit` (bun test) — every test passes, zero failures.

- [ ] **Step 2: Manual verification — bottom panel + navigator, a live `workflow()` run**

Start the GUI/TUI per this repo's normal dev flow, or use `pi-agent`'s interactive session directly. Run a workflow whose script fans out `parallel()` across at least 3 agents doing real tool calls (e.g. reading a few files each). While it runs:
- Confirm the bottom panel in **detailed** mode (`/workflows-progress detailed`) shows each running agent's current tool call next to its `[id] icon label` row, and that it updates as the agent moves between tool calls (not just when an agent starts/finishes).
- Open `/workflows`, drill into the running run → a phase → the agents list — confirm each running agent's row also shows its current tool call without drilling further.
- Drill into one running agent's detail page — confirm the History section auto-scrolls to the newest entry as new tool calls happen, that a `live` tag appears next to the scroll-position indicator, that pressing `k`/↑ pauses the auto-scroll (the `live` tag disappears), and that scrolling back down to the bottom (`j`/↓ repeatedly, or a large jump) re-arms it.

- [ ] **Step 3: Manual verification — `/subagents`**

Dispatch an ad-hoc `subagent` tool call for a task with several tool calls (e.g. "read 3 files and summarize them"). While it is running, open `/subagents` — confirm the Running section shows the latest tool call name (not just the static task preview) once the child has made its first tool call, and that the elapsed/call-count still update as before.

- [ ] **Step 4: Report results**

If all automated and manual checks pass, the plan is complete. If a manual check fails, treat it as a bug against the specific task whose commit introduced the regression (identifiable via `git bisect` across this plan's per-task commits, since each one is independently buildable/testable).
