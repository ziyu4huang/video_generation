# Core-Task Loop 3 — `/loop` Process Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/loop` process loop (metric + metricless) to `pi-agent-ext-core-task` as a new `src/loop/` subsystem, branching the shared `agent_end` driver and reusing existing liveness/repetition/persistence infra.

**Architecture:** New sibling module `src/loop/` (mirrors `src/goal/`'s modular split: pure state → pure metric → pure commands → persistence → overlay → orchestration). `goal.ts`'s `agent_end` hook gains a top-of-handler branch dispatching to `runLoopTick` when a loop is active; loop and goal are mutually exclusive. The existing heartbeat/wedge layer is generalized to supervise whichever driver is active.

**Tech Stack:** TypeScript (Bun runtime), `@earendil-works/pi-coding-agent` extension API, `bun test`. Zero `@earendil-works/pi-ai` deps (inline/derive types — see overflow.ts/auditor.ts precedent).

**Spec:** `docs/superpowers/specs/2026-07-26-core-task-loop-3-design.md`

## Global Constraints

- **Pure modules first.** `loop-state.ts`, `loop-metric.ts` (parseMetric only), `loop-commands.ts`, `loop-persistence.ts` have ZERO `@earendil-works/*` imports — unit-testable under plain `bun test` (mirror `goal/state.ts`, `goal/shield.ts`, `goal/list.ts`).
- **DRY reuse.** Reuse `tokenize`/`parseTokenBudget` from `goal/commands.js`; `detectLoopStuck`/`loopInterventionDirective`/`pushCapped` from `goal/repetition.js`; `backoffMs`/`shouldHeartbeatRefire`/`shouldWedgeAlert`/`accountTurnForNudges` + constants from `goal/backoff.js`; `findFinalAssistantMessage`/`isRetryableGoalInterruption`/`isGoalContextOverflow` from `goal/overflow.js`. Do NOT reimplement.
- **No `@earendil-works/pi-ai` dep.** Derive/inline types locally (precedent: `goal/overflow.ts`, `goal/auditor.ts` `AuditorModel`).
- **Run from the worktree root:** all `bun test` / `tsc` commands run inside `bun-apps/pi-agent-ext-core-task/` via `( cd bun-apps/pi-agent-ext-core-task && ... )` — never top-level `cd`.
- **`.js` extensions in relative imports** (NodeNext ESM — every `./foo` import is `./foo.js`).
- **TDD:** every task writes the failing test first, runs it red, implements, runs it green, commits.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `src/loop/loop-state.ts` | `LoopState`/`LoopMeasure` types, pure state helpers (`createLoop`, `applyMeasurement`, `applyMetriclessTick`, `isBoundedStop`, `stopLoop`), `LoopRuntimeState` singleton + `__resetLoopState`. Zero pi imports. | Create |
| `src/loop/loop-metric.ts` | `parseMetric(stdout)` (pure) + `runMeasure(api, cmd, cwd, timeout)` via `pi.exec`. | Create |
| `src/loop/loop-commands.ts` | `parseLoopCommand`, `parseDuration`, arg completions. Pure. | Create |
| `src/loop/loop-persistence.ts` | `persistLoop`/`clearPersistedLoop`/`loadLoopFromSession`. Mirror `goal/persistence.ts`. | Create |
| `src/loop/overlay.ts` | `LoopOverlay` state-holder + `render` (1 status line) + stop flash. Mirror `goal/overlay.ts`. | Create |
| `src/loop/loop.ts` | `runLoopTick` control flow, `parseHypothesis`, `buildLoopContinuationPrompt`, `startLoop`/`stopLoop`/`showLoop`, `registerLoop`, `isLoopActive`. | Create |
| `src/loop/__tests__/*.test.ts` | Unit + integration tests for each module. | Create |
| `src/goal/goal.ts` | `agent_end` branch → `runLoopTick`; `syncHeartbeatTimer` generalized to supervise goal XOR loop. | Modify |
| `extensions/core-task.ts` | Import + `registerLoop`; add `loop` widget section; `session_start`/`session_compact` loop load; dispose. | Modify |

---

## Task 1: `loop-state.ts` — pure model + runtime singleton

**Files:**
- Create: `src/loop/loop-state.ts`
- Test: `src/loop/__tests__/loop-state.test.ts`

**Interfaces:**
- Consumes: `pushCapped` from `../goal/repetition.js` (pure).
- Produces: `LoopState`, `LoopMeasure`, `LoopMode`, `LoopVerdict`, `LoopStopReason`, `LoopRuntimeState`, `loopState`, `__resetLoopState`, `createLoop`, `applyMeasurement`, `applyMetriclessTick`, `isBoundedStop`, `stopLoop`, `cloneLoop`, `isLoop`.

- [ ] **Step 1: Write the failing test**

```ts
// src/loop/__tests__/loop-state.test.ts
import { test, expect } from "bun:test";
import {
	createLoop, applyMeasurement, applyMetriclessTick, isBoundedStop, stopLoop,
	__resetLoopState, loopState, type LoopState,
} from "../loop-state.js";

test("createLoop builds an active metric loop with defaults", () => {
	const l = createLoop({ target: "harden security", mode: "metric", measureCmd: "echo 5", direction: "higher" });
	expect(l.active).toBe(true);
	expect(l.mode).toBe("metric");
	expect(l.iteration).toBe(0);
	expect(l.maxIterations).toBe(0);
	expect(l.stallCount).toBe(0);
	expect(l.bestValue).toBeUndefined();
	expect(l.plateauWindow).toBe(5);
	expect(l.history).toEqual([]);
});

test("applyMeasurement: first reading is the baseline (improved, no stall)", () => {
	const l = createLoop({ target: "t", mode: "metric", measureCmd: "c", direction: "higher" });
	const next = applyMeasurement(l, 10, "h1");
	expect(next.bestValue).toBe(10);
	expect(next.lastValue).toBe(10);
	expect(next.stallCount).toBe(0);
	expect(next.history.at(-1)?.verdict).toBe("improved");
});

test("applyMeasurement: higher-direction improvement resets stall", () => {
	let l = createLoop({ target: "t", mode: "metric", measureCmd: "c", direction: "higher" });
	l = applyMeasurement(l, 10, "h1");
	l = applyMeasurement(l, 8, "h2");   // regress vs best -> plateau-eligible
	expect(l.stallCount).toBe(1);
	l = applyMeasurement(l, 12, "h3");  // new best
	expect(l.bestValue).toBe(12);
	expect(l.stallCount).toBe(0);
	expect(l.history.at(-1)?.verdict).toBe("improved");
});

test("applyMeasurement: lower-direction treats smaller as better", () => {
	let l = createLoop({ target: "t", mode: "metric", measureCmd: "c", direction: "lower" });
	l = applyMeasurement(l, 100, "h1");
	l = applyMeasurement(l, 90, "h2");
	expect(l.bestValue).toBe(90);
	expect(l.stallCount).toBe(0);
	l = applyMeasurement(l, 95, "h3");
	expect(l.stallCount).toBe(1);
});

test("applyMetriclessTick logs iteration + hypothesis, no value", () => {
	let l = createLoop({ target: "t", mode: "metricless" });
	l = applyMetriclessTick(l, "try X");
	expect(l.history.at(-1)).toMatchObject({ hypothesis: "try X", verdict: "metricless" });
	expect(l.history.at(-1)?.value).toBeUndefined();
});

test("isBoundedStop hits max/time/tokens/plateau in priority order", () => {
	const base = createLoop({ target: "t", mode: "metric", measureCmd: "c", direction: "higher", maxIterations: 2 });
	expect(isBoundedStop({ ...base, iteration: 2 })).toBe("max");
	const t = { ...base, maxIterations: 0, timeLimitMs: 1000, startedAt: Date.now() - 2000 };
	expect(isBoundedStop(t)).toBe("time");
	const tok = { ...base, maxIterations: 0, tokenBudget: 100, tokensUsed: 150 };
	expect(isBoundedStop(tok)).toBe("tokens");
	const plat = { ...base, maxIterations: 0, stallCount: 5, plateauWindow: 5 };
	expect(isBoundedStop(plat)).toBe("plateau");
	expect(isBoundedStop({ ...base, maxIterations: 0 })).toBeUndefined();
});

test("history is FIFO-capped at 50", () => {
	let l = createLoop({ target: "t", mode: "metricless" });
	for (let i = 0; i < 60; i++) l = applyMetriclessTick(l, `h${i}`);
	expect(l.history.length).toBe(50);
	expect(l.history[0]?.hypothesis).toBe("h10");
});

test("stopLoop sets active=false + stopReason", () => {
	const l = stopLoop(createLoop({ target: "t", mode: "metricless" }), "user");
	expect(l.active).toBe(false);
	expect(l.stopReason).toBe("user");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/loop-state.test.ts )`
Expected: FAIL — `Cannot find module "../loop-state.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/loop/loop-state.ts
/**
 * Loop 3 — process-loop state. Pure model + runtime singleton.
 * Zero @earendil-works/* imports (mirror goal/state.ts) so it is unit-testable
 * under plain bun. The orchestration/coordination seam lives in loop.ts.
 */
import { randomUUID } from "crypto";
import { pushCapped, type ToolResultPrint } from "../goal/repetition.js";

export type LoopMode = "metric" | "metricless";
export type LoopVerdict = "improved" | "plateau" | "regressed" | "metricless";
export type LoopStopReason = "user" | "max" | "time" | "tokens" | "plateau" | "measure-error" | "repetition" | "error";
export type LoopDirection = "higher" | "lower";

export interface LoopMeasure {
	iteration: number;
	at: number;
	value?: number;
	hypothesis: string;
	verdict: LoopVerdict;
}

export interface LoopState {
	id: string;
	target: string;
	mode: LoopMode;
	measureCmd?: string;
	direction: LoopDirection;
	iteration: number;
	maxIterations: number;
	timeLimitMs?: number;
	tokenBudget?: number;
	tokensUsed: number;
	bestValue?: number;
	lastValue?: number;
	plateauWindow: number;
	stallCount: number;
	history: LoopMeasure[];
	startedAt: number;
	active: boolean;
	stopReason?: LoopStopReason;
}

export const HISTORY_CAP = 50;
export const DEFAULT_PLATEAU_WINDOW = 5;

export interface CreateLoopArgs {
	target: string;
	mode: LoopMode;
	measureCmd?: string;
	direction?: LoopDirection;
	maxIterations?: number;
	timeLimitMs?: number;
	tokenBudget?: number;
	plateauWindow?: number;
}

export function createLoop(args: CreateLoopArgs): LoopState {
	const now = Date.now();
	return {
		id: randomUUID(),
		target: args.target,
		mode: args.mode,
		measureCmd: args.measureCmd,
		direction: args.direction ?? "higher",
		iteration: 0,
		maxIterations: args.maxIterations ?? 0,
		timeLimitMs: args.timeLimitMs,
		tokenBudget: args.tokenBudget,
		tokensUsed: 0,
		plateauWindow: args.plateauWindow ?? DEFAULT_PLATEAU_WINDOW,
		stallCount: 0,
		history: [],
		startedAt: now,
		active: true,
	};
}

function isBetter(newValue: number, best: number | undefined, direction: LoopDirection): boolean {
	if (best === undefined) return true; // first reading is the baseline
	return direction === "higher" ? newValue > best : newValue < best;
}

/** Apply a metric reading. First reading is the baseline (improved, no stall). */
export function applyMeasurement(loop: LoopState, value: number, hypothesis: string): LoopState {
	const improved = isBetter(value, loop.bestValue, loop.direction);
	const verdict: LoopVerdict = improved ? "improved" : value === loop.bestValue ? "plateau" : "regressed";
	const entry: LoopMeasure = { iteration: loop.iteration, at: Date.now(), value, hypothesis, verdict };
	return {
		...loop,
		bestValue: improved ? value : loop.bestValue,
		lastValue: value,
		stallCount: improved ? 0 : loop.stallCount + 1,
		history: pushCapped(loop.history, entry, HISTORY_CAP),
		updatedAt: Date.now(),
	} as LoopState & { updatedAt: number };
}

export function applyMetriclessTick(loop: LoopState, hypothesis: string): LoopState {
	const entry: LoopMeasure = { iteration: loop.iteration, at: Date.now(), hypothesis, verdict: "metricless" };
	return { ...loop, history: pushCapped(loop.history, entry, HISTORY_CAP) } as LoopState;
}

/** Returns the first bound hit (priority: max, time, tokens, plateau) or undefined. */
export function isBoundedStop(loop: LoopState): LoopStopReason | undefined {
	if (loop.maxIterations > 0 && loop.iteration >= loop.maxIterations) return "max";
	if (loop.timeLimitMs !== undefined && Date.now() - loop.startedAt >= loop.timeLimitMs) return "time";
	if (loop.tokenBudget !== undefined && loop.tokensUsed >= loop.tokenBudget) return "tokens";
	if (loop.mode === "metric" && loop.stallCount >= loop.plateauWindow) return "plateau";
	return undefined;
}

export function stopLoop(loop: LoopState, reason: LoopStopReason): LoopState {
	return { ...loop, active: false, stopReason: reason };
}

export function cloneLoop(loop: LoopState): LoopState {
	try { return structuredClone(loop); } catch { return JSON.parse(JSON.stringify(loop)) as LoopState; }
}

export function isLoop(v: unknown): v is LoopState {
	if (!v || typeof v !== "object") return false;
	const l = v as Partial<LoopState>;
	return typeof l.id === "string" && typeof l.target === "string" &&
		(l.mode === "metric" || l.mode === "metricless") && typeof l.iteration === "number" &&
		typeof l.startedAt === "number" && typeof l.active === "boolean";
}

// ─── Runtime singleton (mirrors goal/state.ts GoalRuntimeState) ──────────────

export interface ContinuationPending { loopId: string; iteration: number; marker: string; prompt: string; }
export type LoopRecoveryKind = "provider_retry" | "compaction_retry";
export interface LoopRecovery { loopId: string; kind: LoopRecoveryKind; }

export interface LoopRuntimeState {
	activeLoop: LoopState | undefined;
	extensionApi: unknown; // ExtensionAPI — typed loosely to stay pi-import-free
	continuationPending: ContinuationPending | undefined;
	loopRecovery: LoopRecovery | undefined;
	// Anti-repetition windows (reused REPETITION constants via repetition.js)
	consecutiveStuck: number;
	stuckStartedAt: number | undefined;
	recentPrints: string[];
	recentTexts: string[];
	recentToolResults: ToolResultPrint[];
	toollessStreak: number;
	toolRanThisTurn: boolean;
	// Liveness (reused backoff.js predicates)
	lastActivityAt: number;
	lastWedgeAlertAt: number;
	nudgeCount: number;
	// Measure-failure tracking (§7: ≥3 consecutive null -> stop)
	consecutiveMeasureNull: number;
}

export const loopState: LoopRuntimeState = {
	activeLoop: undefined, extensionApi: undefined, continuationPending: undefined, loopRecovery: undefined,
	consecutiveStuck: 0, stuckStartedAt: undefined, recentPrints: [], recentTexts: [], recentToolResults: [],
	toollessStreak: 0, toolRanThisTurn: false, lastActivityAt: Date.now(), lastWedgeAlertAt: 0, nudgeCount: 0,
	consecutiveMeasureNull: 0,
};

export function __resetLoopState(): void {
	loopState.activeLoop = undefined; loopState.extensionApi = undefined; loopState.continuationPending = undefined;
	loopState.loopRecovery = undefined; loopState.consecutiveStuck = 0; loopState.stuckStartedAt = undefined;
	loopState.recentPrints = []; loopState.recentTexts = []; loopState.recentToolResults = [];
	loopState.toollessStreak = 0; loopState.toolRanThisTurn = false; loopState.lastActivityAt = Date.now();
	loopState.lastWedgeAlertAt = 0; loopState.nudgeCount = 0; loopState.consecutiveMeasureNull = 0;
}
```

> **Note:** `LoopState` lacks `updatedAt`; the test for `applyMeasurement` does not assert it. Remove the `as ... { updatedAt }` cast and the `updatedAt: Date.now()` line if your `tsconfig`'s excess-property check flags it — `LoopState` is intentionally `updatedAt`-free (loop ticks stamp `history[].at` instead). The cast is a compile-guard; drop both lines for the clean version:

```ts
// clean applyMeasurement tail (use this, not the cast above):
	return {
		...loop,
		bestValue: improved ? value : loop.bestValue,
		lastValue: value,
		stallCount: improved ? 0 : loop.stallCount + 1,
		history: pushCapped(loop.history, entry, HISTORY_CAP),
	};
```
(Replace the `applyMeasurement` body's return with this clean version; delete the note before commit.)

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/loop-state.test.ts )`
Expected: PASS — all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/loop/loop-state.ts bun-apps/pi-agent-ext-core-task/src/loop/__tests__/loop-state.test.ts
git commit -m "feat(core-task/loop): pure LoopState model + runtime singleton (T1)"
```

---

## Task 2: `loop-metric.ts` — `parseMetric` + `runMeasure`

**Files:**
- Create: `src/loop/loop-metric.ts`
- Test: `src/loop/__tests__/loop-metric.test.ts`

**Interfaces:**
- Consumes: none (pure parseMetric); `pi.exec` at the boundary via an injected minimal api.
- Produces: `parseMetric`, `runMeasure`, `MEASURE_TIMEOUT_MS`, `LoopMetricApi`.

- [ ] **Step 1: Write the failing test**

```ts
// src/loop/__tests__/loop-metric.test.ts
import { test, expect } from "bun:test";
import { parseMetric, runMeasure, MEASURE_TIMEOUT_MS } from "../loop-metric.js";

test("parseMetric returns the last numeric token", () => {
	expect(parseMetric("coverage: 42%\n")).toBe(42);
	expect(parseMetric("a 1 b 2.5 c")).toBe(2.5);
	expect(parseMetric("nothing here")).toBeNull();
	expect(parseMetric("")).toBeNull();
});

test("runMeasure parses stdout via parseMetric", async () => {
	const fakeExec = async () => ({ stdout: "passed 7 failed 0", exitCode: 0, stderr: "" });
	const api = { exec: fakeExec } as any;
	expect(await runMeasure(api, "echo 7", "/cwd")).toBe(7);
});

test("runMeasure returns null on exec failure or non-zero exit", async () => {
	const api = { exec: async () => { throw new Error("boom"); } } as any;
	expect(await runMeasure(api, "x", "/cwd")).toBeNull();
	const api2 = { exec: async () => ({ stdout: "", exitCode: 2, stderr: "err" }) } as any;
	expect(await runMeasure(api2, "x", "/cwd")).toBeNull();
});

test("MEASURE_TIMEOUT_MS is 60s", () => { expect(MEASURE_TIMEOUT_MS).toBe(60_000); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/loop-metric.test.ts )`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/loop/loop-metric.ts
/**
 * Loop 3 metric execution. parseMetric is pure; runMeasure is the pi.exec
 * boundary (the agent never self-reports a number — the orchestrator measures).
 */

export const MEASURE_TIMEOUT_MS = 60_000;
const LAST_NUMBER_RE = /-?\d+(?:\.\d+)?/g;

/** Extract the last numeric token from stdout (audit project's parseMetric rule). */
export function parseMetric(stdout: string): number | null {
	const matches = stdout.match(LAST_NUMBER_RE);
	if (!matches || matches.length === 0) return null;
	return Number(matches[matches.length - 1]);
}

/** Minimal slice of ExtensionAPI that runMeasure needs (keeps this module fakeable). */
export interface LoopMetricApi {
	exec: (prog: string, args: string[], opts: { cwd: string; timeout: number }) =>
		Promise<{ stdout?: string; stderr?: string; exitCode?: number }>;
}

/**
 * Run the user's measure command and parse a metric from stdout.
 * Returns null on exec failure, non-zero exit, or no number — caller treats
 * null per the measure-failure policy (≥3 consecutive -> stop).
 */
export async function runMeasure(api: LoopMetricApi | undefined, cmd: string, cwd: string): Promise<number | null> {
	if (!api?.exec) return null;
	try {
		const result = await api.exec("bash", ["-c", cmd], { cwd, timeout: MEASURE_TIMEOUT_MS });
		if (result.exitCode !== undefined && result.exitCode !== 0) return null;
		return parseMetric(result.stdout ?? "");
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/loop-metric.test.ts )`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/loop/loop-metric.ts bun-apps/pi-agent-ext-core-task/src/loop/__tests__/loop-metric.test.ts
git commit -m "feat(core-task/loop): parseMetric + runMeasure via pi.exec (T2)"
```

---

## Task 3: `loop-commands.ts` — `parseLoopCommand` + `parseDuration`

**Files:**
- Create: `src/loop/loop-commands.ts`
- Test: `src/loop/__tests__/loop-commands.test.ts`

**Interfaces:**
- Consumes: `tokenize`, `parseTokenBudget` from `../goal/commands.js`.
- Produces: `LoopCommandResult`, `parseLoopCommand`, `parseDuration`, `LOOP_ARGUMENT_COMPLETIONS`, `completeLoopArguments`.

- [ ] **Step 1: Write the failing test**

```ts
// src/loop/__tests__/loop-commands.test.ts
import { test, expect } from "bun:test";
import { parseLoopCommand, parseDuration } from "../loop-commands.js";

test("start with measure -> metric mode", () => {
	const r = parseLoopCommand('start "harden security" measure="bun test | grep -c passing"');
	expect(r).toMatchObject({ kind: "start", mode: "metric", target: "harden security", direction: "higher" });
});

test("start without measure -> metricless (Sisyphus)", () => {
	const r = parseLoopCommand('start "improve the spec"');
	expect(r).toMatchObject({ kind: "start", mode: "metricless", target: "improve the spec" });
});

test("direction + max + tokens + plateau parsed", () => {
	const r: any = parseLoopCommand('start "t" measure="m" direction=lower max=10 tokens=100k plateau=3');
	expect(r.direction).toBe("lower");
	expect(r.maxIterations).toBe(10);
	expect(r.tokenBudget).toBe(100_000);
	expect(r.plateauWindow).toBe(3);
});

test("time duration parses h/m", () => {
	expect(parseDuration("2h")).toBe(2 * 60 * 60_000);
	expect(parseDuration("30m")).toBe(30 * 60_000);
	expect(parseDuration("bad")).toBeUndefined();
});

test("stop / status subcommands", () => {
	expect(parseLoopCommand("stop")).toMatchObject({ kind: "stop" });
	expect(parseLoopCommand("status")).toMatchObject({ kind: "show" });
	expect(parseLoopCommand("")).toMatchObject({ kind: "show" });
});

test("start requires a target", () => {
	expect(parseLoopCommand("start")).toMatch(/Usage/);
	expect(parseLoopCommand('start measure="m"')).toMatch(/Usage/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/loop-commands.test.ts )`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/loop/loop-commands.ts
/** /loop command parsing — pure (mirror goal/commands.ts). */
import { tokenize, parseTokenBudget } from "../goal/commands.js";
import type { LoopDirection, LoopMode } from "./loop-state.js";

export type LoopCommandResult =
	| { kind: "show" }
	| { kind: "stop" }
	| {
			kind: "start";
			target: string;
			mode: LoopMode;
			measureCmd?: string;
			direction: LoopDirection;
			maxIterations: number;
			timeLimitMs?: number;
			tokenBudget?: number;
			plateauWindow: number;
	  };

export interface LoopArgumentCompletion { value: string; label: string; description?: string; }

export const LOOP_ARGUMENT_COMPLETIONS: readonly LoopArgumentCompletion[] = [
	{ value: "start ", label: "start", description: "Start a process loop" },
	{ value: "stop", label: "stop", description: "Stop the active loop" },
	{ value: "status", label: "status", description: "Show the active loop" },
];

export function completeLoopArguments(prefix: string): LoopArgumentCompletion[] | null {
	const p = prefix.trimStart();
	if (p === "") return [...LOOP_ARGUMENT_COMPLETIONS];
	if (/\s/.test(p)) return null;
	const m = LOOP_ARGUMENT_COMPLETIONS.filter((c) => c.value.startsWith(p) || c.label.startsWith(p));
	return m.length ? [...m] : null;
}

/** Parse "2h" / "30m" / "90s" -> ms. Undefined if unparseable. */
export function parseDuration(value: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)(h|m|s)$/i.exec(value.trim());
	if (!m) return undefined;
	const n = Number(m[1]);
	const unit = m[2].toLowerCase();
	const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
	return Math.floor(n * mult);
}

/** Parse a `key=value` option token. Returns [key, value] or undefined. */
function parseOption(token: string): [string, string] | undefined {
	const eq = token.indexOf("=");
	if (eq <= 0) return undefined;
	return [token.slice(0, eq), token.slice(eq + 1)];
}

export function parseLoopCommand(args: string): LoopCommandResult | string {
	const tokens = tokenize(args.trim());
	if (tokens.length === 0) return { kind: "show" };
	const [first, ...rest] = tokens;
	if (first === "stop") return rest.length === 0 ? { kind: "stop" } : "Usage: /loop stop";
	if (first === "status" || first === "show") return rest.length === 0 ? { kind: "show" } : "Usage: /loop status";
	if (first !== "start") return { kind: "show" }; // forgiving

	// Separate positional target (may be quoted -> one token) from key=value options.
	const positional: string[] = [];
	const options = new Map<string, string>();
	for (const t of rest) {
		const opt = parseOption(t);
		if (opt && (opt[0] === "measure" || opt[0] === "direction" || opt[0] === "max" || opt[0] === "time" || opt[0] === "tokens" || opt[0] === "plateau")) {
			options.set(opt[0], opt[1]);
		} else {
			positional.push(t);
		}
	}
	if (positional.length === 0) return "Usage: /loop start \"<target>\" [measure=<cmd>] [direction=higher|lower] [max=N] [time=<Hh|Nm>] [tokens=Nk] [plateau=N]";
	const target = positional.join(" ");

	const measureRaw = options.get("measure");
	const mode: LoopMode = measureRaw !== undefined ? "metric" : "metricless";
	const direction: LoopDirection = options.get("direction") === "lower" ? "lower" : "higher";
	const maxIterations = options.has("max") ? Math.max(0, Number.parseInt(options.get("max")!, 10) || 0) : 0;
	const timeLimitMs = options.has("time") ? parseDuration(options.get("time")!) : undefined;
	const tokenBudget = options.has("tokens") ? parseTokenBudget(options.get("tokens")!) : undefined;
	const plateauWindow = options.has("plateau") ? Math.max(1, Number.parseInt(options.get("plateau")!, 10) || 5) : 5;

	return { kind: "start", target, mode, measureCmd: measureRaw, direction, maxIterations, timeLimitMs, tokenBudget, plateauWindow };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/loop-commands.test.ts )`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/loop/loop-commands.ts bun-apps/pi-agent-ext-core-task/src/loop/__tests__/loop-commands.test.ts
git commit -m "feat(core-task/loop): /loop command parser + duration (T3)"
```

---

## Task 4: `loop-persistence.ts` — `persistLoop` + `loadLoopFromSession`

**Files:**
- Create: `src/loop/loop-persistence.ts`
- Test: `src/loop/__tests__/loop-persistence.test.ts`

**Interfaces:**
- Consumes: `cloneLoop`, `isLoop`, `loopState` from `./loop-state.js`.
- Produces: `LOOP_STATE_ENTRY_TYPE`, `LoopPersistenceApi`, `persistLoop`, `clearPersistedLoop`, `loadLoopFromSession`.

- [ ] **Step 1: Write the failing test**

```ts
// src/loop/__tests__/loop-persistence.test.ts
import { test, expect } from "bun:test";
import { persistLoop, clearPersistedLoop, loadLoopFromSession, LOOP_STATE_ENTRY_TYPE } from "../loop-persistence.js";
import { createLoop, __resetLoopState } from "../loop-state.js";

test("persistLoop appends a loop-state entry (cloned)", () => {
	const calls: any[] = [];
	const api = { appendEntry: (t: string, d: unknown) => calls.push({ t, d }) };
	const loop = createLoop({ target: "t", mode: "metricless" });
	persistLoop(api as any, loop);
	expect(calls[0].t).toBe(LOOP_STATE_ENTRY_TYPE);
	expect((calls[0].d as any).loop.id).toBe(loop.id);
	// clone: mutating the original after persist must not affect the stored copy
	loop.iteration = 99;
	expect((calls[0].d as any).loop.iteration).toBe(0);
});

test("clearPersistedLoop writes { loop: null }", () => {
	const calls: any[] = [];
	clearPersistedLoop({ appendEntry: (_t: string, d: unknown) => calls.push(d) } as any);
	expect(calls[0]).toEqual({ loop: null });
});

test("loadLoopFromSession recovers an active loop from the branch", () => {
	const loop = createLoop({ target: "t", mode: "metric" });
	const sm = { getBranch: () => [{ type: "custom", customType: LOOP_STATE_ENTRY_TYPE, data: { loop } }] };
	__resetLoopState();
	const got = loadLoopFromSession(sm);
	expect(got?.id).toBe(loop.id);
});

test("loadLoopFromSession skips a stopped loop", () => {
	const sm = { getBranch: () => [{ type: "custom", customType: LOOP_STATE_ENTRY_TYPE, data: { loop: { ...createLoop({ target: "t", mode: "metricless" }), active: false } } }] };
	expect(loadLoopFromSession(sm)).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/loop-persistence.test.ts )`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/loop/loop-persistence.ts
/** Loop persistence — session-store only (mirror goal/persistence.ts). */
import { cloneLoop, isLoop, type LoopState } from "./loop-state.js";

export const LOOP_STATE_ENTRY_TYPE = "loop-state";

export interface LoopPersistenceApi {
	appendEntry: (customType: string, data: unknown) => void;
}

export function persistLoop(api: LoopPersistenceApi | undefined, loop: LoopState): void {
	api?.appendEntry(LOOP_STATE_ENTRY_TYPE, { loop: cloneLoop(loop) });
}

export function clearPersistedLoop(api: LoopPersistenceApi | undefined): void {
	api?.appendEntry(LOOP_STATE_ENTRY_TYPE, { loop: null });
}

export function loadLoopFromSession(sessionManager: unknown): LoopState | undefined {
	const sm = sessionManager as
		| { getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>; getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }> }
		| undefined;
	const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
	const entry = entries.filter((e) => e.type === "custom" && e.customType === LOOP_STATE_ENTRY_TYPE).pop();
	const data = entry?.data as { loop?: unknown } | undefined;
	return isLoop(data?.loop) && (data!.loop as LoopState).active ? cloneLoop(data!.loop as LoopState) : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/loop-persistence.test.ts )`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/loop/loop-persistence.ts bun-apps/pi-agent-ext-core-task/src/loop/__tests__/loop-persistence.test.ts
git commit -m "feat(core-task/loop): session-store persistence (T4)"
```

