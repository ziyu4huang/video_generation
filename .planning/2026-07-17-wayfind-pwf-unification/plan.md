# wayfind + planning-with-files Status Widget Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify `pi-agent-ext-wayfind` and `pi-agent-ext-planning-with-files`'s competing TUI footer status lines into one composite widget (extending `pi-agent-ext-goal-todo`'s `PowerToolStatusWidget`), and collapse their 19 top-level slash commands into 3 subcommand dispatchers (`/grill`, `/wayfind`, `/plan`).

**Architecture:** `pi-agent-ext-goal-todo` becomes the shared status-widget substrate: its `PowerToolStatusWidget` is promoted from a per-instance class to a `globalThis`-backed process singleton (module-level singletons are NOT safe here — pi loads extensions via jiti, and jiti-loaded module identity is not guaranteed to match a native `import()` of the same package, the same reason the existing `__piWayfindActive` coordination seam uses `globalThis` instead of a shared import). wayfind and planning-with-files each take a real `workspace:*` dependency on goal-todo, add one `StatusSection` each (order 2 and 3, after goal=0 and todo=1), and replace every `ctx.ui.setStatus(PKG_NAME, ...)` call with an overlay-state update + `widget.update()`. Command consolidation is a separate, orthogonal change: each package's existing per-command handler bodies are preserved verbatim as private functions, and one dispatcher command per package routes on the first whitespace token of `args`.

**Tech Stack:** TypeScript, Bun workspaces (`workspace:*` protocol), `@earendil-works/pi-coding-agent` extension SDK, `bun test`.

---

## Task 1: Promote `PowerToolStatusWidget` to a `globalThis`-backed singleton with section ordering

**Files:**
- Modify: `bun-apps/pi-agent-ext-goal-todo/src/shared/status-widget.ts`
- Modify: `bun-apps/pi-agent-ext-goal-todo/extensions/pi-goal-todo.ts:50-57`
- Test: `bun-apps/pi-agent-ext-goal-todo/src/shared/__tests__/status-widget.test.ts`

- [ ] **Step 1: Write the failing tests for `order` and the singleton getter**

Add to the bottom of `bun-apps/pi-agent-ext-goal-todo/src/shared/__tests__/status-widget.test.ts` (before the final closing of the file — i.e. append these two `describe` blocks after the existing `composite + real overlays` block):

```ts
// ─── Section ordering by `order` field ─────────────────────────────────────

describe("PowerToolStatusWidget order field", () => {
	test("sections render sorted by `order`, independent of addSection call order", () => {
		const w = new PowerToolStatusWidget();
		const cap = captureWidget();
		w.setUICtx(cap.uiCtx as never);
		w.addSection({ id: "wayfind", order: 2, render: () => ["WAYFIND"] });
		w.addSection({ id: "goal", order: 0, render: () => ["GOAL"] });
		w.addSection({ id: "pwf", order: 3, render: () => ["PWF"] });
		w.addSection({ id: "todo", order: 1, render: () => ["TODO"] });
		w.update();
		expect(cap.render(40)).toEqual(["GOAL", "", "TODO", "", "WAYFIND", "", "PWF"]);
	});

	test("sections without `order` sort after ordered sections, in addSection order", () => {
		const w = new PowerToolStatusWidget();
		const cap = captureWidget();
		w.setUICtx(cap.uiCtx as never);
		w.addSection({ id: "goal", order: 0, render: () => ["GOAL"] });
		w.addSection({ id: "unordered-a", render: () => ["A"] });
		w.addSection({ id: "unordered-b", render: () => ["B"] });
		w.update();
		expect(cap.render(40)).toEqual(["GOAL", "", "A", "", "B"]);
	});
});

// ─── Singleton getter ───────────────────────────────────────────────────────

describe("getSharedStatusWidget", () => {
	test("returns the same instance across repeated calls", () => {
		const a = getSharedStatusWidget();
		const b = getSharedStatusWidget();
		expect(a).toBe(b);
	});

	test("the instance is stored on globalThis (survives module-identity gaps)", () => {
		const w = getSharedStatusWidget();
		expect((globalThis as Record<string, unknown>).__piPowerToolStatusWidget).toBe(w);
	});
});
```

Add `getSharedStatusWidget` to the import at the top of the test file:

```ts
import { PowerToolStatusWidget, getSharedStatusWidget } from "../status-widget.ts";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-goal-todo && bun test src/shared/__tests__/status-widget.test.ts )`
Expected: FAIL — `order` is not sorted (first new test fails on unsorted array), and `getSharedStatusWidget` is not exported (TypeScript/module error).

- [ ] **Step 3: Implement `order` field + sort in `renderAll`, and the `globalThis`-backed singleton getter**

Replace the full contents of `bun-apps/pi-agent-ext-goal-todo/src/shared/status-widget.ts` with:

```ts
/**
 * shared/status-widget.ts — single above-editor widget for the composite
 * status display (goal, todo, and now wayfind / planning-with-files),
 * rendered in a FIXED order.
 *
 * WHY ONE KEY (not one per feature):
 * The pi-coding-agent SDK stores above-editor widgets in a Map and renders them
 * via `widgets.values()` — i.e. JS Map INSERTION ORDER. There is no order/index
 * API on `setWidget`. Two separate keys (the old "pi-goal" + "rpiv-todos")
 * therefore stack in registration order, and whenever one is cleared
 * (`setWidget(key, undefined)`) and later re-registered it jumps to the END →
 * visible flicker/reorder while a /goal is active with a non-empty todo list.
 *
 * One composite key ("pi-power-tool") makes stacking deterministic by
 * construction: the only above-editor widget can't reorder relative to itself.
 * Sections render sorted by their `order` field (goal=0, todo=1, wayfind=2,
 * planning-with-files=3); sections without an explicit `order` sort after all
 * ordered sections, in `addSection` call order.
 *
 * WHY A `globalThis`-BACKED SINGLETON (not a module-level `let instance`):
 * pi loads extensions via jiti. Module identity across a jiti-loaded extension
 * and a native `import()` of the same package is NOT guaranteed — two
 * "instances" of this module can exist in the same process, each with its own
 * module-level `let instance`, so wayfind and planning-with-files could each
 * get a DIFFERENT widget and silently stop sharing state. `globalThis` is
 * process-singleton → always the same object regardless of which loader
 * resolved this module. Same rationale as the existing
 * `__piWayfindActive` / `__piGoalActive` coordination-seam keys.
 *
 * This is ALSO where all the widget lifecycle lives (setUICtx / register /
 * requestRender / dispose), so GoalOverlay, TodoOverlay, and any consumer
 * package's overlay no longer duplicate the `widgetRegistered` / `tui` /
 * stale-ctx machinery — they become thin state-holders that expose
 * `render(theme, width)` and call `setRefresh`'s callback when their content
 * changes.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI } from "@earendil-works/pi-tui";

const WIDGET_KEY = "pi-power-tool";
const SINGLETON_GLOBAL_KEY = "__piPowerToolStatusWidget";

export interface StatusSection {
	/** Stable id (dedupe + debug/ordering only). */
	id: string;
	/**
	 * Sort key, ascending. Sections sharing an `order` (or all omitting it)
	 * keep `addSection` call order relative to each other. Known assignments:
	 * goal=0, todo=1, wayfind=2, planning-with-files=3.
	 */
	order?: number;
	/** Render this section's lines. Empty array = section hidden. */
	render(theme: Theme, width: number): string[];
}

export class PowerToolStatusWidget {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private sections: StatusSection[] = [];

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx !== this.uiCtx) {
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	/**
	 * Register a section. Render order is by `order` ascending (ties, and
	 * sections without `order`, keep call order). Safe to call once per
	 * package per process — duplicate `id`s are ignored.
	 */
	addSection(section: StatusSection): void {
		if (!this.sections.some((s) => s.id === section.id)) this.sections.push(section);
	}

	/** Re-render. Call after any section's content changes. */
	update(): void {
		// Non-UI modes (RPC/CLI) have no widget surface — silently no-op.
		if (!this.uiCtx?.setWidget) return;
		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderAll(theme, width),
						invalidate: () => {
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	dispose(): void {
		this.sections = [];
		if (this.uiCtx?.setWidget) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	/**
	 * Sections sorted by `order` ascending (undefined sorts last, stable
	 * relative to addSection order via Array.prototype.sort's stability).
	 * Concatenate non-empty sections, inserting a blank line BETWEEN sections
	 * for visual separation. Trailing/leading spacers are handled by the SDK's
	 * widget container, so sections return only their own content lines.
	 */
	private renderAll(theme: Theme, width: number): string[] {
		const ordered = [...this.sections].sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER));
		const lines: string[] = [];
		for (const section of ordered) {
			const out = section.render(theme, width);
			if (out.length === 0) continue;
			if (lines.length > 0) lines.push("");
			lines.push(...out);
		}
		return lines;
	}
}

/**
 * Process-singleton accessor. See the class doc comment for why this is
 * `globalThis`-backed rather than a module-level `let instance`. Every
 * package that wants a section on the composite status widget (goal-todo
 * itself, wayfind, planning-with-files) calls this — never `new
 * PowerToolStatusWidget()` directly, or it will get its own disconnected
 * widget instance.
 */
export function getSharedStatusWidget(): PowerToolStatusWidget {
	const g = globalThis as Record<string, unknown>;
	if (!(g[SINGLETON_GLOBAL_KEY] instanceof PowerToolStatusWidget)) {
		g[SINGLETON_GLOBAL_KEY] = new PowerToolStatusWidget();
	}
	return g[SINGLETON_GLOBAL_KEY] as PowerToolStatusWidget;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-goal-todo && bun test src/shared/__tests__/status-widget.test.ts )`
