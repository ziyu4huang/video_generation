# Goal-loop hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modularize `src/goal/goal.ts` into tested pure modules and harden its `agent_end` loop driver with a backoff cap, heartbeat self-watchdog, and anti-repetition detection.

**Architecture:** Pure-refactor extractions first (Phase 1, zero behavior change — the existing `goal.test.ts` suite is the characterization net), then port the reference's pure backoff/heartbeat/repetition predicates into new modules and wire them into the orchestrator (Phase 2). Each task is independently testable and committable.

**Tech Stack:** Bun + TypeScript; `@earendil-works/pi-coding-agent` 0.82.0; `typebox`. Tests via `bun test`.

**Spec:** `bun-apps/pi-agent-ext-task/docs/2026-07-25-goal-loop-hardening.md` (D1 = medium split, D2 = all-three hardening).
**Mentor (read-only port source):** `../pi-goal-list-loop-audit/extensions/goal-loop-{backoff,repetition}.ts`.

## Global Constraints

- **Bun runtime** — import from `"fs"` / `"path"` / `"crypto"` (no `node:` prefix). `process` is global.
- **Pure modules carry zero `@earendil-works/*` imports** — unit-testable under plain Bun.
- **Test gate after every task:** `( cd bun-apps/pi-agent-ext-task && bun test )` green **and** `bun run typecheck` clean.
- **Preserve the coordination seam:** `isGoalActive()` + the `globalThis.__piGoalActive` publish stay in `goal.ts`, signature unchanged.
- **Preserve these re-exports from `goal.ts`** (existing `goal.test.ts` + downstream import them): `findFinalAssistantMessage`, `isContradictoryCompletionSummary`, `isRetryableGoalInterruption`, `buildGoalSystemPrompt`, `completeGoalArguments`, `parseCommand`, `parseTokenBudget`, `validateObjective`. After extraction, re-export each with `export { X } from "./<module>.js"`.
- `ActiveGoal` / `GoalStatus` types live in `src/goal/format.ts` already — keep importing them from there; do not duplicate.
- **Two phases:** pause for review between Phase 1 (refactor) and Phase 2 (hardening). Phase 1 ships as a no-op behavior change.

## File Structure

**Create:**
- `src/goal/overflow.ts` — overflow/interruption classification (pure).
- `src/goal/commands.ts` — `/goal` command parsing (pure).
- `src/goal/prompts.ts` — prompt builders (pure; plan-progress line injected as a param).
- `src/goal/state.ts` — goal types owned by goal (not format), pure status machine, `GoalRuntimeState` container + `__resetGoalState()`.
- `src/goal/persistence.ts` — `appendEntry` + legacy JSON (fs-coupled; deps injected).
- `src/goal/backoff.ts` — backoff cap + heartbeat + wedge predicates (pure, ported).
- `src/goal/repetition.ts` — anti-repetition classifier + interventions (pure, ported).
- `src/goal/__tests__/{overflow,commands,prompts,state,persistence,backoff,repetition}.test.ts`

**Modify:**
- `src/goal/goal.ts` — becomes the thin orchestrator: tool def, `/goal` registration, lifecycle hooks, `agent_end` loop. Imports the modules above. ~1249 → ~500 lines.

---

# Phase 1 — Modularize (pure refactor, zero behavior change)

> Each extraction task follows the same TDD shape: write unit tests against the new module path → watch them fail (module absent) → move the code + re-export → full suite green → commit. The existing `goal.test.ts` (~20 describe blocks) is the safety net: if an extraction breaks behavior, it fails.

## Task 1: Extract `overflow.ts`

**Files:**
- Create: `src/goal/overflow.ts`, `src/goal/__tests__/overflow.test.ts`
- Modify: `src/goal/goal.ts` (move lines, add imports + re-exports)

**Move from `goal.ts` into `overflow.ts`** (add `export` to each symbol; keep their bodies verbatim):
- Types `Usage` (l.39), `AssistantMessageContent` (l.54), `AgentStopReason` (l.62), `AssistantMessageLike` (l.83).
- `NON_RETRYABLE_GOAL_ERROR_RE` / `RETRYABLE_GOAL_ERROR_RE` (l.131–134), `OVERFLOW_PATTERNS` (l.157), `NON_OVERFLOW_PATTERNS` (l.183).
- `isContextOverflow` (l.189), `isAgentStopReason`, `normalizeUsage`, `findFinalAssistantMessage` (l.~1050+).
- `isGoalContextOverflow` (l.1018), `isRetryableGoalInterruption` (l.1011), `isContradictoryCompletionSummary` (l.973) + `CONTRADICTORY_COMPLETION_PATTERNS` (l.126).

**Interfaces:** Produces — `isContextOverflow(msg, ctxWindow): boolean`, `findFinalAssistantMessage(messages): AssistantMessageLike | undefined`, `isRetryableGoalInterruption(a): boolean`, `isContradictoryCompletionSummary(s): boolean`, `isGoalContextOverflow(a): boolean`, plus the listed types.

- [ ] **Step 1: Write failing unit tests** — `src/goal/__tests__/overflow.test.ts`:

```ts
import { test, expect } from "bun:test";
import { isContextOverflow, isContradictoryCompletionSummary, trigramHash } from "../overflow.js";
// (import only what Task 1 exports; add trigramHash only if you extract it — otherwise drop)

test("isContextOverflow: matches 'exceeds the context window'", () => {
	expect(isContextOverflow({ stopReason: "error", errorMessage: "prompt exceeds the context window" })).toBe(true);
});

test("isContextOverflow: ignores pure rate-limit errors", () => {
	expect(isContextOverflow({ stopReason: "error", errorMessage: "too many requests (rate limit)" })).toBe(false);
});

test("isContradictoryCompletionSummary: flags 'tests still failing'", () => {
	expect(isContradictoryCompletionSummary("the tests are still failing")).toBe(true);
	expect(isContradictoryCompletionSummary("all requirements verified, tests green")).toBe(false);
});
```