---

## Task 5: `loop/overlay.ts` — `LoopOverlay` state-holder + render

**Files:**
- Create: `src/loop/overlay.ts`
- Test: `src/loop/__tests__/overlay.test.ts`

**Interfaces:**
- Consumes: `LoopState` from `./loop-state.js`; `Theme` from `@earendil-works/pi-coding-agent`.
- Produces: `LoopOverlay`, `LoopOverlayLike`.

- [ ] **Step 1: Write the failing test**

```ts
// src/loop/__tests__/overlay.test.ts
import { test, expect } from "bun:test";
import { LoopOverlay } from "../overlay.js";
import { createLoop, applyMeasurement } from "../loop-state.js";

const T = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s } as any;

test("render empty when no loop and no flash", () => {
	expect(new LoopOverlay().render(T, 80)).toEqual([]);
});

test("metric render shows iteration, best, stall", () => {
	const o = new LoopOverlay();
	let l = createLoop({ target: "harden", mode: "metric", measureCmd: "c", direction: "higher", plateauWindow: 5 });
	l = applyMeasurement(l, 7, "h1");
	o.update(l);
	const line = o.render(T, 80).join(" ");
	expect(line).toContain("#1");
	expect(line).toContain("best=7");
	expect(line).toContain("0/5");
});

test("metricless render shows iteration + metricless tag", () => {
	const o = new LoopOverlay();
	const l = createLoop({ target: "polish", mode: "metricless" });
	o.update({ ...l, iteration: 3 });
	const line = o.render(T, 80).join(" ");
	expect(line).toContain("#4"); // iteration is 0-based, display iteration+1
	expect(line).toContain("metricless");
});

test("showStop flash renders + auto-clears via dispose", () => {
	const o = new LoopOverlay();
	o.showStop("plateau");
	expect(o.render(T, 80).join(" ")).toContain("loop stopped");
	o.dispose();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/overlay.test.ts )`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/loop/overlay.ts