Expected: PASS, all tests including the 4 new ones.

- [ ] **Step 5: Switch goal-todo's own extension to the singleton getter**

In `bun-apps/pi-agent-ext-goal-todo/extensions/pi-goal-todo.ts`, change the import (line 29):

```ts
import { PowerToolStatusWidget } from "../src/shared/status-widget.js";
```

to:

```ts
import { getSharedStatusWidget } from "../src/shared/status-widget.js";
```

And change lines 50-57 from:

```ts
	const statusWidget = new PowerToolStatusWidget();
	const goalOverlay = new GoalOverlay();
	const todoOverlay = new TodoOverlay();
	goal(pi, goalOverlay);
	goalOverlay.setRefresh(() => statusWidget.update());
	todoOverlay.setRefresh(() => statusWidget.update());
	statusWidget.addSection({ id: "goal", render: (t, w) => goalOverlay.render(t, w) });
	statusWidget.addSection({ id: "todo", render: (t, w) => todoOverlay.render(t, w) });
```

to:

```ts
	const statusWidget = getSharedStatusWidget();
	const goalOverlay = new GoalOverlay();
	const todoOverlay = new TodoOverlay();
	goal(pi, goalOverlay);
	goalOverlay.setRefresh(() => statusWidget.update());
	todoOverlay.setRefresh(() => statusWidget.update());
	statusWidget.addSection({ id: "goal", order: 0, render: (t, w) => goalOverlay.render(t, w) });
	statusWidget.addSection({ id: "todo", order: 1, render: (t, w) => todoOverlay.render(t, w) });
```

- [ ] **Step 6: Run the full goal-todo test suite**

Run: `( cd bun-apps/pi-agent-ext-goal-todo && bun test )`
Expected: PASS, 0 fail (the existing "composite + real overlays" integration test still passes since it constructs its own `new PowerToolStatusWidget()` directly, which remains a valid, independent instance for test isolation — only the extension entry point and future consumers use the singleton).

- [ ] **Step 7: Export the singleton getter from the package's public re-export surface**