- [ ] **Step 2: Run — verify fail** — `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/overflow.test.ts )` → FAIL (`cannot find module ../overflow.js`).
- [ ] **Step 3: Create `overflow.ts`** — move the symbols listed above verbatim from `goal.ts`, `export` each. In `goal.ts`, replace the moved blocks with `import { isContextOverflow, findFinalAssistantMessage, isRetryableGoalInterruption, isGoalContextOverflow, isContradictoryCompletionSummary, type Usage, type AssistantMessageLike } from "./overflow.js";` and add `export { findFinalAssistantMessage, isContradictoryCompletionSummary, isRetryableGoalInterruption } from "./overflow.js";` for downstream.
- [ ] **Step 4: Run full gate** — `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )` → all green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "refactor(core-task/goal): extract overflow/interruption classification into overflow.ts"`.

## Task 2: Extract `commands.ts`

**Files:** Create `src/goal/commands.ts`, `src/goal/__tests__/commands.test.ts`; modify `goal.ts`.

**Move from `goal.ts`** (verbatim, `export` each): `CommandResult` (l.99), `GoalArgumentCompletion` (l.105), `MAX_OBJECTIVE_LENGTH` (l.123), `GOAL_ARGUMENT_COMPLETIONS`, `EDIT_TOKEN_COMPLETION`, `completeGoalArguments` (l.732), `parseCommand` (l.751), `parseObjective` (l.764), `tokenize` (l.784), `parseTokenBudget` (l.810), `validateObjective` (l.819).

**Interfaces:** Produces — `parseCommand(args): CommandResult | string`, `parseTokenBudget(v): number | undefined`, `validateObjective(s): string | undefined`, `completeGoalArguments(prefix): GoalArgumentCompletion[] | null`, `tokenize(input): string[]`.

- [ ] **Step 1: Write failing tests** — `src/goal/__tests__/commands.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseTokenBudget, tokenize, parseCommand, validateObjective } from "../commands.js";

test("parseTokenBudget parses k/m/plain", () => {
	expect(parseTokenBudget("100k")).toBe(100_000);
	expect(parseTokenBudget("1.5m")).toBe(1_500_000);
	expect(parseTokenBudget("500")).toBe(500);
	expect(parseTokenBudget("nope")).toBeUndefined();
});

test("tokenize handles quotes and spaces", () => {
	expect(tokenize(`fix "the bug" now`)).toEqual(["fix", "the bug", "now"]);
});

test("parseCommand routes subcommands", () => {
	expect(parseCommand("pause")).toEqual({ kind: "pause" });
	expect(typeof parseCommand("pause the pipeline")).toBe("string"); // ambiguous → usage string
	expect(parseCommand("status")).toEqual({ kind: "show" });
});

test("validateObjective rejects empty + over-length", () => {
	expect(validateObjective("   ")).toBeTruthy();
	expect(validateObjective("ship the feature")).toBeUndefined();
});
```

- [ ] **Step 2: Run — verify fail** (module absent).
- [ ] **Step 3: Create `commands.ts`** (move symbols verbatim); in `goal.ts` add `import { parseCommand, parseTokenBudget, validateObjective, completeGoalArguments, type CommandResult } from "./commands.js";` + `export { parseCommand, parseTokenBudget, validateObjective, completeGoalArguments } from "./commands.js";`.
- [ ] **Step 4: Run full gate** → green.
- [ ] **Step 5: Commit** — `git commit -m "refactor(core-task/goal): extract /goal command parsing into commands.ts"`.

## Task 3: Extract `prompts.ts` (inject plan-progress line → make pure)

**Files:** Create `src/goal/prompts.ts`, `src/goal/__tests__/prompts.test.ts`; modify `goal.ts`.

**Move from `goal.ts`** (verbatim): `buildGoalPrompt` (l.897), `buildObjectiveUpdatedPrompt` (l.902), `buildResumePrompt` (l.907), `buildContinuePrompt` (l.919), `goalObjectiveBlock` (l.925), `goalPersistenceRules` (l.929), `goalCommandHint` (l.889), `goalSummary` (l.878), `escapeXmlText`, `continuationMarkerComment`, `THREE_LAYER_GUIDANCE` (l.1005).

**Make `buildGoalSystemPrompt` + `buildContinuePrompt` pure** — they currently call `planProgressLineFromPeer()` (reads module state). Change their signatures to take the line as a parameter:

```ts
export function buildGoalSystemPrompt(goal: ActiveGoal, planProgressLine: string): string { /* body unchanged, uses the param */ }
export function buildContinuePrompt(goal: ActiveGoal, marker: string, planProgressLine: string): string { /* uses param */ }
```

At the (two) call sites in `goal.ts`, pass `planProgressLineFromPeer()` as the arg.

**Interfaces:** Produces — the builders above; `buildGoalSystemPrompt(goal, planLine)`, `buildContinuePrompt(goal, marker, planLine)`. Consumes — `ActiveGoal` from `format.ts`.

- [ ] **Step 1: Write failing tests** — `src/goal/__tests__/prompts.test.ts`:

```ts
import { test, expect } from "bun:test";
import { buildGoalSystemPrompt, buildContinuePrompt, goalObjectiveBlock } from "../prompts.js";
import type { ActiveGoal } from "../format.js";

const goal: ActiveGoal = { id: "g1", text: "ship <it>", status: "active", startedAt: 0, updatedAt: 0, iteration: 0, tokenBudget: 1000, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: 0 };

test("buildGoalSystemPrompt escapes XML in the objective", () => {
	const p = buildGoalSystemPrompt(goal, "");
	expect(p).toContain("<goal_objective>");
	expect(p).toContain("ship &lt;it&gt;"); // escaped, not raw <
});