/** LoopOverlay — loop section renderer for the CoreTaskStatusWidget (mirror goal/overlay.ts). */
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { LoopState, LoopStopReason } from "./loop-state.js";

const STOP_FLASH_MS = 8_000;

export interface LoopOverlayLike {
	setUICtx(ctx: ExtensionUIContext): void;
	update(loop: LoopState | undefined): void;
	showStop(reason: LoopStopReason): void;
	dispose(): void;
}

export class LoopOverlay implements LoopOverlayLike {
	private current: LoopState | undefined;
	private flashReason: LoopStopReason | undefined;
	private flashTimer: ReturnType<typeof setTimeout> | undefined;
	private refresh: (() => void) | undefined;

	setUICtx(_ctx: ExtensionUIContext): void {}
	setRefresh(fn: () => void): void { this.refresh = fn; }

	update(loop: LoopState | undefined): void {
		this.current = loop;
		if (loop) this.clearFlash();
		this.refresh?.();
	}

	showStop(reason: LoopStopReason): void {
		this.flashReason = reason;
		this.clearFlashTimer();
		this.flashTimer = setTimeout(() => { this.flashTimer = undefined; this.flashReason = undefined; this.refresh?.(); }, STOP_FLASH_MS);
		this.refresh?.();
	}

	dispose(): void { this.clearFlashTimer(); this.flashReason = undefined; this.current = undefined; }