Check whether `bun-apps/pi-agent-ext-goal-todo` has a top-level `src/index.ts`. It does not (only `extensions/pi-goal-todo.ts` is the entry point, and `package.json`'s `exports` map exposes `./src/*` directly). No re-export file changes are needed — downstream packages import `@repo/pi-agent-ext-goal-todo/src/shared/status-widget` directly, matching the existing `exports.["./src/*"]` mapping.

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-goal-todo/src/shared/status-widget.ts bun-apps/pi-agent-ext-goal-todo/src/shared/__tests__/status-widget.test.ts bun-apps/pi-agent-ext-goal-todo/extensions/pi-goal-todo.ts
git commit -m "feat(pi-agent-ext-goal-todo): promote status widget to a globalThis-backed singleton with section ordering"
```

---

## Task 2: wayfind — depend on goal-todo, add a status overlay, join the composite widget

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/package.json`
- Create: `bun-apps/pi-agent-ext-wayfind/src/overlay.ts`
- Create: `bun-apps/pi-agent-ext-wayfind/src/__tests__/overlay.test.ts`
- Modify: `bun-apps/pi-agent-ext-wayfind/src/commands.ts`
- Modify: `bun-apps/pi-agent-ext-wayfind/src/index.ts`

- [ ] **Step 1: Add the workspace dependency**

In `bun-apps/pi-agent-ext-wayfind/package.json`, add a `dependencies` block (there is currently none — only `peerDependencies` and `devDependencies`) right before `"peerDependencies"`:

```json
  "dependencies": {
    "@repo/pi-agent-ext-goal-todo": "workspace:*"
  },
```

- [ ] **Step 2: Install**

Run: `bun install`
Expected: lockfile updates, no errors.

- [ ] **Step 3: Write the failing overlay test**

Create `bun-apps/pi-agent-ext-wayfind/src/__tests__/overlay.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { WayfindOverlay } from "../overlay.js";

const plainTheme = {} as Theme;

describe("WayfindOverlay", () => {
  test("renders nothing before setLine is called", () => {
    const o = new WayfindOverlay();
    expect(o.render(plainTheme, 80)).toEqual([]);
  });

  test("renders the last line set via setLine", () => {
    const o = new WayfindOverlay();
    o.setLine("grill-me active: auth redesign");
    expect(o.render(plainTheme, 80)).toEqual(["grill-me active: auth redesign"]);
  });

  test("setLine calls the refresh callback", () => {
    const o = new WayfindOverlay();
    let refreshed = 0;
    o.setRefresh(() => refreshed++);
    o.setLine("wayfinder: charting auth-redesign");
    expect(refreshed).toBe(1);
  });

  test("dispose clears the line", () => {
    const o = new WayfindOverlay();
    o.setLine("grill ended");
    o.dispose();
    expect(o.render(plainTheme, 80)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test src/__tests__/overlay.test.ts )`
Expected: FAIL — `../overlay.js` does not exist.

- [ ] **Step 5: Implement the overlay**

Create `bun-apps/pi-agent-ext-wayfind/src/overlay.ts`:

```ts
/**
 * overlay.ts — wayfind's status-line section for the shared PowerToolStatusWidget
 * (owned by pi-agent-ext-goal-todo, see getSharedStatusWidget()).
 *
 * Replaces the previous direct ctx.ui.setStatus(PKG_NAME, text) calls scattered
 * across commands.ts — a single state-holder that renders one line into the
 * composite widget instead of a second, independent footer entry.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

export class WayfindOverlay {
  private line: string | undefined;
  private refresh: (() => void) | undefined;

  /** Register the composite widget's update() as the refresh callback. */
  setRefresh(fn: () => void): void {
    this.refresh = fn;
  }

  /** Set the current status line and trigger a re-render. */
  setLine(text: string): void {
    this.line = text;
    this.refresh?.();
  }

  /** Clear the section (session_shutdown). */
  dispose(): void {
    this.line = undefined;
  }

  /** Render the wayfind section (0 or 1 line). */
  render(_theme: Theme, _width: number): string[] {
    return this.line !== undefined ? [this.line] : [];
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test src/__tests__/overlay.test.ts )`
Expected: PASS.

- [ ] **Step 7: Wire the overlay into the composite widget from `src/index.ts`**

Replace the full contents of `bun-apps/pi-agent-ext-wayfind/src/index.ts` with:

```ts
/**
 * pi-agent-ext-wayfind — Pi-native port of Matt Pocock's decision-chain skill suite.
 *
 * The default factory registers the slash commands + publishes the coordination
 * seam (globalThis.__piWayfindActive) so pi-agent-ext-planning-with-files can
 * yield its injection/auto-continue during a live grill session — the same
 * process-singleton pattern planning-with-files uses for /goal. It also joins
 * the shared composite status widget owned by pi-agent-ext-goal-todo instead of
 * writing an independent ctx.ui.setStatus() footer line.
 *
 * Pure TypeScript: no python3, no shell. Loaded by Pi via the `pi.extensions`
 * manifest in package.json; all logic lives in `src/`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSharedStatusWidget } from "@repo/pi-agent-ext-goal-todo/src/shared/status-widget";
import { endGrillForSession, registerCommands } from "./commands.js";
import { publishWayfindActive } from "./coordination.js";
import { WayfindOverlay } from "./overlay.js";
import { createRuntimeState, getSessionId } from "./state.js";

export default function wayfindExtension(pi: ExtensionAPI): void {
  const state = createRuntimeState();
  const widget = getSharedStatusWidget();
  const overlay = new WayfindOverlay();
  overlay.setRefresh(() => widget.update());
  widget.addSection({ id: "wayfind", order: 2, render: (t, w) => overlay.render(t, w) });

  // Publish the coordination seam up-front (inactive until a grill starts).
  // planning-with-files reads globalThis.__piWayfindActive to decide whether to
  // yield during a live grill. The closure reads live RuntimeState, so it always
  // returns the current value without re-publishing on every change.
  publishWayfindActive(state);

  registerCommands(pi, state, overlay);

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      widget.setUICtx(ctx.ui);
      widget.update();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    // Clear this session's grill + refresh/unpublish the seam, mirroring
    // planning-with-files' session_shutdown cleanup.
    endGrillForSession(state, getSessionId(ctx));
    overlay.dispose();
  });
}

// Re-export pure helpers for downstream packages / tests.
export { PKG_NAME, WAYFIND_ACTIVE_KEY } from "./constants.js";
export {
  isWayfindActivePublished,
  publishWayfindActive,
  readPlanIncomplete,
  readPlanSummary,
  unpublishWayfindActive,
} from "./coordination.js";
export { buildGrillPriming, buildPlanSeed, parseGlossary } from "./grill.js";
export { WayfindOverlay } from "./overlay.js";
export {
  createRuntimeState,
  isAnyWayfindSessionActive,
  isGrillActive,
  type RuntimeState,
} from "./state.js";
```

- [ ] **Step 8: Replace every `ctx.ui.setStatus(PKG_NAME, ...)` call in `commands.ts` with `overlay.setLine(...)`, and thread `overlay` through `registerCommands`**

Open `bun-apps/pi-agent-ext-wayfind/src/commands.ts`. Change the function signature (line 25) from:

```ts
export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
```

to:

```ts
export function registerCommands(pi: ExtensionAPI, state: RuntimeState, overlay: WayfindOverlay): void {
```

Add the import at the top (after the existing `PKG_NAME` import):

```ts
import type { WayfindOverlay } from "./overlay.js";
```

Then replace every occurrence of `ctx.ui.setStatus(PKG_NAME, ` with `overlay.setLine(` throughout the file (9 call sites: inside `grill-me`, `grill-me-with-docs`, `grill-done`, `domain-modeling`, `plan-seed`, `to-spec`, `to-tickets`, and twice inside `wayfinder`). Run this exact substitution:

```bash
sed -i '' 's/ctx\.ui\.setStatus(PKG_NAME, /overlay.setLine(/g' bun-apps/pi-agent-ext-wayfind/src/commands.ts
```

Then verify no call sites remain unconverted and that `PKG_NAME` is still used elsewhere (in `ctx.ui.notify` calls, which stay untouched):

Run: `grep -n "ctx.ui.setStatus" bun-apps/pi-agent-ext-wayfind/src/commands.ts`
Expected: no output (zero matches).

Run: `grep -n "overlay.setLine" bun-apps/pi-agent-ext-wayfind/src/commands.ts`
Expected: 9 matches.

- [ ] **Step 9: Fix up the `sed`-introduced signature mismatches**

The `sed` substitution turns e.g. `ctx.ui.setStatus(PKG_NAME, \`grill-me active${...}\`)` into `overlay.setLine(\`grill-me active${...}\`)` — this is already correct because `setStatus(key, text)` and `setLine(text)` differ by exactly the leading `PKG_NAME, ` argument that the `sed` pattern already strips. Confirm the file still type-checks:

Run: `( cd bun-apps/pi-agent-ext-wayfind && bunx tsc --noEmit )`
Expected: no errors. If any call site has a trailing `)` mismatch (unlikely, since `sed` only replaces the function-name-plus-first-arg prefix, not parens), fix it by hand — inspect the reported line/column.

- [ ] **Step 10: Fix the two remaining `registerCommands` call sites in tests**

Run: `grep -rln "registerCommands(pi" bun-apps/pi-agent-ext-wayfind/src` and update every test call site found (besides `commands.ts` itself) to pass a `new WayfindOverlay()` as the third argument, e.g. change `registerCommands(pi, state)` to `registerCommands(pi, state, new WayfindOverlay())`, adding `import { WayfindOverlay } from "../overlay.js";` (adjust the relative path to match the test file's location) to each such test file.

- [ ] **Step 11: Run the full wayfind test suite**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test )`
Expected: PASS, 0 fail.

- [ ] **Step 12: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind/package.json bun-apps/pi-agent-ext-wayfind/src/overlay.ts bun-apps/pi-agent-ext-wayfind/src/__tests__/overlay.test.ts bun-apps/pi-agent-ext-wayfind/src/commands.ts bun-apps/pi-agent-ext-wayfind/src/index.ts bun.lock
git commit -m "feat(pi-agent-ext-wayfind): join the shared composite status widget instead of an independent footer line"
```

---

## Task 3: planning-with-files — depend on goal-todo, add a status overlay, join the composite widget

**Files:**
- Modify: `bun-apps/pi-agent-ext-planning-with-files/package.json`
- Create: `bun-apps/pi-agent-ext-planning-with-files/src/overlay.ts`
- Create: `bun-apps/pi-agent-ext-planning-with-files/src/__tests__/overlay.test.ts`
- Modify: `bun-apps/pi-agent-ext-planning-with-files/src/runtime.ts`
- Modify: `bun-apps/pi-agent-ext-planning-with-files/src/commands.ts`

- [ ] **Step 1: Move the existing `@repo/pi-agent-ext-wayfind` dev dependency's pattern to a real runtime dependency on goal-todo**

In `bun-apps/pi-agent-ext-planning-with-files/package.json`, add a `dependencies` block (currently there is none) right before `"peerDependencies"`:

```json
  "dependencies": {
    "@repo/pi-agent-ext-goal-todo": "workspace:*"
  },
```

(Leave the existing `"@repo/pi-agent-ext-wayfind": "workspace:*"` in `devDependencies` untouched — it is unrelated, used for cross-package test-time typing.)

- [ ] **Step 2: Install**

Run: `bun install`
Expected: lockfile updates, no errors.

- [ ] **Step 3: Write the failing overlay test**

Create `bun-apps/pi-agent-ext-planning-with-files/src/__tests__/overlay.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { PlanningOverlay } from "../overlay.js";

const plainTheme = {} as Theme;

describe("PlanningOverlay", () => {
  test("renders nothing before setLine is called", () => {
    const o = new PlanningOverlay();
    expect(o.render(plainTheme, 80)).toEqual([]);
  });

  test("renders the last line set via setLine", () => {
    const o = new PlanningOverlay();
    o.setLine("2/4 phases complete");
    expect(o.render(plainTheme, 80)).toEqual(["2/4 phases complete"]);
  });

  test("setLine calls the refresh callback", () => {
    const o = new PlanningOverlay();
    let refreshed = 0;
    o.setRefresh(() => refreshed++);
    o.setLine("No active plan");
    expect(refreshed).toBe(1);
  });

  test("dispose clears the line", () => {
    const o = new PlanningOverlay();
    o.setLine("Plan closed (via /plan-done)");
    o.dispose();
    expect(o.render(plainTheme, 80)).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-planning-with-files && bun test src/__tests__/overlay.test.ts )`
Expected: FAIL — `../overlay.js` does not exist.

- [ ] **Step 5: Implement the overlay**

Create `bun-apps/pi-agent-ext-planning-with-files/src/overlay.ts`:

```ts
/**
 * overlay.ts — planning-with-files' status-line section for the shared
 * PowerToolStatusWidget (owned by pi-agent-ext-goal-todo, see
 * getSharedStatusWidget()).
 *
 * Replaces the previous direct ctx.ui.setStatus(PKG_NAME, text) calls scattered
 * across runtime.ts and commands.ts — a single state-holder that renders one
 * line into the composite widget instead of a second, independent footer
 * entry. The yield message ("... — /goal or /grill driving, injection
 * yielded") is preserved as visible text here — it is useful information, not
 * noise; only the footer-line duplication goes away.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

export class PlanningOverlay {
  private line: string | undefined;
  private refresh: (() => void) | undefined;

  /** Register the composite widget's update() as the refresh callback. */
  setRefresh(fn: () => void): void {
    this.refresh = fn;
  }

  /** Set the current status line and trigger a re-render. */
  setLine(text: string): void {
    this.line = text;
    this.refresh?.();
  }

  /** Clear the section (session_shutdown). */
  dispose(): void {
    this.line = undefined;
  }

  /** Render the planning-with-files section (0 or 1 line). */
  render(_theme: Theme, _width: number): string[] {
    return this.line !== undefined ? [this.line] : [];
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-planning-with-files && bun test src/__tests__/overlay.test.ts )`
Expected: PASS.

- [ ] **Step 7: Wire the overlay into `runtime.ts`**

In `bun-apps/pi-agent-ext-planning-with-files/src/runtime.ts`:

Add imports (after the existing `import { registerCommands } from "./commands.js";` line):

```ts
import { getSharedStatusWidget } from "@repo/pi-agent-ext-goal-todo/src/shared/status-widget";
import { PlanningOverlay } from "./overlay.js";
```

Inside `planningWithFilesExtension`, right after `const state: RuntimeState = createRuntimeState();` (line 153), add:

```ts
  const widget = getSharedStatusWidget();
  const overlay = new PlanningOverlay();
  overlay.setRefresh(() => widget.update());
  widget.addSection({ id: "planning-with-files", order: 3, render: (t, w) => overlay.render(t, w) });
```

Change `registerCommands(pi, state);` (line 170) to:

```ts
  registerCommands(pi, state, overlay);
```

At the top of the `session_start` handler (after `clearSessionExecutionApprovals(state, sessionId);`, before the `isAttachedSession` check), add the widget UI-context wiring, matching goal-todo's pattern:

```ts
    if (ctx.hasUI) {
      widget.setUICtx(ctx.ui);
      widget.update();
    }
```

Add `overlay.dispose();` at the end of the `session_shutdown` handler body (after `clearSessionExecutionApprovals(state, sessionId);`).

Then replace every remaining `ctx.ui.setStatus(PKG_NAME, ` in the rest of the file with `overlay.setLine(`:

```bash
sed -i '' 's/ctx\.ui\.setStatus(PKG_NAME, /overlay.setLine(/g' bun-apps/pi-agent-ext-planning-with-files/src/runtime.ts
```

Run: `grep -n "ctx.ui.setStatus" bun-apps/pi-agent-ext-planning-with-files/src/runtime.ts`
Expected: no output.

Run: `grep -n "overlay.setLine" bun-apps/pi-agent-ext-planning-with-files/src/runtime.ts`
Expected: 13 matches.

- [ ] **Step 8: Thread `overlay` through `registerCommands` and replace the 5 `setStatus` call sites in `commands.ts`**

In `bun-apps/pi-agent-ext-planning-with-files/src/commands.ts`, change the function signature (line 53) from:

```ts
export function registerCommands(pi: ExtensionAPI, state: RuntimeState): void {
```

to:

```ts
export function registerCommands(pi: ExtensionAPI, state: RuntimeState, overlay: PlanningOverlay): void {
```

Add the import (near the top, alongside the other local imports):

```ts
import type { PlanningOverlay } from "./overlay.js";
```

Then run the same substitution as Task 2 Step 8:

```bash
sed -i '' 's/ctx\.ui\.setStatus(PKG_NAME, /overlay.setLine(/g' bun-apps/pi-agent-ext-planning-with-files/src/commands.ts
```

Run: `grep -n "ctx.ui.setStatus" bun-apps/pi-agent-ext-planning-with-files/src/commands.ts`
Expected: no output.

Run: `grep -n "overlay.setLine" bun-apps/pi-agent-ext-planning-with-files/src/commands.ts`
Expected: 5 matches.

- [ ] **Step 9: Type-check**

Run: `( cd bun-apps/pi-agent-ext-planning-with-files && bunx tsc --noEmit )`
Expected: no errors.

- [ ] **Step 10: Fix the remaining `registerCommands` call sites in tests**

Run: `grep -rln "registerCommands(pi" bun-apps/pi-agent-ext-planning-with-files/src` and update every test call site found (besides `commands.ts` itself) to pass a `new PlanningOverlay()` as the third argument, adding the corresponding `import { PlanningOverlay } from "../overlay.js";` to each.

- [ ] **Step 11: Run the full planning-with-files test suite**

Run: `( cd bun-apps/pi-agent-ext-planning-with-files && bun test )`
Expected: PASS, 0 fail.

- [ ] **Step 12: Commit**

```bash
git add bun-apps/pi-agent-ext-planning-with-files/package.json bun-apps/pi-agent-ext-planning-with-files/src/overlay.ts bun-apps/pi-agent-ext-planning-with-files/src/__tests__/overlay.test.ts bun-apps/pi-agent-ext-planning-with-files/src/runtime.ts bun-apps/pi-agent-ext-planning-with-files/src/commands.ts bun.lock
git commit -m "feat(pi-agent-ext-planning-with-files): join the shared composite status widget instead of an independent footer line"
```

---

## Task 4: wayfind — consolidate 10 commands into `/grill` and `/wayfind` dispatchers

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/src/commands.ts`
- Test: `bun-apps/pi-agent-ext-wayfind/src/__tests__/commands.test.ts` (create if no existing command-dispatch test file — check first with `find bun-apps/pi-agent-ext-wayfind/src -iname "*command*test*"`)

- [ ] **Step 1: Write the failing dispatcher-routing tests**

Create (or extend, if a `commands.test.ts` already exists) `bun-apps/pi-agent-ext-wayfind/src/__tests__/commands.test.ts` with at minimum:

```ts
import { describe, expect, test, mock } from "bun:test";
import { registerCommands } from "../commands.js";
import { createRuntimeState } from "../state.js";
import { WayfindOverlay } from "../overlay.js";

function fakePi() {
  const handlers = new Map<string, (args: string, ctx: unknown) => unknown>();
  return {
    pi: {
      registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => unknown }) => {
        handlers.set(name, opts.handler);
      },
      sendUserMessage: mock(() => {}),
    } as never,
    handlers,
  };
}

