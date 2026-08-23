# Design — subagent TUI visibility (Level-1: renderCall/renderResult + /subagents viewer)

> Brainstorming output. Approved: Approach A (todo-mirror), Level-1 depth.

## Problem

The `subagent` tool (`pi-agent-ext-workflow`, merged in #639) has **no custom TUI rendering**: `createSubagentTool()` defines `execute` only — no `renderCall`, no `renderResult`, and it ignores the `_onUpdate`/`_ctx` hooks its signature receives. So in the TUI a subagent dispatch shows only pi's default tool rendering (tool name + spinner) while running and dumps the raw output at the end. There is no at-a-glance status line (which role? which model? the task?), no collapsible report, and no way to browse past subagent runs. The `spawnSubagent` runner is **synchronous** (awaits `WorkflowAgent.run` end-to-end, no event hook), so live "running" output streaming is **out of scope** (that is Level-2, deferred).

Separately, the user asked to **verify how `pi-agent-ext-superpowers` uses the workflow `subagent` tool**. The wiring is a **prompt-level mapping**, not code: `src/superpowers.ts` (the `piToolMapping` prompt text, ~line 134) and `skills/using-superpowers/references/pi-tools.md` instruct the agent to "use the `subagent` tool provided by `pi-agent-ext-workflow`". No test currently guards that the mapping text names the tool/params correctly.

## Solution (approved: Approach A — todo-mirror)

Mirror the `todo` extension's pattern exactly (`examples/extensions/todo.ts`):
1. **Enrich tool `details`** so renderers + the viewer share one source of truth (session-stored, branching-safe).
2. **`renderCall(args, theme)`** — rich "running" line shown during the dispatch.
3. **`renderResult(result, {expanded}, theme)`** — collapsible: collapsed = status badge + model + elapsed + headline; expanded = full report.
4. **`/subagents` command** — reconstruct all past subagent runs from the session branch (`ctx.sessionManager.getBranch()`), present a `SelectList`, and on select show the chosen run's full output in a viewer (esc to close). Identical reconstruction strategy to todo's `/todos`.
5. **Verify wiring** — add a `bootstrap.test.ts` assertion that the superpowers prompt-mapping text names the workflow `subagent` tool + its documented params; document the full chain here.

All state lives in the tool's `details` + `content` (session entries) — no external file, branching-correct by construction.

## Components

### 1. `SubagentToolDetails` (enrich) — `src/subagent-tool.ts`
```ts
export interface SubagentToolDetails {
  exitCode: number;
  timedOut: boolean;
  // new — feed renderResult + the /subagents viewer:
  agent?: string;        // params.agent (role label), if provided
  model?: string;        // params.model, or "default"
  taskPreview: string;   // first ~80 chars of params.task (single line)
  elapsedMs: number;     // wall-clock of the run (Date.now() delta in execute)
  status: "done" | "failed" | "timedout";
}
```
`execute` records `const t0 = Date.now()` before `await spawn(...)`, then derives `status` from `{exitCode, timedOut}` and fills the new fields. The returned `content[0].text` (already `formatSubagentResult`) is unchanged — it stays the full text the parent agent reads AND what the viewer displays.

### 2. `renderCall(args, theme)` — `src/subagent-tool.ts`
Returns a one-line `Text`:
```
subagent ▸ <agent|general-purpose> ▸ <model|default> ▸ "<taskPreview>…"
```
- `subagent` → `theme.bold(theme.fg("toolTitle", "subagent"))`
- `agent` → `theme.fg("accent", …)`. **Omit the whole segment when `args.agent` is absent** (line becomes `subagent ▸ model ▸ task`) — brevity over a placeholder label.
- `model` → `theme.fg("muted", …)`
- `taskPreview` → `theme.fg("dim", truncateToWidth(…))`, single-line, ellipsized.
- pi's own spinner conveys "running" — no explicit badge needed.

### 3. `renderResult(result, {expanded}, theme)` — `src/subagent-tool.ts`
- **collapsed:** `✓ done | ✗ failed | ⏱ timedout` badge + `model` + elapsed (e.g. `12.3s`) + first non-empty line of the report, truncated. (Failed: use `theme.fg("error")`; done: `theme.fg("success")`.)
- **expanded:** the full report text (`result.content[0].text`) in `theme.fg("toolOutput", …)`, wrapped/truncated to width.
- Reads everything from `result.details as SubagentToolDetails`.

### 4. `/subagents` command + viewer — `extensions/workflow.ts` (+ a small component)
- `pi.registerCommand("subagents", { handler })` — `ctx.mode !== "tui"` → notify + return (mirror todo's guard).
- **Reconstruct:** iterate `ctx.sessionManager.getBranch()`; for entries where `message.role === "toolResult" && message.toolName === "subagent"`, collect `{ index, agent, model, taskPreview, status, elapsedMs, output: content[0].text }` from `details` + `content`. (Same loop shape as todo's `reconstructState`.)
- **List view:** a `SelectList` (Pattern 1 from the TUI doc) of runs: `#<i> <status-badge> <agent> ▸ <taskPreview>`. `onSelect` → swap to the output view; `onCancel`/esc → close.
- **Output view:** a scrollable `Text`/`Markdown` of the run's full `output`, with a header line (`#<i> <agent> ▸ <model> ▸ <status> ▸ <elapsed>`). esc → back to list.
- **Navigation:** ONE stateful component holds `view: "list" | "output"` + `selectedIndex`; selecting a run flips `view` to `output`, esc flips it back to `list`. No second `ctx.ui.custom` call, no disposal/re-call (sidesteps the overlay-lifecycle caveat entirely). `handleInput` dispatches by `view`; state changes call `tui.requestRender()`.

### 5. Verify wiring — `pi-agent-ext-superpowers/tests/bootstrap.test.ts` + this doc
- Add an assertion (or strengthen the existing bootstrap test) that the `piToolMapping`/pi-tools reference text contains the literal tool name `subagent` and the documented params (`task`, `model`, `tools`, `excludeTools`, `cwd`). Guards against silent drift if the tool is renamed.
- **Chain documented here:** `superpowers piToolMapping prompt (superpowers.ts) + references/pi-tools.md` → instructs the agent to call → `subagent` tool (`pi-agent-ext-workflow/src/subagent-tool.ts`, registered in `extensions/workflow.ts`) → `spawnSubagent()` (`src/spawn-subagent.ts`) → `WorkflowAgent.run` (`createAgentSession`, in-process isolated child). The bridge is **prompt-level** (superpowers tells the agent which tool to use), not a code import.

## Data flow
```
agent calls subagent({agent,task,model,...})
  → execute: t0=now; result=await spawnSubagent(...); details={exitCode,timedOut,agent,model,taskPreview,elapsedMs,status}
  → TUI: renderCall shows the line WHILE running; renderResult replaces it on completion (collapsed/expanded)
session stores the toolResult {content, details}
  → /subagents command reconstructs the list from session branch → select → view full output
```

## Out of scope (Level-2, deferred)
- Live streaming of a running subagent's output (needs a `WorkflowAgent.run`/`createAgentSession` event/callback hook; existence unconfirmed in the SDK).
- Footer `setStatus` badge during the run (redundant with `renderCall` for a single synchronous tool).
- Multi-subagent concurrency view (applies to the `workflow` tool's parallel agents, separate effort).

## Testing
- **Unit (`subagent-tool.test.ts`):** extend existing tests — `execute` populates the new `details` fields (agent/model/taskPreview/elapsedMs/status) for done/failed/timedout; `renderCall` returns a `Text` containing agent+model+taskPreview; `renderResult` collapsed differs from expanded (collapsed short, expanded contains the full report).
- **Component/viewer:** a focused test that the reconstruct loop collects runs in order from a fixture session branch and that list→output navigation works (can be a lightweight render-snapshot of the component if full TUI interactivity is hard to test headless; otherwise assert the reconstruction function in isolation).
- **Verify:** the new/ strengthened `bootstrap.test.ts` assertion passes.
- **Manual:** run a real `subagent` dispatch in the TUI, observe the rich call line + collapsible result; run `/subagents`, select a past run, view its output.