	render(_theme: Theme, width: number): string[] {
		if (this.flashReason !== undefined) return [`✓ loop stopped (${this.flashReason})`.slice(0, width)];
		const l = this.current;
		if (!l || !l.active) return [];
		const n = l.iteration + 1;
		if (l.mode === "metric") {
			const best = l.bestValue !== undefined ? `best=${l.bestValue}` : "best=—";
			return [`⟳ loop #${n} · ${best} · stall=${l.stallCount}/${l.plateauWindow} · ${l.direction}`.slice(0, width)];
		}
		const tok = l.tokenBudget ? ` · ${l.tokensUsed}/${l.tokenBudget}` : "";
		return [`⟳ loop #${n} (metricless)${tok}`.slice(0, width)];
	}

	private clearFlash(): void { this.clearFlashTimer(); this.flashReason = undefined; }
	private clearFlashTimer(): void { if (this.flashTimer) { clearTimeout(this.flashTimer); this.flashTimer = undefined; } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/overlay.test.ts )`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/loop/overlay.ts bun-apps/pi-agent-ext-core-task/src/loop/__tests__/overlay.test.ts
git commit -m "feat(core-task/loop): LoopOverlay status section (T5)"
```

---

## Task 6: `loop.ts` — `runLoopTick` control flow + `registerLoop`

**Files:**
- Create: `src/loop/loop.ts`
- Test: `src/loop/__tests__/loop.test.ts`

**Interfaces:**
- Consumes (from earlier tasks): `loopState`, `createLoop`, `applyMeasurement`, `applyMetriclessTick`, `isBoundedStop`, `stopLoop`, `__resetLoopState` (`./loop-state.js`); `runMeasure` (`./loop-metric.js`); `parseLoopCommand` (`./loop-commands.js`); `persistLoop`, `clearPersistedLoop`, `loadLoopFromSession` (`./loop-persistence.js`); `LoopOverlayLike` (`./overlay.js`).
- Consumes (reused from `../goal/`): `findFinalAssistantMessage`, `isRetryableGoalInterruption`, `isGoalContextOverflow` (`../goal/overflow.js`); `detectLoopStuck`, `loopInterventionDirective`, `pushCapped`, `textFingerprint`, `REPETITION` (`../goal/repetition.js`); `backoffMs`, `shouldHeartbeatRefire`, `shouldWedgeAlert`, `accountTurnForNudges`, `HEARTBEAT_MAX_NUDGES`, `WEDGE_ALERT_DEFAULT_MINUTES` (`../goal/backoff.js`); `currentTokenTotal`-equivalent (see note).
- Produces: `registerLoop`, `isLoopActive`, `runLoopTick`, `parseHypothesis`, `buildLoopContinuationPrompt`, `loopState` (re-export).

> **`StatusContext` / `ExtensionAPI`:** these are pi types. To stay pi-import-light, mirror goal.ts's approach: import the types from `@earendil-works/pi-coding-agent`. `runLoopTick` receives `(pi, ctx, event)` — `pi` is the `ExtensionAPI`, `ctx` is the `StatusContext` goal.ts already uses. Inspect `goal/goal.ts`'s `StatusContext` import (top of file) and reuse the SAME local type alias so signatures match the `agent_end` call site.

- [ ] **Step 1: Write the failing test**

```ts
// src/loop/__tests__/loop.test.ts
import { test, expect } from "bun:test";
import { parseHypothesis, buildLoopContinuationPrompt, isLoopActive } from "../loop.js";
import { __resetLoopState, loopState, createLoop } from "../loop-state.js";

test("parseHypothesis extracts the HYPOTHESIS: line", () => {
	expect(parseHypothesis("HYPOTHESIS: try caching\nsome code")).toBe("try caching");
	expect(parseHypothesis("no line here")).toBe("");
});

test("buildLoopContinuationPrompt requires HYPOTHESIS + forbids self-report in metric", () => {
	const l = createLoop({ target: "t", mode: "metric", measureCmd: "c", direction: "higher" });
	const p = buildLoopContinuationPrompt(l, "marker-1");
	expect(p).toContain("HYPOTHESIS:");
	expect(p).toContain("marker-1");
	expect(p).toContain("do not report");
});

test("buildLoopContinuationPrompt metricless omits the no-self-report rule", () => {
	const l = createLoop({ target: "t", mode: "metricless" });
	expect(buildLoopContinuationPrompt(l, "m")).not.toContain("do not report");
});

test("isLoopActive reflects loopState", () => {
	__resetLoopState();
	expect(isLoopActive()).toBe(false);
	loopState.activeLoop = createLoop({ target: "t", mode: "metricless" });
	expect(isLoopActive()).toBe(true);
	__resetLoopState();
});
```

> The full `runLoopTick` integration (fake-pi dispatch, measure compare → transitions, bounds, heartbeat re-fire) is validated in Task 7's integration tests against the real `agent_end` wiring. Task 6 unit-tests the pure helpers + the seam; `runLoopTick` itself is exercised end-to-end once wired (T7), mirroring how goal.ts's `agent_end` is tested.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/loop.test.ts )`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/loop/loop.ts
/**
 * Loop 3 orchestration: runLoopTick control flow + /loop registration.
 * Branches off goal.ts's agent_end (see T7). Mirrors goal.ts's structure:
 * extract turn -> classify -> measure/metricless -> bounds -> anti-repetition
 * -> continuation. Reuses goal/{overflow,repetition,backoff}.js pure helpers.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
	loopState, createLoop, applyMeasurement, applyMetriclessTick, isBoundedStop, stopLoop,
	cloneLoop, type LoopState, type LoopStopReason,
} from "./loop-state.js";
import { runMeasure } from "./loop-metric.js";
import { parseLoopCommand } from "./loop-commands.js";
import { persistLoop, clearPersistedLoop, loadLoopFromSession } from "./loop-persistence.js";
import type { LoopOverlayLike } from "./overlay.js";
import { findFinalAssistantMessage, isRetryableGoalInterruption, isGoalContextOverflow } from "../goal/overflow.js";
import {
	detectLoopStuck, loopInterventionDirective, pushCapped, textFingerprint, REPETITION, type ToolResultPrint,
} from "../goal/repetition.js";
import {
	backoffMs, shouldPauseAfterBackoff, HEARTBEAT_MAX_NUDGES,
} from "../goal/backoff.js";

export { loopState };

const MEASURE_NULL_STOP = 3;
const HYPOTHESIS_RE = /^HYPOTHESIS:\s*(.*)$/m;

export function parseHypothesis(text: string): string {
	return HYPOTHESIS_RE.exec(text)?.[1]?.trim() ?? "";
}

export function isLoopActive(): boolean { return !!loopState.activeLoop?.active; }

export function buildLoopContinuationPrompt(loop: LoopState, marker: string): string {
	const metricRule = loop.mode === "metric"
		? "\nDo NOT report or guess the metric number — the orchestrator runs the measure command and compares it."
		: "";
	return [
		`<!-- pi-loop-continuation:${marker} -->`,
		`Loop iteration ${loop.iteration + 1}. Target: ${loop.target}.`,
		`Begin your reply with a single line: HYPOTHESIS: <the one change you will try this turn>.`,
		`Make exactly ONE concrete, inspectable improvement attempt this turn.${metricRule}`,
	].join("\n");
}

function continuationMarker(loop: LoopState): string {
	return `${loop.id}:${loop.iteration}:${Math.random().toString(36).slice(2, 8)}`;
}

interface LoopTickCtx {
	ui: { notify: (msg: string, level: "info" | "warning" | "error") => void };
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	cwd: string;
	// token accounting: goal.ts reads ctx.sessionManager / a token total. Reuse
	// the SAME helper goal.ts uses (currentTokenTotal) — see T7 wiring note.
}

/**
 * The loop tick — called from goal.ts's agent_end when loopState.active.
 * event shape matches goal.ts's agent_end event: { messages?: unknown[] }.
 */
export async function runLoopTick(pi: ExtensionAPI, ctx: LoopTickCtx, event: { messages?: unknown[] }): Promise<void> {
	if (!loopState.activeLoop?.active) return;
	loopState.lastActivityAt = Date.now();
	const loopId = loopState.activeLoop.id;
	const finalAssistant = findFinalAssistantMessage(event.messages ?? []);

	// iteration + usage (tokens: reuse goal's accounting; fallback 0 if unavailable)
	loopState.activeLoop = { ...loopState.activeLoop, iteration: loopState.activeLoop.iteration + 1 };

	// Transient error classification (mirrors goal.ts agent_end)
	if (finalAssistant?.stopReason === "aborted" || finalAssistant?.stopReason === "error") {
		if (isRetryableGoalInterruption(finalAssistant)) {
			loopState.loopRecovery = { loopId, kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry" };
			persistLoop(loopState.extensionApi as ExtensionAPI, loopState.activeLoop);
			return;
		}
		finishLoop(ctx, "error", `Loop stopped: unrecoverable error.`);
		return;
	}
	loopState.loopRecovery = undefined;

	const assistantText = finalAssistant?.content?.map((c: { text?: string }) => c.text ?? "").join(" ") ?? "";
	const hypothesis = parseHypothesis(assistantText);

	// Metric vs metricless
	if (loopState.activeLoop.mode === "metric" && loopState.activeLoop.measureCmd) {
		const value = await runMeasure(pi as unknown as { exec: Parameters<typeof runMeasure>[0] extends undefined ? never : never } as unknown as ExtensionAPI extends never ? never : never as any, loopState.activeLoop.measureCmd, ctx.cwd);
		// ^ NOTE: cast simplified below — see clean version.
		if (value === null) {
			loopState.consecutiveMeasureNull += 1;
			if (loopState.consecutiveMeasureNull >= MEASURE_NULL_STOP) { finishLoop(ctx, "measure-error", `Loop stopped: measure command failed ${loopState.consecutiveMeasureNull}× in a row.`); return; }
			loopState.activeLoop = applyMetriclessTick(loopState.activeLoop, hypothesis || "(no measure value)");
		} else {
			loopState.consecutiveMeasureNull = 0;
			loopState.activeLoop = applyMeasurement(loopState.activeLoop, value, hypothesis || "(no hypothesis)");
		}
	} else {
		loopState.activeLoop = applyMetriclessTick(loopState.activeLoop, hypothesis || "(no hypothesis)");
	}

	// Bounds
	const bound = isBoundedStop(loopState.activeLoop);
	if (bound) { finishLoop(ctx, bound, stopMessage(bound)); return; }

	// Anti-repetition (mirror goal.ts: fingerprint, classify, intervene)
	const toolRanThisTurn = loopState.toolRanThisTurn;
	loopState.toolRanThisTurn = false;
	loopState.toollessStreak = toolRanThisTurn ? 0 : loopState.toollessStreak + 1;
	loopState.nudgeCount = toolRanThisTurn ? 0 : loopState.nudgeCount + 1;
	if (loopState.nudgeCount >= HEARTBEAT_MAX_NUDGES) { finishLoop(ctx, "repetition", `Loop stopped: 3 consecutive no-tool turns.`); return; }

	const print = textFingerprint(assistantText);
	loopState.recentPrints = pushCapped(loopState.recentPrints, print, REPETITION.printWindow);
	loopState.recentTexts = pushCapped(loopState.recentTexts, assistantText.slice(0, 1000), REPETITION.textWindow);
	const reason = detectLoopStuck({ assistantText, recentPrints: loopState.recentPrints, previousText: loopState.recentTexts[loopState.recentTexts.length - 2], recentToolResults: loopState.recentToolResults, toollessStreak: loopState.toollessStreak });
	if (reason) {
		loopState.consecutiveStuck += 1;
		if (loopState.stuckStartedAt === undefined) loopState.stuckStartedAt = Date.now();
		if (loopState.consecutiveStuck >= REPETITION.maxInterventions) { finishLoop(ctx, "repetition", `Loop stopped: stuck ${loopState.consecutiveStuck} iterations (${reason}).`); return; }
		if (shouldPauseAfterBackoff(Date.now() - loopState.stuckStartedAt!, loopState.toollessStreak)) { finishLoop(ctx, "repetition", `Loop stopped: backoff cap (${reason}).`); return; }
		await sendLoopPrompt(pi, ctx, loopInterventionDirective(loopState.consecutiveStuck, reason, loopState.recentTexts));
		return;
	}
	loopState.consecutiveStuck = 0; loopState.stuckStartedAt = undefined;

	persistLoop(loopState.extensionApi as ExtensionAPI, loopState.activeLoop);
	const wait = backoffMs(0);
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	await sendLoopContinuation(pi, ctx);
}

function stopMessage(reason: LoopStopReason): string { return `Loop stopped: ${reason}.`; }

function finishLoop(ctx: LoopTickCtx, reason: LoopStopReason, notifyMsg: string): void {
	if (loopState.activeLoop) {
		loopState.activeLoop = stopLoop(loopState.activeLoop, reason);
		loopState.activeLoop.history = pushCapped(loopState.activeLoop.history, { iteration: loopState.activeLoop.iteration, at: Date.now(), hypothesis: "(stop)", verdict: "metricless" }, 50);
	}
	clearPersistedLoop(loopState.extensionApi as ExtensionAPI);
	loopState.activeLoop = undefined;
	loopState.continuationPending = undefined;
	ctx.ui.notify(notifyMsg, reason === "error" || reason === "measure-error" ? "error" : "info");
}

async function sendLoopContinuation(pi: ExtensionAPI, ctx: LoopTickCtx): Promise<void> {
	if (!loopState.activeLoop) return;
	if (loopState.continuationPending?.loopId === loopState.activeLoop.id) return;
	if (ctx.hasPendingMessages?.()) return;
	const marker = continuationMarker(loopState.activeLoop);
	const prompt = buildLoopContinuationPrompt(loopState.activeLoop, marker);
	loopState.continuationPending = { loopId: loopState.activeLoop.id, iteration: loopState.activeLoop.iteration, marker, prompt };
	await sendLoopPrompt(pi, ctx, prompt);
}

async function sendLoopPrompt(pi: ExtensionAPI, ctx: LoopTickCtx, prompt: string): Promise<void> {
	try {
		const sent = ctx.isIdle?.() ? (pi.sendUserMessage(prompt) as void | Promise<void>) : (pi.sendUserMessage(prompt, { deliverAs: "followUp" }) as void | Promise<void>);
		await sent;
	} catch { /* best-effort; a failed send surfaces as no continuation -> heartbeat or next turn */ }
}

// ─── /loop command + registration ────────────────────────────────────────────

export function registerLoop(pi: ExtensionAPI, overlay: LoopOverlayLike): void {
	pi.registerCommand("loop", {
		run: async (args: string, ctx: LoopTickCtx) => {
			const parsed = parseLoopCommand(args ?? "");
			if (typeof parsed === "string") { ctx.ui.notify(parsed, "warning"); return; }
			if (parsed.kind === "show") { ctx.ui.notify(showLoopText(), "info"); return; }
			if (parsed.kind === "stop") {
				if (!loopState.activeLoop) { ctx.ui.notify("No active loop.", "info"); return; }
				finishLoop(ctx, "user", "Loop stopped by user.");
				overlay.update(undefined);
				return;
			}
			// start
			if (loopState.activeLoop) { ctx.ui.notify("A loop is already active. Run /loop stop first.", "warning"); return; }
			// mutual exclusion with goal is enforced in goal.ts (T7) via isGoalActive();
			// double-check the globalThis seam here too:
			if ((globalThis as Record<string, unknown>).__piGoalActive?.() === true) {
				ctx.ui.notify("A goal is active. Run /goal clear or complete it before starting a loop.", "warning"); return;
			}
			loopState.activeLoop = createLoop({ target: parsed.target, mode: parsed.mode, measureCmd: parsed.measureCmd, direction: parsed.direction, maxIterations: parsed.maxIterations, timeLimitMs: parsed.timeLimitMs, tokenBudget: parsed.tokenBudget, plateauWindow: parsed.plateauWindow });
			loopState.extensionApi = pi;
			persistLoop(pi, loopState.activeLoop);
			overlay.update(loopState.activeLoop);
			await sendLoopPrompt(pi, ctx, `Loop started: ${parsed.target} (${parsed.mode}). Begin now.`);
		},
		completeArgument: (prefix: string) => {
			const completions = parseLoopCompletions(prefix);
			return completions?.map((c) => ({ value: c.value, label: c.label, description: c.description })) ?? null;
		},
	});
}

import { completeLoopArguments } from "./loop-commands.js";
function parseLoopCompletions(prefix: string) { return completeLoopArguments(prefix); }

function showLoopText(): string {
	const l = loopState.activeLoop;
	if (!l) return "No active loop.";
	const best = l.bestValue !== undefined ? ` best=${l.bestValue}` : "";
	return `⟳ loop #${l.iteration + 1} (${l.mode})${best} stall=${l.stallCount}/${l.plateauWindow}`;
}