function fakeCtx(sessionId = "s1") {
  return {
    cwd: "/tmp/does-not-matter",
    sessionManager: { getSessionId: () => sessionId },
    ui: { setStatus: mock(() => {}), notify: mock(() => {}) },
  } as never;
}

describe("/grill dispatcher", () => {
  test("routes 'me <topic>' to the grill-me handler (starts a grill)", async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi, createRuntimeState(), new WayfindOverlay());
    const grill = handlers.get("grill")!;
    await grill("me auth redesign", fakeCtx());
    expect(pi.sendUserMessage).toHaveBeenCalled();
  });

  test("unknown subcommand prints usage, does not throw", async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi, createRuntimeState(), new WayfindOverlay());
    const grill = handlers.get("grill")!;
    const ctx = fakeCtx();
    await expect(grill("bogus", ctx)).resolves.not.toThrow();
    expect(ctx.ui.notify).toHaveBeenCalled();
  });
});

describe("/wayfind dispatcher", () => {
  test("routes 'status' to the wayfinder-status handler", async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi, createRuntimeState(), new WayfindOverlay());
    const wayfind = handlers.get("wayfind")!;
    const ctx = fakeCtx();
    await wayfind("status", ctx);
    expect(ctx.ui.notify).toHaveBeenCalled(); // "Usage: ..." since no active effort
  });

  test("a bare destination (no keyword match) charts a new map", async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi, createRuntimeState(), new WayfindOverlay());
    const wayfind = handlers.get("wayfind")!;
    await wayfind("Redesign the auth flow", fakeCtx());
    expect(pi.sendUserMessage).toHaveBeenCalled();
  });
});
```

(If a `commands.test.ts` already exists with fixtures for `fakePi`/`fakeCtx`, reuse those fixtures instead of redefining them, adjusting the exact shape to match.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test src/__tests__/commands.test.ts )`
Expected: FAIL — `handlers.get("grill")` / `handlers.get("wayfind")` is `undefined` (no such command registered yet).

- [ ] **Step 3: Restructure `commands.ts` into private handlers + two dispatchers**

Replace the full contents of `bun-apps/pi-agent-ext-wayfind/src/commands.ts` with:

```ts
/**
 * Slash commands registered by pi-agent-ext-wayfind.
 *
 *   /grill me [topic]          — kick off a grilling session (interview only)
 *   /grill docs [topic]        — flagship: grilling + domain-modeling (paper trail)
 *   /grill done [--seed-plan]  — end the grill; optionally seed a task_plan.md
 *   /grill domain              — kick off the glossary + ADR discipline directly
 *
 *   /wayfind <destination>     — chart a new map, or (no args) work the next frontier ticket
 *   /wayfind status [effort]   — show the frontier + ticket counts
 *   /wayfind spec [effort]     — synthesize the conversation into a spec (was /to-spec)
 *   /wayfind tickets [effort]  — break a spec into tracer-bullet tickets (was /to-tickets)
 *   /wayfind seed [effort]     — seed a task_plan.md from tickets/decisions (was /plan-seed)
 *   /wayfind sync [effort]     — close tickets whose pwf phase completed (was /chain-sync)
 *
 * Each subcommand's logic lives in its own private handler function, unchanged
 * from the pre-consolidation per-command registrations — only the routing
 * layer (two `pi.registerCommand` calls instead of ten) is new.
 *
 * Type-only imports keep this module cycle-free with index.ts.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { seedPlan, syncChainState } from "./chain.js";
import { PKG_NAME } from "./constants.js";
import {
  publishWayfindActive,
  publishWayfindGrill,
  unpublishWayfindActive,
  unpublishWayfindGrill,
} from "./coordination.js";
import { buildGrillPriming } from "./grill.js";
import type { WayfindOverlay } from "./overlay.js";
import { getSessionId, isGrillActive, type RuntimeState } from "./state.js";
import { chartMap, claimNextTicket, renderStatus, slugify, statusReport } from "./wayfinder.js";

const WAYFIND_KEYWORDS = new Set(["status", "spec", "tickets", "seed", "sync"]);

export function registerCommands(pi: ExtensionAPI, state: RuntimeState, overlay: WayfindOverlay): void {
  /** Shared kickoff: set the active-grill state, refresh the published seam, and
   *  send the priming user-message so the agent enters grilling mode. */
  function startGrill(ctx: ExtensionCommandContext, topic: string, withDocs: boolean): void {
    const sessionId = ctx.sessionManager.getSessionId();
    state.activeGrillBySession.set(sessionId, topic || "(current conversation)");
    state.grillWithDocsBySession.set(sessionId, withDocs);
    publishWayfindActive(state);
    publishWayfindGrill(state);
    const priming = buildGrillPriming(topic || undefined, withDocs);
    pi.sendUserMessage(priming, { deliverAs: "steer" });
  }

  async function handleGrillMe(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const topic = args.trim();
    startGrill(ctx, topic, false);
    overlay.setLine(`grill-me active${topic ? `: ${topic}` : ""}`);
    ctx.ui.notify(
      `[${PKG_NAME}] grill-me started${topic ? ` (${topic})` : ""}. planning-with-files will yield while the grill is active.`,
      "info",
    );
  }

  async function handleGrillDocs(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const topic = args.trim();
    startGrill(ctx, topic, true);
    overlay.setLine(`grill-me-with-docs active${topic ? `: ${topic}` : ""}`);
    ctx.ui.notify(
      [
        `[${PKG_NAME}] grill-me-with-docs started${topic ? ` (${topic})` : ""}.`,
        "Resolving terms will be written to CONTEXT.md; hard-to-reverse decisions offered as ADRs.",
        "End with /grill done (or /grill done --seed-plan to hand off to planning-with-files).",
      ].join("\n"),
      "info",
    );
  }

  async function handleGrillDone(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    if (!isGrillActive(state, sessionId)) {
      ctx.ui.notify(`[${PKG_NAME}] No active grill session to end.`, "info");
      return;
    }

    const topic = state.activeGrillBySession.get(sessionId);
    state.activeGrillBySession.delete(sessionId);
    state.grillWithDocsBySession.delete(sessionId);
    publishWayfindActive(state);
    overlay.setLine("grill ended");

    const seed = args.includes("--seed-plan") || args.includes("seed-plan");
    if (!seed) {
      ctx.ui.notify(`[${PKG_NAME}] Grill ended.`, "info");
      return;
    }

    const outcome = seedPlan(ctx.cwd, { topic });
    if (!outcome) {
      ctx.ui.notify(
        `[${PKG_NAME}] --seed-plan: nothing to seed (no CONTEXT.md decisions, no glossary, no topic).`,
        "warning",
      );
      return;
    }
    if ("refused" in outcome) {
      ctx.ui.notify(
        `[${PKG_NAME}] --seed-plan: ${outcome.refused} already exists — run /plan done --delete first to re-seed.`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      `[${PKG_NAME}] Seeded ${outcome.path} (${outcome.phaseCount} phase(s), source: ${outcome.source}).`,
      "info",
    );
    pi.sendUserMessage(
      `Grill ended. I seeded ${outcome.path} from ${outcome.source}. Review the phases, then run /plan execute (planning-with-files).`,
      { deliverAs: "steer" },
    );
  }

  async function handleGrillDomain(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    pi.sendUserMessage(
      [
        "Starting a domain-modeling session.",
        "Load the `domain-modeling` skill: actively build the project's glossary + ADRs.",
        "Challenge terms against CONTEXT.md, sharpen fuzzy language, probe edge cases, cross-reference the code.",
        "Write resolved terms to CONTEXT.md inline (glossary only — no implementation details).",
        "Offer an ADR only when a decision is hard-to-reverse + surprising-without-context + a real trade-off.",
      ].join("\n"),
      { deliverAs: "steer" },
    );
    overlay.setLine("domain-modeling active");
  }

  async function handleChainSync(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = args.trim() || state.activeEffortBySession.get(sessionId);
    if (!effort) {
      ctx.ui.notify(`Usage: /wayfind sync <effort>  (or run /wayfind <destination> first)`, "warning");
      return;
    }
    const r = syncChainState(ctx.cwd, effort);
    if (r.closed.length > 0) {
      ctx.ui.notify(`[${PKG_NAME}] Closed ${r.closed.length} ticket(s): ${r.closed.join(", ")}.`, "info");
    } else {
      ctx.ui.notify(
        `[${PKG_NAME}] sync: nothing to close${r.skipped.length > 0 ? ` (skipped: ${r.skipped.join(", ")})` : ""}.`,
        "info",
      );
    }
  }

  async function handleWayfindSeed(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = args.trim() || state.activeEffortBySession.get(sessionId);
    if (!effort) {
      ctx.ui.notify(`Usage: /wayfind seed <effort>  (or run /wayfind <destination> first)`, "warning");
      return;
    }
    const outcome = seedPlan(ctx.cwd, { effort });
    if (!outcome) {
      ctx.ui.notify(`[${PKG_NAME}] seed: nothing to seed (no tickets, no CONTEXT.md decisions).`, "warning");
      return;
    }
    if ("refused" in outcome) {
      ctx.ui.notify(
        `[${PKG_NAME}] seed: ${outcome.refused} already exists — run /plan done --delete first to re-seed.`,
        "warning",
      );
      return;
    }
    overlay.setLine(`seed: ${effort} (${outcome.source})`);
    ctx.ui.notify(
      `[${PKG_NAME}] Seeded ${outcome.path} (${outcome.phaseCount} phase(s), source: ${outcome.source}).`,
      "info",
    );
    pi.sendUserMessage(
      `Seeded ${outcome.path} from ${outcome.source}. Review the phases, then run /plan execute (planning-with-files).`,
      { deliverAs: "steer" },
    );
  }

  async function handleToSpec(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const effort = args.trim() || undefined;
    pi.sendUserMessage(
      [
        "Synthesizing a spec from the current conversation.",
        "Load the `to-spec` skill: turn what's already on the table into a spec (PRD) — no interview, just synthesis.",
        "Use the project's CONTEXT.md glossary vocabulary; respect ADRs in the area you touch.",
        effort
          ? `Write the spec to .planning/${effort}/spec.md.`
          : "Write the spec to .planning/<effort>/spec.md (or docs/specs/<slug>.md).",
        "Tell me the path when written. The natural next step is /wayfind tickets, then /wayfind seed → /plan execute.",
      ].join("\n"),
      { deliverAs: "steer" },
    );
    overlay.setLine(`spec${effort ? `: ${effort}` : ""}`);
  }

  async function handleToTickets(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const effort = args.trim() || undefined;
    pi.sendUserMessage(
      [
        "Breaking the work into tracer-bullet tickets.",
        "Load the `to-tickets` skill: vertical slices, each declaring its blocking edges.",
        effort
          ? `Write one ticket per file under .planning/${effort}/tickets/ (NN-slug.md).`
          : "Write one ticket per file under .planning/<effort>/tickets/ (NN-slug.md).",
        "Use the UNIFIED ticket format: YAML frontmatter (type/blocking/status) + ## Question + ## What to build + ## Acceptance — the same schema wayfinder uses (parseTicketFile reads it).",
        "Then flatten the frontier into a task_plan.md with /wayfind seed, and run /plan execute (planning-with-files).",
      ].join("\n"),
      { deliverAs: "steer" },
    );
    overlay.setLine(`tickets${effort ? `: ${effort}` : ""}`);
  }

  async function handleWayfinderStatus(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const effort = args.trim() || state.activeEffortBySession.get(sessionId);
    if (!effort) {
      ctx.ui.notify("Usage: /wayfind status <effort>  (or run /wayfind <destination> first)", "warning");
      return;
    }
    syncChainState(ctx.cwd, effort);
    const r = statusReport(ctx.cwd, effort);
    if (!r) {
      ctx.ui.notify(`No map at .planning/${effort}/map.md`, "warning");
      return;
    }
    ctx.ui.notify(renderStatus(r), "info");
  }

  async function handleWayfinderChart(destination: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);

    if (!destination) {
      const effort = state.activeEffortBySession.get(sessionId);
      if (!effort) {
        ctx.ui.notify(
          `Usage: /wayfind <destination> to chart a new map, or set an active effort first.`,
          "warning",
        );
        return;
      }
      syncChainState(ctx.cwd, effort);
      const claimed = claimNextTicket(ctx.cwd, effort, sessionId);
      if (!claimed) {
        const r = statusReport(ctx.cwd, effort);
        ctx.ui.notify(
          r
            ? `${renderStatus(r)}\nNo unclaimed frontier ticket — chart more or resolve claimed ones.`
            : `No map at .planning/${effort}/`,
          "info",
        );
        return;
      }
      state.activeEffortBySession.set(sessionId, effort);
      publishWayfindActive(state);
      overlay.setLine(`wayfinder: ${effort} — ticket ${claimed.id} ${claimed.title}`);
      pi.sendUserMessage(
        [
          `Working wayfinder ticket ${claimed.id} "${claimed.title}" on effort ${effort}.`,
          `Load the \`wayfinder\` skill. Ticket type: ${claimed.type}.`,
          `Question: ${claimed.question}`,
          "Resolve it (one ticket this session): record the answer, then close the ticket + append to the map's Decisions so far. Graduate any newly-specifiable fog into fresh tickets.",
        ].join("\n"),
        { deliverAs: "steer" },
      );
      return;
    }

    const effort = slugify(destination);
    chartMap(ctx.cwd, effort, destination);
    state.activeEffortBySession.set(sessionId, effort);
    publishWayfindActive(state);
    overlay.setLine(`wayfinder: charting ${effort}`);
    ctx.ui.notify(`[${PKG_NAME}] Map created at .planning/${effort}/map.md`, "info");
    pi.sendUserMessage(
      [
        `Charting a wayfinder map for: ${destination}`,
        "Load the `wayfinder` skill (chart-the-map mode).",
        "1. Grill to pin the destination + scope. 2. Map the frontier breadth-first — surface open decisions + first takeable steps. 3. If no fog surfaces, the journey is small enough to skip the map (tell me). 4. Otherwise create tickets under .planning/" +
          effort +
          "/tickets/ (one file each, wired with blocking edges).",
      ].join("\n"),
      { deliverAs: "steer" },
    );
  }

  pi.registerCommand("grill", {
    description:
      "Grilling family: 'me [topic]' (interview only), 'docs [topic]' (flagship, + CONTEXT.md/ADRs), 'done [--seed-plan]', 'domain' (glossary+ADR discipline directly)",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const remainder = rest.join(" ");
      switch (sub) {
        case "me":
          return handleGrillMe(remainder, ctx);
        case "docs":
          return handleGrillDocs(remainder, ctx);
        case "done":
          return handleGrillDone(remainder, ctx);
        case "domain":
          return handleGrillDomain(remainder, ctx);
        default:
          ctx.ui.notify("Usage: /grill me|docs|done|domain [args]", "warning");
      }
    },
  });

  pi.registerCommand("wayfind", {
    description:
      "Wayfinder family: '<destination>' (chart a map) or no args (work next ticket); 'status'/'spec'/'tickets'/'seed'/'sync' [effort]",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [first, ...rest] = trimmed.split(/\s+/);
      const remainder = rest.join(" ");
      if (first && WAYFIND_KEYWORDS.has(first)) {
        switch (first) {
          case "status":
            return handleWayfinderStatus(remainder, ctx);
          case "spec":
            return handleToSpec(remainder, ctx);
          case "tickets":
            return handleToTickets(remainder, ctx);
          case "seed":
            return handleWayfindSeed(remainder, ctx);
          case "sync":
            return handleChainSync(remainder, ctx);
        }
      }
      return handleWayfinderChart(trimmed, ctx);
    },
  });
}

/** Clear the active grill/effort for a session (called on session_shutdown in index.ts). */
export function endGrillForSession(state: RuntimeState, sessionId: string): void {
  state.activeGrillBySession.delete(sessionId);
  state.grillWithDocsBySession.delete(sessionId);
  state.activeEffortBySession.delete(sessionId);
  publishWayfindActive(state);
  if (state.activeGrillBySession.size === 0 && state.activeEffortBySession.size === 0) {
    unpublishWayfindGrill();
    unpublishWayfindActive();
  }
}
```

- [ ] **Step 4: Run the dispatcher tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bun test src/__tests__/commands.test.ts )`
Expected: PASS.