test("buildGoalSystemPrompt includes plan progress when provided", () => {
	expect(buildGoalSystemPrompt(goal, "2/5 phases · x")).toContain("2/5 phases");
	expect(buildGoalSystemPrompt(goal, "")).not.toContain("Active plan progress");
});

test("buildContinuePrompt embeds the continuation marker", () => {
	expect(buildContinuePrompt(goal, "m1", "")).toContain("pi-goal-continuation:m1");
});
```

- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Create `prompts.ts`** (move + change the two signatures); update `goal.ts` call sites + `export { buildGoalSystemPrompt } from "./prompts.js";`.
- [ ] **Step 4: Run full gate** → green (the existing `buildGoalSystemPrompt` test in `goal.test.ts` must still pass — adjust its call if it invokes the old 1-arg signature).
- [ ] **Step 5: Commit** — `git commit -m "refactor(core-task/goal): extract prompt builders into prompts.ts (plan-line injected)"`.

## Task 4: Extract `state.ts` — types + pure status machine

**Files:** Create `src/goal/state.ts`, `src/goal/__tests__/state.test.ts`; modify `goal.ts`.

**Move from `goal.ts`** (verbatim, `export`): `GoalCompleteDetails` (l.64), `ContinuationPending` (l.69), `GoalRecoveryKind` (l.76), `GoalRecovery` (l.78), `GoalStateEntryData` (l.95), `createGoal` (l.634), `transitionGoal` (l.650), `editedGoalStatus` (l.654), `normalizeGoalForBudget` (l.658), `incrementGoal` (l.669), `cloneGoal`, `isGoal`. (`StatusContext` l.111 stays in `goal.ts` — it is UI-facing; or move it here too if `state.ts` needs it. Prefer keeping `StatusContext` in `goal.ts`.)

**Interfaces:** Produces — the types + `createGoal`, `transitionGoal`, `normalizeGoalForBudget`, `isGoal`, `cloneGoal`.

- [ ] **Step 1: Write failing tests** — `src/goal/__tests__/state.test.ts`:

```ts
import { test, expect } from "bun:test";
import { createGoal, transitionGoal, normalizeGoalForBudget, isGoal } from "../state.js";

test("normalizeGoalForBudget flips active → budget_limited at the cap", () => {
	const g = createGoal("x", 1000, 0);
	g.tokensUsed = 1000;
	expect(normalizeGoalForBudget({ ...g, status: "active" }).status).toBe("budget_limited");
});

test("isGoal rejects malformed objects", () => {
	expect(isGoal(null)).toBe(false);
	expect(isGoal({ id: "x" })).toBe(false);
	expect(isGoal(createGoal("x", undefined, 0))).toBe(true);
});

test("transitionGoal preserves identity + bumps updatedAt", () => {
	const g = createGoal("x", undefined, 0);
	const paused = transitionGoal(g, "paused");
	expect(paused.status).toBe("paused");
	expect(paused.id).toBe(g.id);
	expect(paused.updatedAt).toBeGreaterThanOrEqual(g.updatedAt);
});
```

- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Create `state.ts`** (move symbols verbatim); `goal.ts` imports them.
- [ ] **Step 4: Run full gate** → green.
- [ ] **Step 5: Commit** — `git commit -m "refactor(core-task/goal): extract goal types + status machine into state.ts"`.

## Task 5: Introduce `GoalRuntimeState` container + `__resetGoalState()` test seam

**Files:** Modify `src/goal/state.ts` (add container), `src/goal/goal.ts` (migrate `let`s), `src/goal/__tests__/state.test.ts` (add reset test).

This is the one mechanical-but-wide change. The existing suite is the safety net. **Fallback if it proves too churny:** keep the `let`s in `goal.ts` and add `export function __resetGoalState()` there that reassigns each to its initial value — delivers the same test seam with less diff. Prefer the container; use the fallback only on review.

**Add to `state.ts`:**

```ts
/** Runtime, session-scoped goal state. One instance per process (module singleton). */
export interface GoalRuntimeState {
	activeGoal: import("./format.js").ActiveGoal | undefined;
	extensionApi: unknown; // ExtensionAPI — typed loosely to keep state.ts pi-import-free
	continuationPending: ContinuationPending | undefined;
	goalRecovery: GoalRecovery | undefined;
	staleGoalToolCallsBlocked: boolean;
	statusRefreshTimer: ReturnType<typeof setInterval> | undefined;
	latestCtx: unknown; // StatusContext
	cancelledContinuationMarkers: Set<string>;
}

export const goalState: GoalRuntimeState = {
	activeGoal: undefined,
	extensionApi: undefined,
	continuationPending: undefined,
	goalRecovery: undefined,
	staleGoalToolCallsBlocked: false,
	statusRefreshTimer: undefined,
	latestCtx: undefined,
	cancelledContinuationMarkers: new Set<string>(),
};