/** Called by core-task.ts session_start/session_compact to recover an active loop. */
export function restoreLoopFromSession(sessionManager: unknown, overlay: LoopOverlayLike): void {
	const loop = loadLoopFromSession(sessionManager);
	if (loop) { loopState.activeLoop = loop; overlay.update(loop); }
}
```

> **CLEAN UP the `runMeasure` cast before commit.** The `value =` line above has a deliberately-ugly placeholder cast to flag it. Replace that single line with the clean version:
```ts
		const value = await runMeasure(pi as unknown as { exec: (p: string, a: string[], o: { cwd: string; timeout: number }) => Promise<{ stdout?: string; exitCode?: number }> }, loopState.activeLoop.measureCmd, ctx.cwd);
```
> `ExtensionAPI.exec` has that signature; the cast exists only because this module keeps `ExtensionAPI` opaque (mirroring goal.ts's loose `extensionApi: unknown` in state.ts). Delete the ugly line and the `^ NOTE` comment.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/loop.test.ts )`
Expected: PASS — 4 tests (parseHypothesis, buildLoopContinuationPrompt ×2, isLoopActive).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/loop/loop.ts bun-apps/pi-agent-ext-core-task/src/loop/__tests__/loop.test.ts
git commit -m "feat(core-task/loop): runLoopTick control flow + /loop registration (T6)"
```

---

## Task 7: Integration — `agent_end` branch, mutual exclusion, factory wiring, widget

**Files:**
- Modify: `src/goal/goal.ts` (agent_end branch + mutual-exclusion guard in `startGoal`)
- Modify: `extensions/core-task.ts` (import + registerLoop + widget section + session load + dispose)
- Test: `src/loop/__tests__/integration.test.ts` (fake-pi harness mirroring `goal/__tests__/goal.test.ts`)

**Interfaces:**
- Consumes: `runLoopTick`, `registerLoop`, `restoreLoopFromSession`, `isLoopActive`, `loopState` from `../loop/loop.js`; `LoopOverlay` from `../loop/overlay.js`.
- The `agent_end` hook in `goal.ts` calls `runLoopTick(pi, ctx, event)` when `isLoopActive()`.

- [ ] **Step 1: Write the failing integration test**

```ts
// src/loop/__tests__/integration.test.ts
import { test, expect } from "bun:test";
// Mirror goal/__tests__/goal.test.ts's fake-pi harness (fake registerCommand,
// registerTool, on(event,fn) capturing handlers, sendUserMessage spy, ui.notify).
// Reuse the same fakeSetInterval helper for heartbeat/time control.
import { __resetGoalState } from "../../goal/state.js";
import { __resetLoopState, loopState, createLoop } from "../loop-state.js";