- [ ] **Step 5: Type-check and run the full suite**

Run: `( cd bun-apps/pi-agent-ext-wayfind && bunx tsc --noEmit && bun test )`
Expected: PASS, 0 fail. Fix any pre-existing test that still asserts on the old command names (`grill-me`, `wayfinder-status`, etc.) by updating it to call the new dispatcher with the equivalent subcommand.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind/src/commands.ts bun-apps/pi-agent-ext-wayfind/src/__tests__/commands.test.ts
git commit -m "refactor(pi-agent-ext-wayfind): consolidate 10 commands into /grill and /wayfind dispatchers"
```

---

## Task 5: planning-with-files — consolidate 9 commands into a `/plan` dispatcher

**Files:**
- Modify: `bun-apps/pi-agent-ext-planning-with-files/src/commands.ts`
- Test: `bun-apps/pi-agent-ext-planning-with-files/src/__tests__/commands.test.ts` (create if none exists — check first with `find bun-apps/pi-agent-ext-planning-with-files/src -iname "*command*test*"`)

- [ ] **Step 1: Write the failing dispatcher-routing tests**

Create (or extend) `bun-apps/pi-agent-ext-planning-with-files/src/__tests__/commands.test.ts`:

```ts
import { describe, expect, test, mock } from "bun:test";
import { registerCommands } from "../commands.js";
import { createRuntimeState } from "../state.js";
import { PlanningOverlay } from "../overlay.js";

function fakePi() {
  const handlers = new Map<string, (args: string, ctx: unknown) => unknown>();
  return {
    pi: {
      registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => unknown }) => {
        handlers.set(name, opts.handler);
      },
      sendMessage: mock(() => {}),
      sendUserMessage: mock(() => {}),
    } as never,
    handlers,
  };
}

function fakeCtx(cwd = "/tmp/does-not-matter", sessionId = "s1") {
  return {
    cwd,
    sessionManager: { getSessionId: () => sessionId },
    ui: { setStatus: mock(() => {}), notify: mock(() => {}) },
  } as never;
}

describe("/plan dispatcher", () => {
  test("routes 'status' to the plan-status handler", async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi, createRuntimeState(), new PlanningOverlay());
    const plan = handlers.get("plan")!;
    const ctx = fakeCtx();
    await plan("status", ctx);
    expect(ctx.ui.notify).toHaveBeenCalled(); // "No active plan" in a tmp dir with no task_plan.md
  });

  test("routes 'goal <text>' to the plan-goal handler", async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi, createRuntimeState(), new PlanningOverlay());
    const plan = handlers.get("plan")!;
    const ctx = fakeCtx();
    await plan("goal all tests pass", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Plan goal set"), "info");
  });

  test("unknown subcommand prints usage, does not throw", async () => {
    const { pi, handlers } = fakePi();
    registerCommands(pi, createRuntimeState(), new PlanningOverlay());
    const plan = handlers.get("plan")!;
    const ctx = fakeCtx();
    await expect(plan("bogus", ctx)).resolves.not.toThrow();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage"), "warning");
  });
});
```

(If a `commands.test.ts` already exists with its own `fakePi`/`fakeCtx` fixtures — e.g. ones that create a real temp dir with `task_plan.md` for the file-touching commands — reuse and extend those instead of redefining new ones.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-planning-with-files && bun test src/__tests__/commands.test.ts )`
Expected: FAIL — `handlers.get("plan")` is `undefined`.

- [ ] **Step 3: Restructure `commands.ts` into private handlers + one dispatcher**

Replace the full contents of `bun-apps/pi-agent-ext-planning-with-files/src/commands.ts` with:

```ts
/**
 * Slash commands registered by the planning-with-files extension.
 *
 *   /plan status                     — show phase counts for the active plan
 *   /plan execute [reset]            — approve the active plan & activate the hooks
 *   /plan done [--delete]            — close the active plan (stop all nags)
 *   /plan attest [--show|--clear]    — SHA-256 lock the active plan
 *   /plan goal <text>                — set/clear the auto-continue goal condition
 *   /plan loop [interval]            — start/stop periodic plan-loop ticks
 *   /plan list                       — list all plans under .planning/ (+ root)
 *   /plan lint [--all]               — diagnose a plan
 *   /plan switch <id>                — pin the active plan
 *
 * Each subcommand's logic lives in its own private handler function, unchanged
 * from the pre-consolidation per-command registrations — only the routing
 * layer (one `pi.registerCommand` call instead of nine) is new.
 *
 * Type-only imports from `./runtime.js` (RuntimeState) are erased at compile
 * time, so this module does NOT create a runtime ESM cycle with runtime.ts.
 */

import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { attestPlan, buildTamperMessage, checkPlanAttestation } from "./attestation.js";
import {
  CLOSE_MARKER_COMMENT,
  CLOSE_MARKER_NOTE,
  DEFAULT_GOAL_CONDITION,
  DEFAULT_LOOP_INTERVAL_MS,
  DEFAULT_LOOP_PROMPT,
  PKG_NAME,
} from "./constants.js";
import { enumeratePlans, lintAllPlans, lintPlan, renderPlanList, switchActivePlan } from "./lifecycle.js";
import { deriveEffectiveMode, resolveConfiguredMode } from "./modes.js";
import { isAllPhasesComplete, isCloseMarker, readPlanStatus, resolvePlanPaths, summarizePlan } from "./plan.js";
import { checkCompleteReport } from "./scripts.js";
import type { PlanningOverlay } from "./overlay.js";
import { getPlanSessionKey, getSessionId, type RuntimeState } from "./state.js";
import { injectionTokenCost } from "./tokens.js";

/** Parse an interval spec like "10m", "30s", "2h", "1d" → milliseconds. */
export function parseIntervalSpec(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.trim().match(/^(\d+)([smhd])$/i);
  if (!match) return undefined;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return undefined;

  const factors: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * factors[unit];
}

const PLAN_KEYWORDS = new Set(["status", "execute", "done", "attest", "goal", "loop", "list", "lint", "switch"]);

export function registerCommands(pi: ExtensionAPI, state: RuntimeState, overlay: PlanningOverlay): void {
  async function handleStatus(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    const status = readPlanStatus(ctx.cwd);
    if (!status.exists) {
      ctx.ui.notify("No active plan (task_plan.md not found)", "warning");
      return;
    }
    const mode = deriveEffectiveMode(resolveConfiguredMode(ctx.cwd), ctx);
    const cost = injectionTokenCost(status, mode);
    ctx.ui.notify(checkCompleteReport(ctx.cwd, cost.label), "info");
  }

  async function handleList(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    ctx.ui.notify(renderPlanList(enumeratePlans(ctx.cwd)), "info");
  }

  async function handleLint(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const all = ["--all", "all"].includes(args.trim().toLowerCase());
    const reports = all ? lintAllPlans(ctx.cwd) : [lintPlan(ctx.cwd)];
    for (const r of reports) {
      const lines = [
        `[${PKG_NAME}] ${r.planPath}`,
        ...r.findings.map((f) => `  ${f.level.toUpperCase()} ${f.code}: ${f.message}`),
      ];
      ctx.ui.notify(lines.join("\n"), r.ok ? "info" : "warning");
    }
  }

  async function handleSwitch(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const id = args.trim();
    if (!id) {
      ctx.ui.notify("Usage: /plan switch <plan-id>  (or /plan switch root to clear the pin)", "warning");
      return;
    }
    const res = switchActivePlan(ctx.cwd, id);
    ctx.ui.notify(res.message, res.ok ? "info" : "error");
  }

  async function handleAttest(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const flag = args.trim().toLowerCase();
    const mode =
      flag === "--show" || flag === "show" ? "show" : flag === "--clear" || flag === "clear" ? "clear" : "attest";
    const result = attestPlan(ctx.cwd, mode);
    ctx.ui.notify(result.message, result.ok ? "info" : "error");
  }

  async function handleGoal(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const normalized = args.trim();
    if (!normalized || ["clear", "off", "disable"].includes(normalized.toLowerCase())) {
      state.goalBySession.delete(sessionId);
      ctx.ui.notify("Plan goal cleared", "info");
      return;
    }

    const goal = normalized === "default" ? DEFAULT_GOAL_CONDITION : normalized;
    state.goalBySession.set(sessionId, goal);
    ctx.ui.notify(`Plan goal set: ${goal}`, "info");
  }

  async function handleExecute(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const status = readPlanStatus(ctx.cwd);
    if (!status.exists) {
      ctx.ui.notify("No active plan (task_plan.md not found)", "warning");
      return;
    }

    const planKey = getPlanSessionKey(ctx, status);
    const normalized = args.trim().toLowerCase();
    if (["clear", "off", "reset", "disable"].includes(normalized)) {
      state.executionApprovedBySessionPlan.delete(planKey);
      ctx.ui.notify(`Plan execution approval cleared: ${summarizePlan(status)}`, "info");
      overlay.setLine(`${summarizePlan(status)} — run /plan execute to activate hooks`);
      return;
    }

    const attestation = checkPlanAttestation(status);
    if (attestation.tampered) {
      ctx.ui.notify(buildTamperMessage(status), "error");
      return;
    }

    state.executionApprovedBySessionPlan.add(planKey);
    overlay.setLine(`${summarizePlan(status)} — hooks active`);
    ctx.ui.notify(
      [
        `Plan execution approved: ${summarizePlan(status)}`,
        `Plan path: ${status.planPath}`,
        "planning-with-files hooks are now active for this session and plan.",
      ].join("\n"),
      "info",
    );
  }

  async function handleDone(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const status = readPlanStatus(ctx.cwd);
    if (!status.exists || !status.planPath) {
      ctx.ui.notify("No active plan (task_plan.md not found) — nothing to close.", "info");
      return;
    }

    const flag = args.trim().toLowerCase();

    if (flag === "--delete" || flag === "delete" || flag === "rm") {
      const paths = resolvePlanPaths(ctx.cwd);
      const targets: string[] = [];
      if (paths.scope === "scoped" && paths.planDir) {
        targets.push(paths.planDir);
      } else {
        for (const f of [paths.planPath, paths.progressPath, paths.findingsPath]) {
          if (f && existsSync(f)) targets.push(f);
        }
        const rootAttest = paths.attestationCandidates[0];
        if (rootAttest && existsSync(rootAttest)) targets.push(rootAttest);
      }
      state.executionApprovedBySessionPlan.delete(getPlanSessionKey(ctx, status));
      state.goalBySession.delete(getSessionId(ctx));
      for (const t of targets) {
        try {
          rmSync(t, { recursive: true, force: true });
        } catch {
          // best-effort; report what we can below
        }
      }
      overlay.setLine("No active plan");
      ctx.ui.notify(`[planning-with-files] Plan deleted: ${targets.join(", ")}`, "info");
      return;
    }

    const existing = (() => {
      try {
        return readFileSync(status.planPath, "utf-8");
      } catch {
        return "";
      }
    })();
    if (isCloseMarker(existing)) {
      state.executionApprovedBySessionPlan.delete(getPlanSessionKey(ctx, status));
      overlay.setLine("Plan closed (via /plan done)");
      ctx.ui.notify(`[planning-with-files] Plan already closed: ${status.planPath}`, "info");
      return;
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const block = `\n\n---\n${CLOSE_MARKER_COMMENT}\n${CLOSE_MARKER_NOTE} (${stamp})\n`;
    try {
      appendFileSync(status.planPath, block, "utf-8");
    } catch (err) {
      ctx.ui.notify(`[planning-with-files] Could not write close marker: ${String(err)}`, "error");
      return;
    }
    state.executionApprovedBySessionPlan.delete(getPlanSessionKey(ctx, status));
    state.goalBySession.delete(getSessionId(ctx));
    overlay.setLine("Plan closed (via /plan done)");
    ctx.ui.notify(
      [
        `[planning-with-files] Plan closed: ${summarizePlan(readPlanStatus(ctx.cwd))}`,
        `Marked: ${status.planPath}`,
        "Hooks deactivated for this plan. Run /plan done --delete to remove the files, or delete the close marker to reactivate.",
      ].join("\n"),
      "info",
    );
  }

  async function handleLoop(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const sessionId = getSessionId(ctx);
    const raw = args.trim();

    if (["stop", "off", "clear", "disable"].includes(raw.toLowerCase())) {
      const timer = state.loopTimersBySession.get(sessionId);
      if (timer) clearInterval(timer);
      state.loopTimersBySession.delete(sessionId);
      ctx.ui.notify("plan-loop stopped", "info");
      return;
    }

    const parts = raw ? raw.split(/\s+/) : [];
    const maybeInterval = parseIntervalSpec(parts[0]);
    const intervalMs = maybeInterval ?? DEFAULT_LOOP_INTERVAL_MS;
    const prompt = maybeInterval ? parts.slice(1).join(" ").trim() : parts.join(" ").trim();
    const tickPrompt = prompt || DEFAULT_LOOP_PROMPT;

    const existing = state.loopTimersBySession.get(sessionId);
    if (existing) clearInterval(existing);

    const timer = setInterval(() => {
      const status = readPlanStatus(ctx.cwd);
      if (!status.exists) return;

      if (status.closed || isAllPhasesComplete(status)) {
        const active = state.loopTimersBySession.get(sessionId);
        if (active) clearInterval(active);
        state.loopTimersBySession.delete(sessionId);
        pi.sendMessage({
          customType: PKG_NAME,
          content: `[${PKG_NAME}] plan-loop stopped: ${summarizePlan(status)}.`,
          display: true,
        });
        return;
      }

      try {
        pi.sendUserMessage(tickPrompt, { deliverAs: "followUp" });
      } catch {
        // best-effort loop tick, ignore transient send errors
      }
    }, intervalMs);

    state.loopTimersBySession.set(sessionId, timer);
    ctx.ui.notify(`plan-loop started (${Math.round(intervalMs / 1000)}s)`, "info");
  }

  pi.registerCommand("plan", {
    description:
      "Planning-with-files family: 'status'/'execute [reset]'/'done [--delete]'/'attest [--show|--clear]'/'goal <text>'/'loop [interval]'/'list'/'lint [--all]'/'switch <id>'",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [sub, ...rest] = trimmed.split(/\s+/);
      const remainder = rest.join(" ");
      if (!sub || !PLAN_KEYWORDS.has(sub)) {
        ctx.ui.notify(
          "Usage: /plan status|execute|done|attest|goal|loop|list|lint|switch [args]",
          "warning",
        );
        return;
      }
      switch (sub) {
        case "status":
          return handleStatus(remainder, ctx);
        case "execute":
          return handleExecute(remainder, ctx);
        case "done":
          return handleDone(remainder, ctx);
        case "attest":
          return handleAttest(remainder, ctx);
        case "goal":
          return handleGoal(remainder, ctx);
        case "loop":
          return handleLoop(remainder, ctx);
        case "list":
          return handleList(remainder, ctx);
        case "lint":
          return handleLint(remainder, ctx);
        case "switch":
          return handleSwitch(remainder, ctx);
      }
    },
  });
}
```

