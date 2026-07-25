# Always-on subagent progress widget — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-on, below-editor widget that shows one live line per running subagent (mirroring the `/subagents` Running row), invisible when idle.

**Architecture:** A pure `SubagentProgressWidget` class renders a header + one `renderActivityRow` line per in-flight subagent, reading the existing shared `SubagentInFlightRegistry` live (the same singleton the `subagent` tool writes to and `/subagents` reads). A thin `installSubagentProgressWidget` wiring mounts it once via `ctx.ui.setWidget("subagents", factory, { placement: "belowEditor" })` at `session_start`; a 1 s timer calls `tui.requestRender()` so elapsed ticks between events. Lives in `pi-agent-ext-workflow` (same package as the viewer); the subagent package is untouched in v1.

**Tech Stack:** Bun + TypeScript; `@earendil-works/pi-coding-agent` (`Theme`, `ExtensionContext`); `@earendil-works/pi-tui` (`truncateToWidth`); `@repo/pi-agent-ext-subagent` (`InFlightSubagent`, `summarizeLatestAction`, `SubagentInFlightRegistry`); reuses `renderActivityRow` + `ActivityRow` from `./display.js`.

## Global Constraints

- **Package root:** `bun-apps/pi-agent-ext-workflow`. Run commands from the package dir via `( cd bun-apps/pi-agent-ext-workflow && … )`. Never top-level `cd`.
- **CI gate for this package:** `bun run build && bun test` (i.e. `bunx tsc` + `bun test`). Biome `check` is a documented pre-existing exclusion for this package — BUT every NEW file added by this plan must still be biome-clean; verify per-file with `bunx biome check <file>`.
- **Ownership boundary:** widget lives in `pi-agent-ext-workflow`. Do NOT move the viewer into `pi-agent-ext-subagent` (the `display.ts ⟹ workflow.ts` cycle constraint, ADR 0001, stands). The subagent package is untouched in v1.
- **Shared singleton:** read the registry via the workflow extension's existing `subagentInFlight` (already imported from `@repo/pi-agent-ext-subagent/src/index.ts` in `extensions/workflow.ts`).
- **Widget render contract:** `setWidget`'s factory `render` takes **no width** arg (returns `string[]`) — unlike `ui.custom` components. Use fixed truncation (mirror `display.ts`: `renderActivityRow`'s `shorten(label,48)` / `maxDetailWidth=50` defaults); do NOT depend on a terminal width.
- **Do NOT re-call `setWidget` per tick:** re-registration reorders the widget to the end of the widget list (per `status-widget.ts` note). Register the factory ONCE; refresh via `tui.requestRender()`.
- **Written artifacts in English** (code, comments, commits); conversation in zh-TW.

## File Structure

- **Create** `src/subagent-progress-widget.ts` — pure `SubagentProgressWidget` class (render logic, no TUI/`ctx`). Reuses `renderActivityRow` + `summarizeLatestAction`.
- **Create** `tests/subagent-progress-widget.test.ts` — unit tests for the pure class (idle/rows/plural/resolved-model/fallback).
- **Create** `tests/install-subagent-progress-widget.test.ts` — wiring tests (mount-once/key/placement, live-read, idle-empty, timer→requestRender, no-op guard, start-once guard).
- **Modify** `extensions/workflow.ts` — import `installSubagentProgressWidget` and call it once in `session_start` (after `installTaskPanel`).

`installSubagentProgressWidget` lives in `src/subagent-progress-widget.ts` too (pure render class + its thin wiring companion, one responsibility: "the progress widget"). The session_start call in `extensions/workflow.ts` is the only integration point.

---

### Task 1: Pure `SubagentProgressWidget` render class

**Files:**
- Create: `bun-apps/pi-agent-ext-workflow/src/subagent-progress-widget.ts`
- Test: `bun-apps/pi-agent-ext-workflow/tests/subagent-progress-widget.test.ts`