test("agent_end dispatches to runLoopTick when a loop is active (not goal continuation)", async () => {
	// Setup: capture goal.ts's agent_end handler via the fake pi.on registry.
	// Activate a loop, fire agent_end with a stub message, assert the loop's
	// iteration advanced and (metricless) a followUp was sent.
	// (Full harness scaffolding mirrors goal.test.ts; see that file's imports.)
	__resetGoalState(); __resetLoopState();
	loopState.activeLoop = createLoop({ target: "t", mode: "metricless" });
	// ... fire capturedAgentEnd({ messages: [{ role: "assistant", content: [{ type: "text", text: "HYPOTHESIS: x" }], stopReason: "stop" }] }, fakeCtx)
	// expect(loopState.activeLoop.iteration).toBe(1);
	// expect(sendUserMessageSpy).toHaveBeenCalled();
	expect(true).toBe(true); // placeholder until harness wired in step 3
});

test("/loop start is rejected while a goal is active (mutual exclusion)", async () => {
	// Activate a fake goal (set globalThis.__piGoalActive = () => true), call
	// /loop start, assert the warning notify fired and no loop was created.
	expect(true).toBe(true);
});
```

> The integration harness is substantial (fake pi). **Step 3 ports `goal/__tests__/goal.test.ts`'s harness verbatim** (it already fakes `registerCommand`/`registerTool`/`on`/`sendUserMessage`/`setInterval`) and adds a loop activation path. Replace the two `expect(true)` placeholders with real assertions once the harness is in place. This is the one task where the test is co-developed with the wiring.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/__tests__/integration.test.ts )`
Expected: FAIL — harness not yet wired (placeholder asserts pass trivially until replaced; treat "not yet real" as red).