- [ ] **Step 4: Run the dispatcher tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-planning-with-files && bun test src/__tests__/commands.test.ts )`
Expected: PASS.

- [ ] **Step 5: Type-check and run the full suite**

Run: `( cd bun-apps/pi-agent-ext-planning-with-files && bunx tsc --noEmit && bun test )`
Expected: PASS, 0 fail. Fix any pre-existing test that still asserts on the old command names (`plan-status`, `plan-execute`, etc.) by updating it to call the new `/plan` dispatcher with the equivalent subcommand.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-planning-with-files/src/commands.ts bun-apps/pi-agent-ext-planning-with-files/src/__tests__/commands.test.ts
git commit -m "refactor(pi-agent-ext-planning-with-files): consolidate 9 commands into a /plan dispatcher"
```

---

## Task 6: Update docs, wayfind's own references to renamed commands, and add the ADR

**Files:**
- Modify: `bun-apps/pi-agent-ext-wayfind/README.md`
- Modify: `bun-apps/pi-agent-ext-wayfind/CONTEXT.md`
- Modify: `bun-apps/pi-agent-ext-planning-with-files/README.md`
- Modify: `bun-apps/pi-agent-ext-planning-with-files/CONTEXT.md`
- Modify: `bun-apps/pi-agent-ext-wayfind/src/grill.ts` (check for embedded `/grill-done`, `/plan-execute`, `/to-tickets` etc. references in prompt-building strings)
- Modify: `bun-apps/pi-agent-ext-wayfind/src/chain.ts` (same check)
- Create: `bun-apps/pi-agent-ext-wayfind/docs/adr/0002-shared-status-widget-and-command-consolidation.md` (create the `docs/adr/` directory if it does not already exist — check with `find bun-apps/pi-agent-ext-wayfind/docs -type d`)

- [ ] **Step 1: Find every remaining reference to an old command name across both packages' non-code files and source-embedded prompt strings**