/** Test seam: reset all runtime state to initial values (mirrors todo/state/store.ts __resetState). */
export function __resetGoalState(): void {
	goalState.activeGoal = undefined;
	goalState.extensionApi = undefined;
	goalState.continuationPending = undefined;
	goalState.goalRecovery = undefined;
	goalState.staleGoalToolCallsBlocked = false;
	goalState.statusRefreshTimer = undefined;
	goalState.latestCtx = undefined;
	goalState.cancelledContinuationMarkers.clear();
}
```

**Migrate `goal.ts`:** delete the module-level `let` declarations (l.213–224) for `activeGoal`, `continuationPending`, `goalRecovery`, `staleGoalToolCallsBlocked`, `statusRefreshTimer`, `latestCtx`, `cancelledContinuationMarkers`, `extensionApi`. Import `goalState` + `__resetGoalState` from `state.ts`. Replace every bare reference (`activeGoal`, `continuationPending = …`, etc.) with `goalState.activeGoal`, `goalState.continuationPending`, …. Keep `goalOverlay` (l.218) and `STATUS_REFRESH_INTERVAL_MS` (l.224) in `goal.ts` (overlay is UI; the constant is orchestrator-local).

- [ ] **Step 1: Add the container + reset to `state.ts`** (code above); add a reset test:

```ts
test("__resetGoalState clears runtime state", () => {
	goalState.activeGoal = createGoal("x", undefined, 0);
	goalState.staleGoalToolCallsBlocked = true;
	goalState.cancelledContinuationMarkers.add("m");
	__resetGoalState();
	expect(goalState.activeGoal).toBeUndefined();
	expect(goalState.staleGoalToolCallsBlocked).toBe(false);
	expect(goalState.cancelledContinuationMarkers.size).toBe(0);
});
```

- [ ] **Step 2: Run — expect `goal.ts` compile errors** (bare `activeGoal` etc. no longer defined) — this is the expected mid-state.
- [ ] **Step 3: Migrate references in `goal.ts`** (`goalState.X` everywhere). `isGoalActive` becomes `return goalState.activeGoal?.status === "active";`.
- [ ] **Step 4: Run full gate** → green (the big safety-net moment: every `goal.test.ts` behavioral test must pass unchanged).
- [ ] **Step 5: Commit** — `git commit -m "refactor(core-task/goal): move runtime state behind GoalRuntimeState + __resetGoalState() seam"`.

## Task 6: Extract `persistence.ts`

**Files:** Create `src/goal/persistence.ts`, `src/goal/__tests__/persistence.test.ts`; modify `goal.ts`.

**Move from `goal.ts`** (verbatim): `GOAL_STATE_ENTRY_TYPE` (l.122), `STATE_FILE` (l.148), `readState`, `clearLegacyPersistedGoal` (l.1203), `cloneGoal`/`isGoal` (if not already in `state.ts` — they are after Task 4; import from there). Refactor `persistGoal` + `loadGoalFromSession` + `clearPersistedGoal` to take deps as params (no module-state reads):

```ts
export function persistGoal(api: { appendEntry: (t: string, d: unknown) => void } | undefined, goal: ActiveGoal): void {
	api?.appendEntry(GOAL_STATE_ENTRY_TYPE, { goal: cloneGoal(goal) });
}
export function clearPersistedGoal(api: ..., cwd: string): void { api?.appendEntry(GOAL_STATE_ENTRY_TYPE, { goal: null }); clearLegacyPersistedGoal(cwd); }
export function loadGoalFromSession(sessionManager: unknown): ActiveGoal | undefined { /* current body, reading entries off the passed sessionManager */ }
```

At `goal.ts` call sites, pass `goalState.extensionApi` / `ctx.sessionManager`.

- [ ] **Step 1: Write failing tests** — `src/goal/__tests__/persistence.test.ts` (temp-dir for legacy JSON + a fake `api`/`sessionManager`):

```ts
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { persistGoal, clearLegacyPersistedGoal, loadGoalFromSession } from "../persistence.js";
import { createGoal } from "../state.js";

test("persistGoal appends a goal-state entry", () => {
	const calls: [string, unknown][] = [];
	const api = { appendEntry: (t: string, d: unknown) => calls.push([t, d]) };
	persistGoal(api as never, createGoal("x", undefined, 0));
	expect(calls[0]![0]).toBe("goal-state");
});

test("clearLegacyPersistedGoal removes the cwd key", () => {
	const dir = mkdtempSync(join(tmpdir(), "gla-"));
	const file = join(dir, "pi-goal-state.json");
	writeFileSync(file, JSON.stringify({ [dir]: { id: "z" } }));
	process.env.PI_CODING_AGENT_DIR = dir; // STATE_FILE resolves under here
	clearLegacyPersistedGoal(dir);
	expect(JSON.parse((await import("fs")).readFileSync(file, "utf8"))[dir]).toBeUndefined();
	delete process.env.PI_CODING_AGENT_DIR;
});
```

- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Create `persistence.ts`** (move + parametrize); update `goal.ts` call sites.
- [ ] **Step 4: Run full gate** → green.
- [ ] **Step 5: Commit** — `git commit -m "refactor(core-task/goal): extract persistence into persistence.ts (deps injected)"`.

> **🛑 Phase 1 checkpoint** — `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )` green, `goal.ts` ≈ 500 lines, zero behavior change. Review before Phase 2.

---

# Phase 2 — Harden the loop driver (T02)

## Task 7: Add `backoff.ts` (pure predicates, ported)

**Files:** Create `src/goal/backoff.ts`, `src/goal/__tests__/backoff.test.ts`. (No `goal.ts` edit yet.)

Port verbatim from `../pi-goal-list-loop-audit/extensions/goal-loop-backoff.ts`, **dropping** loop-3/auditor-only exports (`MEASURE_TIMEOUT_MS`, `AUDITOR_STALL_MS`, `BACKOFF_IDLE_RETRY_MS`) and **tuning** `HEARTBEAT_STALL_MS` to `120_000` (more generous than the reference's unattended-rig 60 s — core-task's user is usually present; D2).

```ts
export const BACKOFF_HARD_CAP_MS = 5 * 60 * 1000;
export const BACKOFF_ERROR_BASE_MS = 5_000;
export const BACKOFF_ERROR_MAX_MS = 60_000;

/** Backoff (ms) before the next iteration, from consecutive stuck iterations. Caps at 5 min. */
export function backoffMs(stuckCount: number, mode: "stuck" | "error" | "context" = "stuck"): number {
	if (mode === "error") return Math.min(BACKOFF_ERROR_BASE_MS * 2 ** Math.max(0, stuckCount - 1), BACKOFF_ERROR_MAX_MS);
	if (mode === "context") return Math.min(30_000 * Math.max(1, stuckCount), BACKOFF_HARD_CAP_MS);
	const schedule = [0, 30_000, 60_000, 120_000, 240_000, BACKOFF_HARD_CAP_MS];
	return schedule[Math.max(0, Math.min(schedule.length - 1, stuckCount))] ?? BACKOFF_HARD_CAP_MS;
}