- [ ] **Step 3: Wire the integration**

**3a. `goal.ts` agent_end branch** — at the very top of the `pi.on("agent_end", …)` handler (currently `goal.ts:643`, the line after `pi.on("agent_end", async (event, ctx) => {`), insert BEFORE `if (!goalState.activeGoal …)`:

```ts
	// Loop 3 dispatch: a live loop drives the continuation, not a goal.
	if (isLoopActive()) {
		await runLoopTick(pi, ctx as StatusContext, event);
		return;
	}
```

Add the imports at the top of `goal.ts` (alongside the existing `./overflow.js` / `./state.js` imports):
```ts
import { runLoopTick, isLoopActive } from "../loop/loop.js";
```

**3b. `goal.ts` mutual-exclusion guard** — in `startGoal` (around `goal.ts:772`), at the top of the function body, insert:
```ts
	if (isLoopActive()) {
		ctx.ui.notify("A loop is active. Run /loop stop before starting a goal.", "warning");
		return;
	}
```

**3c. `core-task.ts` factory** — add imports + registration + widget section + session load. In `extensions/core-task.ts`:

Add imports (after the `goal` import):
```ts
import loop, { registerLoop, restoreLoopFromSession } from "../src/loop/loop.js";
import { LoopOverlay } from "../src/loop/overlay.js";
import { loopState } from "../src/loop/loop-state.js";
```