**Interfaces:**
- Consumes: `InFlightSubagent` + `summarizeLatestAction` from `@repo/pi-agent-ext-subagent`; `renderActivityRow` + `ActivityRow` from `./display.js`; `Theme` from `@earendil-works/pi-coding-agent`; `truncateToWidth` from `@earendil-works/pi-tui`.
- Produces: `class SubagentProgressWidget { constructor(opts: { getRunning: () => InFlightSubagent[] }); render(theme: Theme): string[]; invalidate(): void }`. (Task 2's wiring constructs this and calls `render(theme)`.)

- [ ] **Step 1: Write the failing tests**

Create `tests/subagent-progress-widget.test.ts`:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import type { InFlightSubagent } from "@repo/pi-agent-ext-subagent";
import { SubagentProgressWidget } from "../src/subagent-progress-widget.js";

// Identity theme so render() returns plain text we can assert on (mirrors subagent-viewer.test.ts).
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

test("widget renders nothing when no subagent is running", () => {
  const w = new SubagentProgressWidget({ getRunning: () => [] });
  assert.deepEqual(w.render(T), []);
});

test("widget renders a header + one row per running subagent", () => {
  const w = new SubagentProgressWidget({ getRunning: () => [run()] });
  const out = w.render(T).join("\n");
  assert.match(out, /1 subagent running/);
  assert.ok(out.includes("implementer"), "shows the agent role");
  assert.ok(out.includes("flash"), "shows the shortened model (provider prefix dropped)");
  assert.match(out, /\d+\.\d+s/, "shows live elapsed");
  assert.match(out, /1 call/, "shows the live tool-call count");
  assert.ok(out.includes("▸ read"), "shows the latest tool call via summarizeLatestAction");
});

test("widget pluralizes and lists every running subagent", () => {
  const w = new SubagentProgressWidget({
    getRunning: () => [run({ id: "r1" }), run({ id: "r2", agent: "reviewer", model: "y/pro" })],
  });
  const out = w.render(T).join("\n");
  assert.match(out, /2 subagents running/);
  assert.ok(out.includes("implementer") && out.includes("reviewer"));
});

test("widget prefers resolvedModel over the requested model", () => {
  const w = new SubagentProgressWidget({ getRunning: () => [run({ resolvedModel: "google/gemma-4-12b-qat" })] });
  const out = w.render(T).join("\n");
  assert.ok(out.includes("gemma-4-12b-qat"), "shows the resolved model");
  assert.ok(!out.includes("flash"), "does not show the pre-resolution requested model");
});

test("widget falls back to the task preview before any history exists", () => {
  const w = new SubagentProgressWidget({ getRunning: () => [run({ history: [] })] });
  const out = w.render(T).join("\n");
  assert.ok(out.includes("doing X"), "falls back to the static task preview before any tool call");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-progress-widget.test.ts )`
Expected: FAIL — `Cannot find module '../src/subagent-progress-widget.js'` (file does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/subagent-progress-widget.ts`:

```ts
/**
 * Always-on below-editor widget showing one live line per running subagent —
 * visually identical to the /subagents viewer's Running row (same renderActivityRow).
 * Renders [] when idle → invisible (zero screen footprint). Reads the shared
 * in-flight registry live on each render; refresh cadence is driven by the
 * wiring's timer (tui.requestRender), not here.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { InFlightSubagent } from "@repo/pi-agent-ext-subagent";
import { summarizeLatestAction } from "@repo/pi-agent-ext-subagent";
import { type ActivityRow, renderActivityRow } from "./display.js";

export interface SubagentProgressWidgetOpts {
  getRunning: () => InFlightSubagent[];
}

export class SubagentProgressWidget {
  constructor(private opts: SubagentProgressWidgetOpts) {}

  render(theme: Theme): string[] {
    const running = this.opts.getRunning();
    if (running.length === 0) return [];
    const noun = running.length === 1 ? "subagent" : "subagents";
    const header = theme.fg("accent", theme.bold(` ${running.length} ${noun} running `));
    const lines: string[] = [header];
    for (const r of running) {
      const toolCalls = r.history?.filter((h) => h.kind === "toolCall").length ?? 0;
      const row: ActivityRow = {
        status: "running",
        actor: r.agent ?? "general-purpose",
        model: r.resolvedModel ?? r.model,
        elapsedMs: Date.now() - r.startedAt,
        toolCalls,
        latestAction: summarizeLatestAction(r.history) ?? truncateToWidth(r.taskPreview, 40),
      };
      lines.push(`  ${renderActivityRow(row, theme)}`);
    }
    return lines;
  }

  invalidate(): void {
    // No width/theme cache: render() reads live state each call. Present for the
    // TUI component contract; a no-op matches display.ts's widget factory.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/subagent-progress-widget.test.ts )`
Expected: PASS — 5 tests.

- [ ] **Step 5: Verify the new file is biome-clean + typechecks**

Run: `( cd bun-apps/pi-agent-ext-workflow && bunx biome check src/subagent-progress-widget.ts tests/subagent-progress-widget.test.ts && bunx tsc --noEmit )`
Expected: biome reports no issues for these two files; `tsc` exits 0. (If biome flags formatting, run `bunx biome check --write <files>` then re-run.)

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-progress-widget.ts bun-apps/pi-agent-ext-workflow/tests/subagent-progress-widget.test.ts
git commit -m "feat(subagent-progress-widget): pure render class for always-on running-subagent panel"
```

---

### Task 2: Wiring — mount once at `session_start`, timer-driven refresh

**Files:**
- Modify: `bun-apps/pi-agent-ext-workflow/src/subagent-progress-widget.ts` (append `installSubagentProgressWidget`)
- Create: `bun-apps/pi-agent-ext-workflow/tests/install-subagent-progress-widget.test.ts`
- Modify: `bun-apps/pi-agent-ext-workflow/extensions/workflow.ts` (import + one call in `session_start`)

**Interfaces:**
- Consumes: `SubagentProgressWidget` (Task 1); `SubagentInFlightRegistry` from `@repo/pi-agent-ext-subagent/src/index.js`; `ExtensionContext["ui"].setWidget` (Pattern 5: `setWidget(key, factory, { placement })` where factory is `(tui, theme) => { render: () => string[]; invalidate: () => void }`).
- Produces: `function installSubagentProgressWidget(ui, opts): { dispose }` — mounts the widget once, returns a `dispose()` that clears the timer.

- [ ] **Step 1: Write the failing wiring tests**

Create `tests/install-subagent-progress-widget.test.ts`:

```ts
import { test } from "bun:test";
import assert from "node:assert/strict";
import { installSubagentProgressWidget } from "../src/subagent-progress-widget.js";

const T = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as never;

/** Minimal fake registry: only `.list()` is read. */
function fakeRegistry(list: () => unknown[]) {
  return { list } as never;
}

test("install mounts the widget once, below the editor, keyed 'subagents'", () => {
  const calls: Array<{ key: string; opts: { placement?: string } }> = [];
  const ui = { setWidget: (key: string, _f: unknown, opts: { placement?: string }) => calls.push({ key, opts }) };
  const { dispose } = installSubagentProgressWidget(ui as never, {
    registry: fakeRegistry(() => []),
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, "subagents");
  assert.equal(calls[0].opts.placement, "belowEditor");
  dispose();
});

test("factory render reads the registry live and is empty when idle", () => {
  let factory: ((tui: unknown, theme: unknown) => { render: () => string[] }) | undefined;
  const ui = { setWidget: (_k: string, f: unknown) => { factory = f as typeof factory; } };
  installSubagentProgressWidget(ui as never, {
    registry: fakeRegistry(() => []),
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  const comp = factory!({ requestRender: () => {} }, T);
  assert.deepEqual(comp.render(), []);
});

test("factory render shows a running subagent once the registry has one", () => {
  const list: unknown[] = [];
  let factory: ((tui: unknown, theme: unknown) => { render: () => string[] }) | undefined;
  const ui = { setWidget: (_k: string, f: unknown) => { factory = f as typeof factory; } };
  installSubagentProgressWidget(ui as never, {
    registry: fakeRegistry(() => list),
    setInterval: (() => "id") as never,
    clearInterval: () => {},
  });
  const comp = factory!({ requestRender: () => {} }, T);
  assert.deepEqual(comp.render(), []);
  list.push({
    id: "r1",
    agent: "implementer",
    model: "x/flash",
    taskPreview: "doing X",
    startedAt: Date.now() - 1500,
    history: [{ role: "assistant", kind: "toolCall", toolName: "read", text: "{}" }],
  });
  assert.ok(comp.render().length > 0, "row appears once the registry lists a run");
});

test("the timer callback calls tui.requestRender (elapsed ticks between events)", () => {
  let scheduled: (() => void) | undefined;
  let rendered = 0;
  let factory: ((tui: unknown, theme: unknown) => unknown) | undefined;
  const ui = { setWidget: (_k: string, f: unknown) => { factory = f as typeof factory; } };
  installSubagentProgressWidget(ui as never, {
    registry: fakeRegistry(() => []),
    setInterval: (fn: () => void) => { scheduled = fn; return "id"; },
    clearInterval: () => {},
  } as never);
  factory!({ requestRender: () => { rendered += 1; } }, T);
  assert.ok(scheduled, "a timer callback was registered");
  scheduled!();
  assert.equal(rendered, 1, "the timer tick calls requestRender");
});

test("timer starts exactly once even if the app invokes the factory twice", () => {
  let starts = 0;
  let factory: ((tui: unknown, theme: unknown) => unknown) | undefined;
  const ui = { setWidget: (_k: string, f: unknown) => { factory = f as typeof factory; } };
  installSubagentProgressWidget(ui as never, {
    registry: fakeRegistry(() => []),
    setInterval: () => { starts += 1; return "id"; },
    clearInterval: () => {},
  } as never);
  const tui = { requestRender: () => {} };
  factory!(tui, T);
  factory!(tui, T); // second invocation (e.g. theme change) must NOT start a second interval
  assert.equal(starts, 1);
});

test("install is a safe no-op when ui has no setWidget (headless/RPC)", () => {
  const { dispose } = installSubagentProgressWidget(undefined as never, { registry: fakeRegistry(() => []) });
  assert.doesNotThrow(() => dispose());
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/install-subagent-progress-widget.test.ts )`
Expected: FAIL — `installSubagentProgressWidget is not a function` (not exported yet).

- [ ] **Step 3: Append the wiring to `src/subagent-progress-widget.ts`**

Add to the end of `src/subagent-progress-widget.ts` (after the class):

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentInFlightRegistry } from "@repo/pi-agent-ext-subagent/src/index.js";

export interface InstallSubagentProgressWidgetOpts {
  registry: SubagentInFlightRegistry;
  placement?: "belowEditor" | "aboveEditor";
  /** Refresh cadence for the elapsed counter, ms (default 1000). */
  intervalMs?: number;
  /** Injectable for tests (default: global setInterval). */
  setInterval?: typeof setInterval;
  /** Injectable for tests (default: global clearInterval). */
  clearInterval?: typeof clearInterval;
}

const PROGRESS_INTERVAL_MS = 1000;

/**
 * Mount the always-on subagent-progress widget below the editor. The factory is
 * registered ONCE; its render reads the registry live and returns [] when idle
 * (invisible, zero footprint). A timer calls tui.requestRender() so the elapsed
 * counter ticks between events. We deliberately do NOT re-call setWidget per
 * tick — re-registration reorders the widget to the end of the list
 * (status-widget.ts note); requestRender avoids that.
 *
 * Safe no-op when `ui` has no setWidget (headless/RPC mode).
 */
export function installSubagentProgressWidget(
  ui: Pick<ExtensionContext["ui"], "setWidget"> | undefined,
  opts: InstallSubagentProgressWidgetOpts,
): { dispose: () => void } {
  if (!ui || typeof ui.setWidget !== "function") return { dispose: () => {} };
  const placement = opts.placement ?? "belowEditor";
  const intervalMs = opts.intervalMs ?? PROGRESS_INTERVAL_MS;
  const si = opts.setInterval ?? setInterval;
  const ci = opts.clearInterval ?? clearInterval;
  const widget = new SubagentProgressWidget({ getRunning: () => opts.registry.list() });

  let timerId: ReturnType<typeof setInterval> | undefined;
  let started = false;
  // Factory signature mirrors createWidgetWorkflowDisplay (display.ts):
  // (tui, theme) => { render: () => string[]; invalidate: () => void }.
  const factory = (tui: unknown, theme: Theme) => {
    // Start the refresh timer exactly once — the app may invoke the factory more
    // than once (e.g. on theme change); guard against a duplicate interval.
    if (!started) {
      started = true;
      timerId = si(() => (tui as { requestRender: () => void }).requestRender(), intervalMs);
    }
    return {
      render: () => widget.render(theme),
      invalidate: () => widget.invalidate(),
    };
  };

  ui.setWidget("subagents", factory, { placement });

  return {
    dispose: () => {
      if (timerId !== undefined) ci(timerId);
      timerId = undefined;
    },
  };
}
```

- [ ] **Step 4: Run wiring tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-workflow && bun test tests/install-subagent-progress-widget.test.ts )`
Expected: PASS — 6 tests.

- [ ] **Step 5: Wire the mount into `session_start`**

In `extensions/workflow.ts`:

1. Add the import alongside the existing `createSubagentsCommand` import (which already sits next to the `subagentInFlight` singleton):

```ts
import { installSubagentProgressWidget } from "../src/subagent-progress-widget.js";
```

2. Inside the `pi.on("session_start", …)` handler, immediately after the `installTaskPanel(…)` call, add:

```ts
    // Always-on below-editor panel: one live line per running subagent (mirrors
    // the /subagents Running row), invisible when idle. Reads the shared
    // subagentInFlight singleton the `subagent` tool writes to.
    installSubagentProgressWidget(ctx.ui, { registry: subagentInFlight });
```

- [ ] **Step 6: Run the full package gate (CI-equivalent) + biome on new files**

Run:
```bash
( cd bun-apps/pi-agent-ext-workflow && bunx biome check src/subagent-progress-widget.ts tests/subagent-progress-widget.test.ts tests/install-subagent-progress-widget.test.ts && bun run build && bun test )
```
Expected: biome clean on the three new files; `bun run build` (`bunx tsc`) exits 0; `bun test` — all pass (existing 1058 + new 11 = 1069, 0 fail). Note: the package's broader `bun run check` (biome over ALL files) is a documented pre-existing exclusion in CI and may still be red on unrelated files — that is expected and out of scope.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-workflow/src/subagent-progress-widget.ts bun-apps/pi-agent-ext-workflow/tests/install-subagent-progress-widget.test.ts bun-apps/pi-agent-ext-workflow/extensions/workflow.ts
git commit -m "feat(subagent-progress-widget): mount always-on panel at session_start (timer-driven)"
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- "widget strip / belowEditor / 1 line per agent + header" → Task 1 render (header + `renderActivityRow` per run).
- "idle → [] invisible" → Task 1 `if (running.length === 0) return []`.
- "reuse renderActivityRow + summarizeLatestAction (identical to /subagents)" → Task 1 imports + row construction (same `ActivityRow` shape as the viewer).
- "resolvedModel ?? model" → Task 1 `model: r.resolvedModel ?? r.model` (+ dedicated test).
- "register factory once; refresh via requestRender, not re-setWidget" → Task 2 (single `setWidget`, timer → `requestRender`).
- "timer start-once guard (pitfall)" → Task 2 `started` flag (+ dedicated test).
- "mount once at session_start" → Task 2 Step 5 (`installTaskPanel` neighbor).
- "safe no-op headless" → Task 2 guard (+ test).
- "test seam: pure class + fake-setWidget wiring" → Tasks 1 & 2 test files.
- "v1 does not touch subagent package" → confirmed: all files are in `pi-agent-ext-workflow`; no edit to `pi-agent-ext-subagent`.
- Out-of-scope items (overlay, transcript, token streaming) → intentionally no tasks. ✓

**2. Placeholder scan** — no TBD/TODO/"add error handling"; every code step shows complete code; every command shows expected output. ✓

**3. Type consistency** — `SubagentProgressWidget` constructor `{ getRunning }`, `render(theme: Theme): string[]`, `invalidate()` — used identically in Task 1 (class), Task 2 (wiring constructs `new SubagentProgressWidget({ getRunning: () => opts.registry.list() })`, calls `widget.render(theme)`), and both test files. `installSubagentProgressWidget(ui, opts)` signature matches across definition + test. Factory `(tui, theme) => { render, invalidate }` matches `display.ts` precedent. ✓

No gaps; no placeholders; types consistent. Plan is implementation-ready.

---

## Execution Handoff

Plan complete and saved to `.planning/2026-07-25-subagent-always-on-progress-widget/plan.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