export function shouldPauseAfterBackoff(stuckElapsedMs: number, idleIterCount: number): boolean {
	if (stuckElapsedMs >= BACKOFF_HARD_CAP_MS) return true;
	if (idleIterCount >= 3) return true;
	return false;
}

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALL_MS = 120_000; // tuned (D2): generous for a present user
export const HEARTBEAT_MAX_NUDGES = 3;
export const WEDGE_ALERT_DEFAULT_MINUTES = 30;

export interface HeartbeatInput {
	supervising: boolean; sessionIdle: boolean; timerPending: boolean;
	msSinceActivity: number; stallMs?: number;
}
export function shouldHeartbeatRefire(i: HeartbeatInput): boolean {
	if (!i.supervising || !i.sessionIdle || i.timerPending) return false;
	return i.msSinceActivity >= (i.stallMs ?? HEARTBEAT_STALL_MS);
}
export function accountTurnForNudges(toolCalls: number, currentNudges: number): number {
	return toolCalls > 0 ? 0 : currentNudges + 1;
}

export interface WedgeInput {
	supervising: boolean; sessionBusy: boolean; silentMs: number;
	msSinceLastAlert: number; thresholdMs: number;
}
export function shouldWedgeAlert(i: WedgeInput): boolean {
	if (!i.supervising || !i.sessionBusy || i.thresholdMs <= 0 || i.silentMs < i.thresholdMs) return false;
	return i.msSinceLastAlert >= i.thresholdMs;
}
```

- [ ] **Step 1: Write failing tests** — `src/goal/__tests__/backoff.test.ts`:

```ts
import { test, expect } from "bun:test";
import { backoffMs, shouldPauseAfterBackoff, shouldHeartbeatRefire, accountTurnForNudges, shouldWedgeAlert, BACKOFF_HARD_CAP_MS, HEARTBEAT_STALL_MS } from "../backoff.js";

test("backoffMs follows the stuck schedule then caps", () => {
	expect(backoffMs(0)).toBe(0);
	expect(backoffMs(1)).toBe(30_000);
	expect(backoffMs(4)).toBe(240_000);
	expect(backoffMs(99)).toBe(BACKOFF_HARD_CAP_MS);
});
test("shouldPauseAfterBackoff trips at the cap or 3 idle iters", () => {
	expect(shouldPauseAfterBackoff(BACKOFF_HARD_CAP_MS, 0)).toBe(true);
	expect(shouldPauseAfterBackoff(0, 3)).toBe(true);
	expect(shouldPauseAfterBackoff(1000, 1)).toBe(false);
});
test("shouldHeartbeatRefire needs supervising+idle+stalled", () => {
	const base = { supervising: true, sessionIdle: true, timerPending: false, msSinceActivity: HEARTBEAT_STALL_MS };
	expect(shouldHeartbeatRefire(base)).toBe(true);
	expect(shouldHeartbeatRefire({ ...base, sessionIdle: false })).toBe(false);
	expect(shouldHeartbeatRefire({ ...base, timerPending: true })).toBe(false);
	expect(shouldHeartbeatRefire({ ...base, msSinceActivity: 1000 })).toBe(false);
});
test("accountTurnForNudges resets on tools, else increments", () => {
	expect(accountTurnForNudges(2, 1)).toBe(0);
	expect(accountTurnForNudges(0, 1)).toBe(2);
});
test("shouldWedgeAlert throttles to once per threshold", () => {
	const base = { supervising: true, sessionBusy: true, silentMs: 31 * 60_000, thresholdMs: 30 * 60_000 };
	expect(shouldWedgeAlert({ ...base, msSinceLastAlert: 31 * 60_000 })).toBe(true);
	expect(shouldWedgeAlert({ ...base, msSinceLastAlert: 1000 })).toBe(false);
});
```

- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Create `backoff.ts`** (code above).
- [ ] **Step 4: Run — verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(core-task/goal): add backoff/heartbeat/wedge predicates (ported, pure)"`.

## Task 8: Add `repetition.ts` (pure classifier, ported)

**Files:** Create `src/goal/repetition.ts`, `src/goal/__tests__/repetition.test.ts`. (No `goal.ts` edit yet.)

Port verbatim from `../pi-goal-list-loop-audit/extensions/goal-loop-repetition.ts` (clean-room; no code shared with AGPL pi-loop-mode). Full module:

```ts
import { createHash } from "crypto";

export const REPETITION = {
	similarityThreshold: 0.8, minExactLength: 80, minSimilarLength: 60, windowRepeat: 3,
	printWindow: 12, textWindow: 3, toolWindow: 6, toolResultRepeat: 3, toollessIterations: 2,
	degenerateMinLength: 150, degenerateSentenceRepeats: 4, degenerateWordRepeats: 16,
	degeneratePhraseRepeats: 8, degenerateMaxPhraseWords: 4, hardResetAfter: 3, maxInterventions: 5,
} as const;

export function normalizeForPrint(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}
export function textFingerprint(text: string): string {
	return createHash("sha256").update(normalizeForPrint(text).slice(0, 4000)).digest("hex").slice(0, 16);
}
function canonical(text: string): string { return normalizeForPrint(text).replace(/\d+/g, "#"); }
function wordTrigrams(text: string): Set<string> {
	const words = canonical(text).split(" ").filter(Boolean);
	const out = new Set<string>();
	if (words.length < 3) { if (words.length) out.add(words.join(" ")); return out; }
	for (let i = 0; i + 3 <= words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
	return out;
}
export function trigramSimilarity(a: string, b: string): number {
	const sa = wordTrigrams(a), sb = wordTrigrams(b);
	if (sa.size === 0 || sb.size === 0) return 0;
	let shared = 0; for (const t of sa) if (sb.has(t)) shared++;
	return shared / (sa.size + sb.size - shared);
}
export interface DegenerateRepeat { kind: "sentence" | "word" | "phrase"; unit: string; count: number; }
function tokenRun(text: string): DegenerateRepeat | undefined {
	const tokens = normalizeForPrint(text).match(/[\p{L}\p{N}_'-]+/gu) ?? [];
	for (let width = 1; width <= REPETITION.degenerateMaxPhraseWords; width++) {
		const needed = width === 1 ? REPETITION.degenerateWordRepeats : REPETITION.degeneratePhraseRepeats;
		for (let start = 0; start + width * needed <= tokens.length; start++) {
			let run = 1;
			while (start + (run + 1) * width <= tokens.length &&
				tokens.slice(start, start + width).join("") === tokens.slice(start + run * width, start + (run + 1) * width).join("")) run++;
			if (run >= needed) return { kind: width === 1 ? "word" : "phrase", unit: tokens.slice(start, start + width).join(" "), count: run };
		}
	}
	return undefined;
}
export function findDegenerateRepeat(text: string): DegenerateRepeat | undefined {
	const canon = canonical(text);
	if (canon.length < REPETITION.degenerateMinLength) return undefined;
	const sentences = canon.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length >= 15);
	if (sentences.length >= REPETITION.degenerateSentenceRepeats) {
		const counts = new Map<string, number>();
		for (const s of sentences) counts.set(s, (counts.get(s) ?? 0) + 1);
		let unit = "", best = 0;
		for (const [s, n] of counts) if (n > best) { unit = s; best = n; }
		if (best >= REPETITION.degenerateSentenceRepeats && best / sentences.length >= 0.5) return { kind: "sentence", unit, count: best };
	}
	return tokenRun(text);
}
export interface ToolResultPrint { tool: string; hash: string; isError: boolean; }
export interface LoopStuckInput {
	assistantText: string; recentPrints: string[]; previousText?: string;
	recentToolResults: ToolResultPrint[]; toollessStreak: number;
}
function clip(text: string, n: number): string { const f = text.replace(/\s+/g, " ").trim(); return f.length <= n ? f : `${f.slice(0, n)}…`; }
export function detectLoopStuck(input: LoopStuckInput): string | undefined {
	const { assistantText, recentPrints, previousText, recentToolResults, toollessStreak } = input;
	if (toollessStreak >= REPETITION.toollessIterations) return `no tool calls for ${toollessStreak} iterations (narration only)`;
	const degenerate = findDegenerateRepeat(assistantText);
	if (degenerate) return `response degenerated: same ${degenerate.kind} repeated ${degenerate.count}× ("${clip(degenerate.unit, 60)}")`;
	const lastTwo = recentPrints.slice(-2);
	if (lastTwo.length === 2 && lastTwo[0] === lastTwo[1] && normalizeForPrint(assistantText).length > REPETITION.minExactLength) return "repeated the previous response exactly";
	if (previousText && normalizeForPrint(assistantText).length > REPETITION.minSimilarLength) {
		const sim = trigramSimilarity(assistantText, previousText);
		if (sim >= REPETITION.similarityThreshold) return `response ~${Math.round(sim * 100)}% similar to the previous iteration`;
	}
	const current = recentPrints[recentPrints.length - 1];
	if (current && recentPrints.filter((p) => p === current).length >= REPETITION.windowRepeat) return `same response ${REPETITION.windowRepeat}+ times in recent iterations`;
	const recentTools = recentToolResults.slice(-REPETITION.toolResultRepeat);
	if (recentTools.length === REPETITION.toolResultRepeat && recentTools.every((r) => r.tool === recentTools[0]!.tool && r.hash === recentTools[0]!.hash))
		return recentTools.every((r) => r.isError) ? `same ${recentTools[0]!.tool} error ${REPETITION.toolResultRepeat}× in a row` : `same ${recentTools[0]!.tool} result ${REPETITION.toolResultRepeat}× in a row (no new information)`;
	return undefined;
}
export function loopInterventionDirective(consecutiveStuck: number, reason: string, recentTexts: string[]): string {
	const strategies = [
		"Abandon the current angle entirely. Pick a genuinely different approach — different file, different technique — and execute it now.",
		"Switch to a part of the target you have NOT touched in recent iterations and make one concrete, inspectable change there.",
		"Write a short PROGRESS.md: current state, what was tried, what keeps failing, the next 3 concrete steps. Then execute step 1.",
		"Run the project's build/tests, pick exactly ONE failure or warning, and fix only that.",
		"Review your recent changes (git diff / git log), find one real problem in them, and fix it.",
	];
	const strategy = strategies[(consecutiveStuck - 1) % strategies.length]!;
	let escalation = "";
	if (consecutiveStuck >= REPETITION.hardResetAfter) {
		const banned = recentTexts.map((t) => clip(normalizeForPrint(t), 40)).filter(Boolean).map((t) => `"${t}"`).join(", ");
		escalation = ` HARD RESET (stuck intervention #${consecutiveStuck} in a row): forget your previous phrasing entirely.` +
			(banned ? ` Banned openings: ${banned}.` : "") +
			" Your FIRST action this turn must be a tool call that changes a file or produces new information — zero preamble text before it.";
	}
	return `⚠ STUCK — ${reason}.${escalation} ${strategy}`;
}
export function pushCapped<T>(arr: T[], item: T, cap: number): T[] {
	const next = [...arr, item];
	return next.length > cap ? next.slice(next.length - cap) : next;
}
```

- [ ] **Step 1: Write failing tests** — `src/goal/__tests__/repetition.test.ts`:

```ts
import { test, expect } from "bun:test";
import { detectLoopStuck, trigramSimilarity, loopInterventionDirective, pushCapped } from "../repetition.js";