In the factory body, after the `todoOverlay` setup and BEFORE the `statusWidget.addSection(... todo ...)` line, add:
```ts
	const loopOverlay = new LoopOverlay();
	registerLoop(pi, loopOverlay);
	loopOverlay.setRefresh(() => statusWidget.update());
	// Loop is mutually exclusive with goal, so it shares order 0 — only one is ever non-empty.
	statusWidget.addSection({ id: "loop", order: 0, render: (t, w) => loopOverlay.render(t, w) });
```

In the `session_start` handler, after `refreshPlan(ctx.cwd);`, add:
```ts
		restoreLoopFromSession((ctx as { sessionManager?: unknown }).sessionManager, loopOverlay);
```

In the `session_shutdown` handler, add `loopOverlay.dispose();` alongside the existing `goalOverlay.dispose();`.

- [ ] **Step 4: Replace the placeholder assertions + run tests**

Port `goal/__tests__/goal.test.ts`'s fake-pi harness into `integration.test.ts`, replace the two `expect(true)` blocks with the real assertions described in their comments, then:

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/ )`
Expected: PASS — all loop tests including integration.

Run typecheck: `( cd bun-apps/pi-agent-ext-core-task && bunx tsc --noEmit )`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/goal.ts bun-apps/pi-agent-ext-core-task/extensions/core-task.ts bun-apps/pi-agent-ext-core-task/src/loop/__tests__/integration.test.ts
git commit -m "feat(core-task/loop): wire agent_end branch, mutual exclusion, widget, session restore (T7)"
```

---

## Task 8: Heartbeat generalization — supervise goal XOR loop

**Files:**
- Modify: `src/goal/goal.ts` `syncHeartbeatTimer` (around `goal.ts:1018`)
- Test: extend `src/loop/__tests__/integration.test.ts` (or `goal/__tests__/hardening-loop.test.ts`)

**Interfaces:**
- Consumes: `isLoopActive`, `runLoopTick`-equivalent re-fire (the loop's `sendLoopContinuation`). Expose a `refireLoopContinuation(pi, ctx)` from `loop.ts` for the heartbeat to call.

- [ ] **Step 1: Write the failing test**

```ts
// append to src/loop/__tests__/integration.test.ts
test("heartbeat re-fires the LOOP continuation when a loop is active and the session stalls", async () => {
	// Activate a loop, advance the fake clock past HEARTBEAT_STALL_MS with the
	// session idle + nothing pending, fire the captured 15s heartbeat interval,
	// assert sendUserMessage was called with a loop continuation prompt.
	expect(true).toBe(true); // replace once harness wired (T7 step 4)
});
```

- [ ] **Step 2: Run test to verify it fails** — placeholder (red until wired).

- [ ] **Step 3: Generalize the heartbeat**

First, export a re-fire entry from `loop.ts` (add near `sendLoopContinuation`):
```ts
/** Heartbeat re-fire entry — called by goal.ts's generalized heartbeat when a loop is active + idle + stalled. */
export async function refireLoopContinuation(pi: ExtensionAPI, ctx: LoopTickCtx): Promise<void> {
	if (!isLoopActive()) return;
	if (loopState.continuationPending) return;
	await sendLoopContinuation(pi, ctx);
}
```

Then in `goal.ts` `syncHeartbeatTimer`, generalize the `shouldRun` predicate and the re-fire dispatch. Replace:
```ts
	const shouldRun = goalState.activeGoal?.status === "active";
```
with:
```ts
	const shouldRun = goalState.activeGoal?.status === "active" || isLoopActive();
```
And in the interval callback, replace the `shouldHeartbeatRefire` branch's body (`void sendContinuationPrompt(piRef!, ctx, goalState.activeGoal!);`) with a dispatch:
```ts
			if (isLoopActive()) {
				void refireLoopContinuation(piRef!, ctx as StatusContext);
			} else if (goalState.activeGoal?.status === "active") {
				void sendContinuationPrompt(piRef!, ctx, goalState.activeGoal);
			}
```
Add imports in `goal.ts`:
```ts
import { isLoopActive, refireLoopContinuation } from "../loop/loop.js";
```
(Merge with the T7a import: `import { runLoopTick, isLoopActive, refireLoopContinuation } from "../loop/loop.js";`)

- [ ] **Step 4: Replace placeholder + run tests**

Replace the `expect(true)` with the real assertion (harness from T7), then:

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/loop/ src/goal/__tests__/hardening-loop.test.ts )`
Expected: PASS.

Run typecheck: `( cd bun-apps/pi-agent-ext-core-task && bunx tsc --noEmit )`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/loop/loop.ts bun-apps/pi-agent-ext-core-task/src/goal/goal.ts bun-apps/pi-agent-ext-core-task/src/loop/__tests__/integration.test.ts
git commit -m "feat(core-task/loop): generalize heartbeat to supervise goal XOR loop (T8)"
```

---

## Final verification

- [ ] **Full package test**: `( cd bun-apps/pi-agent-ext-core-task && bun run test )` (biome + tsc + unit) — green.
- [ ] **Workspace tests**: from `bun-apps/`, `bun test` — no regressions in goal/todo/plan consumers.
- [ ] **Manual smoke** (optional): in a pi session, `/loop start "improve test names" measure="grep -rc 'test(' src | awk -F: '{s+=\$2} END{print s}'" max=5 plateau=3` — observe iterations, `best=` advancing, `/loop stop`, status flash.

## Self-Review notes (plan vs spec)

- **Spec coverage:** §1 Motivation, §2 Goals, §4 Architecture, §5 Data model, §6 Commands, §7 Control flow, §8 Liveness, §9 UI, §11 Testing → all covered (T1–T8). §3 Non-goals (refine/respec/branch/cron) correctly absent. §10 cron out-of-scope — no task (correct).
- **Refinement vs spec §9:** spec said widget "order 2, after todo"; the codebase already assigns wayfind=2, plan-coordinator=3. Since loop ⇔ goal are mutually exclusive, loop shares goal's `order 0` (only one renders at a time). This is a cleaner fit than the spec's "2" and is noted in T7c.
- **Placeholder scan:** the only in-plan placeholders are explicitly flagged "replace before commit" (T6 runMeasure cast, T6 `updatedAt` cast, T7/T8 `expect(true)` harness co-development). These are deliberate red-flags for the implementer, not gaps — each has its real replacement code inline.
- **Type consistency:** `runLoopTick(pi, ctx, event)` signature matches the `agent_end` call site (T7a) and the heartbeat re-fire (T8). `LoopOverlayLike` (T5) matches `LoopOverlay` (T5) and `registerLoop`'s param (T6). `loopState` fields consumed in T6/T8 match those defined in T1.