Run:
```bash
grep -rn "grill-me\|grill-me-with-docs\|grill-done\|domain-modeling\b\|/wayfinder\b\|/wayfinder-status\|/to-spec\|/to-tickets\|/plan-seed\|/chain-sync\|/plan-status\|/plan-attest\|/plan-goal\|/plan-execute\|/plan-done\|/plan-loop\|/plan-list\|/plan-lint\|/plan-switch" bun-apps/pi-agent-ext-wayfind bun-apps/pi-agent-ext-planning-with-files --include="*.md" --include="*.ts"
```
Note every match outside of the already-rewritten `commands.ts` files (those will show old names in `switch`/`case` labels or private function names — that's expected, ignore matches inside `commands.ts` itself). The high-value hits to fix are inside `grill.ts`'s `buildGrillPriming` return string and `chain.ts`, since those are user-visible agent-steering text, plus both `README.md` and `CONTEXT.md` command tables.

- [ ] **Step 2: Update `grill.ts` and `chain.ts` embedded command references**

Open each flagged file from Step 1 and replace old slash-command references with their new subcommand form (e.g. `/grill-done` → `/grill done`, `/plan-execute` → `/plan execute`, `/to-tickets` → `/wayfind tickets`). Keep every other line unchanged.

- [ ] **Step 3: Update `bun-apps/pi-agent-ext-wayfind/README.md`**

Replace the `## Commands` table (10 rows) with:

```markdown
## Commands

| command | what it does |
|---|---|
| `/grill me [topic]` | kick off a plain grilling interview (no artifacts) |
| `/grill docs [topic]` | **flagship** — grilling + writes `CONTEXT.md` glossary + ADRs inline; publishes the coordination seam |
| `/grill done [--seed-plan]` | end the grill; `--seed-plan` reads `CONTEXT.md` + writes a `task_plan.md` seed (handoff to planning-with-files) |
| `/grill domain` | kick off the glossary + ADR discipline directly |
| `/wayfind [destination]` | chart a new map under `.planning/<effort>/`; (no args) work the next frontier ticket |
| `/wayfind status [effort]` | show the frontier + open/closed/claimed/fog counts |
| `/wayfind spec [effort]` | synthesize the conversation + codebase into a spec (PRD) at `.planning/<effort>/spec.md` |
| `/wayfind tickets [effort]` | break a spec/plan into tracer-bullet tickets (unified spine format) under `.planning/<effort>/tickets/` |
| `/wayfind seed [effort]` | route-aware: flatten tickets (topo-sorted, `[ticket-id]` phase headers) or CONTEXT.md decisions into a `task_plan.md`; refuses to overwrite |
| `/wayfind sync [effort]` | close wayfind tickets whose planning-with-files phase reported complete (the loop's feedback half) |
```

Also update the `| 10 slash commands |` row in the "What it does" table near the top to `| 2 slash commands (subcommand-routed) |`, and update every inline `/grill-me-with-docs` / `/to-tickets` / `/plan-seed` style reference elsewhere in the file (the "flagship" section, the "Where it fits" diagram caption, and the "Coordination with planning-with-files" prose) to the new `/grill docs`, `/wayfind tickets`, `/wayfind seed` forms.

- [ ] **Step 4: Update `bun-apps/pi-agent-ext-wayfind/CONTEXT.md`**

In the `grill→plan handoff` glossary entry, replace `` `/grill-done --seed-plan` `` with `` `/grill done --seed-plan` ``. Scan the rest of the file for any other old-form command references and update them the same way.

- [ ] **Step 5: Update `bun-apps/pi-agent-ext-planning-with-files/README.md`**

Replace the `| 9 slash commands |` table row (in "What it does") from listing all 9 individual commands to:

```markdown
| 1 slash command (subcommand-routed) | `/plan status\|execute\|done\|attest\|goal\|loop\|list\|lint\|switch` |
```

Update every individual `/plan-status`, `/plan-execute [reset]`, `/plan-done [--delete]`, `/plan-attest [--show\|--clear]`, `/plan-goal`, `/plan-loop [interval] [prompt]`, `/plan-list`, `/plan-lint [--all]`, `/plan-switch <id>` reference throughout the rest of the file (Usage section, Workflow A-F examples, PLI v2 table, "Practical tips") to their `/plan <subcommand>` form, e.g. `/plan-execute reset` → `/plan execute reset`, `/plan-attest --show` → `/plan attest --show`.

- [ ] **Step 6: Update `bun-apps/pi-agent-ext-planning-with-files/CONTEXT.md`**

Scan for `/plan-*` references (the `/plan-execute` gate and `/plan-done` close-out glossary entries) and update to `/plan execute` / `/plan done`.

- [ ] **Step 7: Write the ADR**

Check for an existing ADR directory and next available number:

Run: `find bun-apps/pi-agent-ext-wayfind/docs -type d 2>/dev/null; find bun-apps/pi-agent-ext-wayfind -iname "0*-*.md" 2>/dev/null`

If `docs/adr/` doesn't exist yet, create `bun-apps/pi-agent-ext-wayfind/docs/adr/0001-shared-status-widget-and-command-consolidation.md` (adjust the number if an ADR 0001 already exists elsewhere for this package — the existing "ADR-0001" referenced throughout the README/CONTEXT for the reverse chain-sync seam lives in `pi-agent-ext-planning-with-files`'s or a shared location; check with `grep -rl "ADR-0001" bun-apps/pi-agent-ext-wayfind bun-apps/pi-agent-ext-planning-with-files` first and number this new one accordingly, e.g. `0002-...` if `0001-...` already exists):

```markdown
# ADR-000X: Shared status widget + command consolidation across wayfind and planning-with-files

Date: 2026-07-17
Status: accepted

## Context

wayfind and planning-with-files each wrote directly to the TUI footer via
`ctx.ui.setStatus(PKG_NAME, text)`. Both status lines rendered simultaneously,
even while the existing `globalThis` coordination seam had one side yielding
to the other — yielding only changed the yielding side's text, it never hid
the line. Separately, the two packages exposed 19 top-level slash commands
with overlapping naming intent (wayfind's `/plan-seed` read as part of
planning-with-files' `/plan-*` namespace).

## Decision

1. Promote `pi-agent-ext-goal-todo`'s `PowerToolStatusWidget` to a
   `globalThis`-backed singleton (`getSharedStatusWidget()`), exposed via the
   package's existing `./src/*` export map. wayfind and planning-with-files
   take a `workspace:*` dependency on goal-todo and each register one
   `StatusSection` (order 2 and 3, after goal=0/todo=1) instead of an
   independent footer line.
2. Consolidate wayfind's 10 commands into `/grill [me|docs|done|domain]` and
   `/wayfind [<destination>|status|spec|tickets|seed|sync]`, and
   planning-with-files' 9 commands into
   `/plan [status|execute|done|attest|goal|loop|list|lint|switch]`. Old
   command names are removed with no aliases — this is an internal dev-tool
   CLI, not a public API.

## Consequences

- wayfind and planning-with-files now hard-depend on goal-todo for status
  display; if goal-todo is not loaded, their status sections simply never
  render (no fallback to standalone `setStatus`). Acceptable because
  goal-todo is already the earliest-loaded core package in
  `bun-apps/pi-agent/run-dir/manifest.json`.
- The singleton MUST be `globalThis`-backed, not a module-level `let
  instance` — pi loads extensions via jiti, and jiti-loaded module identity is
  not guaranteed to match a native `import()` of the same package (the same
  reason the pre-existing `__piWayfindActive` / `__piGoalActive` coordination
  keys use `globalThis`). A module-level singleton would silently give
  wayfind and planning-with-files disconnected widget instances.
- Breaking, hard-to-reverse change for anyone with muscle memory around the
  old command names — no aliases are kept. Full spec:
  `docs/superpowers/specs/2026-07-17-wayfind-pwf-status-widget-unification-design.md`.
  Full implementation plan:
  `docs/superpowers/plans/2026-07-17-wayfind-pwf-status-widget-unification.md`.
```

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-wayfind/README.md bun-apps/pi-agent-ext-wayfind/CONTEXT.md bun-apps/pi-agent-ext-wayfind/src/grill.ts bun-apps/pi-agent-ext-wayfind/src/chain.ts bun-apps/pi-agent-ext-wayfind/docs bun-apps/pi-agent-ext-planning-with-files/README.md bun-apps/pi-agent-ext-planning-with-files/CONTEXT.md
git commit -m "docs: update wayfind + planning-with-files docs and add the consolidation ADR"
```

---

## Task 7: Full-suite regression pass + manual TUI verification

**Files:** none (verification only)

- [ ] **Step 1: Run every touched package's full test suite**

Run:
```bash
( cd bun-apps/pi-agent-ext-goal-todo && bun test )
( cd bun-apps/pi-agent-ext-wayfind && bun test )
( cd bun-apps/pi-agent-ext-planning-with-files && bun test )
```
Expected: all three PASS, 0 fail.

- [ ] **Step 2: Type-check all three packages**

Run:
```bash
( cd bun-apps/pi-agent-ext-goal-todo && bunx tsc --noEmit )
( cd bun-apps/pi-agent-ext-wayfind && bunx tsc --noEmit )
( cd bun-apps/pi-agent-ext-planning-with-files && bunx tsc --noEmit )
```
Expected: no errors in any package.

- [ ] **Step 3: Confirm zero remaining old-name command registrations**

Run: `grep -rn 'registerCommand("grill-me"\|registerCommand("grill-me-with-docs"\|registerCommand("grill-done"\|registerCommand("domain-modeling"\|registerCommand("wayfinder"\|registerCommand("wayfinder-status"\|registerCommand("to-spec"\|registerCommand("to-tickets"\|registerCommand("plan-seed"\|registerCommand("chain-sync"\|registerCommand("plan-status"\|registerCommand("plan-list"\|registerCommand("plan-lint"\|registerCommand("plan-switch"\|registerCommand("plan-attest"\|registerCommand("plan-goal"\|registerCommand("plan-execute"\|registerCommand("plan-done"\|registerCommand("plan-loop"' bun-apps/pi-agent-ext-wayfind/src bun-apps/pi-agent-ext-planning-with-files/src`
Expected: no output.

- [ ] **Step 4: Manual TUI smoke test**

Run: `bun run --cwd bun-apps/pi-agent-cli dev` (or the project's documented `pi` launch command — check `bun-apps/pi-agent-cli/package.json` scripts if `dev` doesn't exist) in an interactive terminal, in a scratch directory with no existing `.planning/` or `task_plan.md`. Exercise, in order:

1. `/grill docs test the widget merge` — confirm the footer shows exactly ONE composite widget block (not two independent status lines), with a wayfind line visible.
2. `/grill done` — confirm the wayfind line updates to "grill ended" within the same composite widget.
3. Create a minimal `task_plan.md` (e.g. `printf '# Test Plan\n\n### Phase 1\nStatus: pending\n' > task_plan.md`), then run `/plan status` — confirm a planning-with-files line appears below any goal/todo/wayfind lines in the same widget, not as a second footer block.
4. `/plan execute` — confirm the planning-with-files line updates to "... — hooks active" in place, no flicker/reorder of the other sections.

Expected: throughout all four steps, the footer never shows more than one above-editor composite widget block, and section order stays goal → todo → wayfind → planning-with-files regardless of which section's text changes.

- [ ] **Step 5: Report results**

If Step 4 reveals any visual regression (flicker, duplicate widget, wrong order), stop and file it as a bug before considering this plan complete — do not proceed to a final "done" claim without this manual check, since none of the automated tests in Tasks 1-6 render the real SDK `setWidget` pipeline end-to-end.