test("detectLoopStuck: narration-only after 2 toolless iters", () => {
	expect(detectLoopStuck({ assistantText: "thinking…", recentPrints: ["a"], recentToolResults: [], toollessStreak: 2 })).toMatch(/narration only/);
});
test("detectLoopStuck: near-duplicate previous response", () => {
	const a = "I will now refactor the goal module by extracting the overflow helpers into a separate file for testability.";
	const b = "I will now refactor the goal module by extracting overflow helpers into a separate file for testability.";
	expect(detectLoopStuck({ assistantText: b, recentPrints: ["x", "y"], previousText: a, recentToolResults: [], toollessStreak: 0 })).toMatch(/similar/);
});
test("detectLoopStuck: undefined when progressing normally", () => {
	expect(detectLoopStuck({ assistantText: "did something new and different this time around", recentPrints: ["x", "y"], previousText: "totally different earlier work", recentToolResults: [], toollessStreak: 0 })).toBeUndefined();
});
test("trigramSimilarity: identity = 1, disjoint = 0", () => {
	expect(trigramSimilarity("the quick brown fox", "the quick brown fox")).toBe(1);
	expect(trigramSimilarity("alpha beta gamma", "one two three four five six")).toBe(0);
});
test("loopInterventionDirective escalates at hardResetAfter", () => {
	const d1 = loopInterventionDirective(1, "r", []);
	const d3 = loopInterventionDirective(3, "r", []);
	expect(d1).not.toContain("HARD RESET");
	expect(d3).toContain("HARD RESET");
});
test("pushCapped trims to cap", () => {
	expect(pushCapped([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
});
```

- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Create `repetition.ts`** (code above).
- [ ] **Step 4: Run — verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(core-task/goal): add anti-repetition classifier + interventions (ported, pure)"`.

## Task 9: Wire backoff cap + anti-repetition into `agent_end`

**Files:** Modify `src/goal/goal.ts` (+ `state.ts` for the new rolling counters); test `src/goal/__tests__/hardening-loop.test.ts`.

**Add to `GoalRuntimeState` (`state.ts`):** `consecutiveStuck: number`, `stuckStartedAt: number | undefined`, `recentPrints: string[]`, `recentTexts: string[]`, `recentToolResults: ToolResultPrint[]`, `toollessStreak: number`. Reset them in `__resetGoalState()` + on each goal start (in `startGoal`).

**Wire into the `agent_end` handler** — replace the final `await sendContinuationPrompt(pi, ctx, currentGoal);` (end of the handler, l. ~489) with the stuck-aware path:

```ts
// classify this iteration; update rolling windows
const assistantText = finalAssistant?.content?.map((c) => c.text ?? "").join(" ") ?? "";
const print = textFingerprint(assistantText);
goalState.recentPrints = pushCapped(goalState.recentPrints, print, REPETITION.printWindow);
goalState.recentTexts = pushCapped(goalState.recentTexts, assistantText.slice(0, 1000), REPETITION.textWindow);
// (recentToolResults + toollessStreak are updated in tool_execution_end: see Step 3)
const reason = detectLoopStuck({
	assistantText, recentPrints: goalState.recentPrints, previousText: goalState.recentTexts[goalState.recentTexts.length - 2],
	recentToolResults: goalState.recentToolResults, toollessStreak: goalState.toollessStreak,
});

if (reason) {
	goalState.consecutiveStuck += 1;
	if (goalState.stuckStartedAt === undefined) goalState.stuckStartedAt = Date.now();
	if (goalState.consecutiveStuck >= REPETITION.maxInterventions) {
		pauseGoalAfterAgentEnd(ctx, currentGoal, { stopReason: "stop" } as never); // 5-stuck → stop
		ctx.ui.notify(`Goal paused: stuck for ${goalState.consecutiveStuck} iterations (${reason}).`, "warning");
		return;
	}
	if (shouldPauseAfterBackoff(Date.now() - goalState.stuckStartedAt, goalState.toollessStreak)) {
		pauseGoalAfterAgentEnd(ctx, currentGoal, { stopReason: "stop" } as never); // 5-min cap / 3 idle → pause
		ctx.ui.notify(`Goal paused: backoff cap reached (${reason}).`, "warning");
		return;
	}
	// swap in the rotating intervention instead of the normal continuation
	await sendPrompt(pi, ctx, loopInterventionDirective(goalState.consecutiveStuck, reason, goalState.recentTexts));
	return;
}

// not stuck — reset, optional brief backoff, then normal continuation
goalState.consecutiveStuck = 0;
goalState.stuckStartedAt = undefined;
const wait = backoffMs(0);
if (wait > 0) await new Promise((r) => setTimeout(r, wait));
await sendContinuationPrompt(pi, ctx, currentGoal);
```

Also: `import { backoffMs, shouldPauseAfterBackoff } from "./backoff.js"; import { detectLoopStuck, loopInterventionDirective, textFingerprint, pushCapped, REPETITION, type ToolResultPrint } from "./repetition.js";`.

- [ ] **Step 1: Write a failing integration test** — `src/goal/__tests__/hardening-loop.test.ts` using `__resetGoalState()` + a fake `pi`/`ctx` (mirror the harness in `goal.test.ts`'s `pause`/`clear` tests): feed two near-duplicate assistant turns → assert `goalState.consecutiveStuck === 2` and that the second turn's sent prompt contains `STUCK`; feed a fifth → assert the goal transitioned to `paused`.
- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Implement** — add the state fields, wire the handler block above, and update `tool_execution_end` to push `recentToolResults` (`{ tool, hash: textFingerprint(output), isError }`) and set `toollessStreak = 0` on a tool call (else it's incremented per turn in `agent_end`). Reset all five counters in `startGoal` + `__resetGoalState`.
- [ ] **Step 4: Run full gate** → green (existing suite + new test).
- [ ] **Step 5: Commit** — `git commit -m "feat(core-task/goal): backoff cap + anti-repetition in agent_end (5-stuck stop, 5-min pause)"`.

## Task 10: Wire heartbeat self-watchdog + wedge alert

**Files:** Modify `src/goal/goal.ts`; test additions to `hardening-loop.test.ts`.

**Add a heartbeat interval** alongside the existing status-refresh timer (started/stopped via `syncStatusRefreshTimer`, l.719 — extend it, or add `syncHeartbeatTimer()`):

```ts
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let lastActivityAt = Date.now();
let lastWedgeAlertAt = 0;

function syncHeartbeatTimer() {
	const shouldRun = goalState.activeGoal?.status === "active";
	if (shouldRun && !heartbeatTimer) {
		heartbeatTimer = setInterval(() => {
			const ctx = goalState.latestCtx as StatusContext | undefined;
			if (!ctx) return;
			if (shouldHeartbeatRefire({ supervising: true, sessionIdle: !!ctx.isIdle?.(), timerPending: !!goalState.continuationPending, msSinceActivity: Date.now() - lastActivityAt })) {
				void sendContinuationPrompt(piRef!, ctx, goalState.activeGoal!); // re-fire (throttled by continuationPending guard)
			}
			if (shouldWedgeAlert({ supervising: true, sessionBusy: !ctx.isIdle?.(), silentMs: Date.now() - lastActivityAt, msSinceLastAlert: Date.now() - lastWedgeAlertAt, thresholdMs: WEDGE_ALERT_DEFAULT_MINUTES * 60_000 })) {
				lastWedgeAlertAt = Date.now();
				ctx.ui.notify(`Goal wedge: no activity for ${WEDGE_ALERT_DEFAULT_MINUTES}m. A long command may be holding the session.`, "warning");
			}
		}, HEARTBEAT_INTERVAL_MS);
		heartbeatTimer.unref?.();
	} else if (!shouldRun && heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
}
```

Update `lastActivityAt = Date.now()` in `tool_execution_end`, `agent_end`, and `input`. Call `syncHeartbeatTimer()` wherever `syncStatusRefreshTimer()` is called. (`piRef` = capture the `pi` arg of `goal()` at registration into a module ref, like `extensionApi`.)

Add `nudgeCount` to `GoalRuntimeState`; in `agent_end`, `goalState.nudgeCount = accountTurnForNudges(toolCallsThisTurn, goalState.nudgeCount)`; if `nudgeCount >= HEARTBEAT_MAX_NUDGES` → pause.

- [ ] **Step 1: Write a failing test** — drive `__resetGoalState()`, start a goal with a fake idle `ctx`, advance fake timers (use `Bun.escapeCalling... `or stub `setInterval` like `goal.test.ts`'s status-refresh test at l.180 does) past `HEARTBEAT_STALL_MS`, assert `sendContinuationPrompt`/`sendUserMessage` was called again (heartbeat refire); assert a no-tool turn increments `nudgeCount` and 3 such turns pause the goal.
- [ ] **Step 2: Run — verify fail.**
- [ ] **Step 3: Implement** the timer + activity stamping + nudge accounting above.
- [ ] **Step 4: Run full gate** → green.
- [ ] **Step 5: Commit** — `git commit -m "feat(core-task/goal): heartbeat self-watchdog + wedge alert (15s/120s/3-nudge)"`.

## Task 11: Remove the legacy `pi-goal-state.json`

**Files:** Modify `src/goal/persistence.ts`, `src/goal/goal.ts`; verify.

- [ ] **Step 1: Confirm no live readers** — `grep -rn "pi-goal-state" --include=*.ts .` (expect only `persistence.ts` itself) and confirm no other repo/rig reads `~/.pi/agent/pi-goal-state.json`.
- [ ] **Step 2: Remove** `STATE_FILE`, `readState`, `clearLegacyPersistedGoal` from `persistence.ts`; drop the `clearLegacyPersistedGoal(cwd)` call in `clearPersistedGoal`. Update `goal.ts` imports.
- [ ] **Step 3: Update `persistence.test.ts`** — delete the `clearLegacyPersistedGoal` temp-dir test; keep `persistGoal`/`loadGoalFromSession` tests.
- [ ] **Step 4: Run full gate** → green.
- [ ] **Step 5: Commit** — `git commit -m "refactor(core-task/goal): remove legacy pi-goal-state.json (session-store is the only path)"`.

> **✅ Done** — `goal.ts` ≈ 500 lines; backoff cap + heartbeat + anti-repetition + wedge alert live; every predicate unit-tested; full suite + typecheck green. T01 + T02 of the wayfinder map are realized. T04 (opt-in auditor) is now unblocked on this clean base.

---

## Self-Review (run before handoff)

1. **Spec coverage** — §2 modularization → Tasks 1–6 ✓; §3 backoff cap → Task 7+9 ✓, heartbeat → Task 7+10 ✓, anti-repetition → Task 8+9 ✓, wedge → Task 7+10 ✓; §4 testing → every task ships tests ✓; §6 rollout (incremental, legacy removal) → Task 11 ✓; §5 decisions locked (D1 medium, D2 all-three) ✓.
2. **Placeholder scan** — no TBD/TODO; every code step shows code or a verbatim line-range move; every test step shows real assertions.
3. **Type consistency** — `buildGoalSystemPrompt(goal, planLine)` / `buildContinuePrompt(goal, marker, planLine)` (Task 3) match call sites updated in Task 9; `GoalRuntimeState` fields added in Task 9 (consecutiveStuck, recentPrints, …) and consumed in Task 10 are named consistently; `ToolResultPrint` imported from `repetition.js` in both Task 9 state + test.
4. **Risk note** — Task 5 (container migration) is the widest diff; it has a documented fallback (keep `let`s, add `__resetGoalState()` in `goal.ts`). Task 9's `pauseGoalAfterAgentEnd(ctx, goal, {stopReason:"stop"})` cast — verify `pauseGoalAfterAgentEnd`'s 3rd-param shape at execution time; if it needs a real assistant message, pass `finalAssistant` instead.
