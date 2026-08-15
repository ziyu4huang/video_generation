# core-task length-continue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port GLA's `length-continue` into core-task so a response truncated by the model's per-response output cap (`stopReason === "length"`) auto-continues instead of dead-stopping on unattended rigs.

**Architecture:** A pure module `src/goal/length-continue.ts` (verbatim port of GLA's 72-line tracker) + a thin wiring at the very top of `goal.ts`'s `agent_end` handler that ticks the tracker, re-triggers the agent with `pi.sendUserMessage`, and `return`s to skip all turn bookkeeping for the half-response. Pure-module + injected-side-effects invariant (mirrors `reviewer.ts`).

**Tech Stack:** TypeScript, Bun (`bun:test`), `@earendil-works/pi-coding-agent` ExtensionAPI (`pi.sendUserMessage`, `pi.appendEntry`, `ctx.ui.notify`).

## Global Constraints

- **Pure module:** `src/goal/length-continue.ts` has ZERO `@earendil-works/*` imports (only stdlib/types). All side effects (`pi.sendUserMessage`, `pi.appendEntry`, `ctx.ui.notify`) live in `goal.ts` wiring. (Invariant established by `reviewer.ts`/`shield.ts`/`list.ts`.)
- **Faithful verbatim baseline:** the pure module is a verbatim port of GLA `extensions/length-continue.ts`; the wiring maps GLA APIs to core-task APIs (`sendMessage`→`sendUserMessage`, `appendLedger`→`appendEntry`, `goStaleTerminal`→try/catch, `notifyExternal`→dropped). See spec §11 D5.
- **No `/glla` references:** the give-up notify text is core-task-style (drop `glla:` prefix / `/glla`). Reviewer M2 lesson.
- **`LENGTH_CONTINUE_MAX = 3`**, `LENGTH_CONTINUE_TEXT` ports verbatim (generic wording).
- **Never block / never crash the handler:** the wiring is `try/catch`-wrapped; a stale API handle logs a ledger failure and does not rethrow.
- **Compose with PR #962:** edits are in `agent_end`; Reviewer edits `goal_complete`. Branch off `main`; zero conflict.
- **Tests:** `bunx tsc --noEmit` exit 0 (per-package AND cross-package `( cd bun-apps/pi-agent && bun run typecheck )`); `bun test` green. `bun test` alone does NOT run tsc — every implementer shows real `bunx tsc --noEmit` exit, not just `bun test` (Reviewer verify-gate lesson).
- **Shell discipline:** no top-level `cd`. Use `( cd bun-apps/pi-agent-ext-core-task && ... )`. Run from repo root.
- **Effort dir:** `.planning/2026-07-31-core-task-length-continue/` (spec + this plan + sdd).

---

## File Structure

- **Create** `src/goal/length-continue.ts` — pure tracker module (verbatim port). Exports `LENGTH_CONTINUE_MAX`, `LENGTH_CONTINUE_TEXT`, `LengthContinueTick`, `makeLengthContinueTracker`, `tickLengthContinue`, `resetLengthContinue`.
- **Create** `src/goal/__tests__/length-continue.test.ts` — pure-module unit tests (tracker behavior, singleton reset, constants).
- **Modify** `src/goal/__tests__/hardening-loop.test.ts` — ADD the length-continue wiring tests + a `fireAgentEndLength` helper + the `LENGTH_CONTINUE_TEXT`/`resetLengthContinue` import. REUSE its existing `createMockPi`/`createMockCtx`/`createMockOverlay`/`bootstrap`/`shutdown`/`fireAgentEnd` — do NOT duplicate the harness.
- **Modify** `src/goal/goal.ts` — (a) top of `agent_end` handler (~line 647): hoist `findFinalAssistantMessage`, add the length-continue block; (b) add `sendLengthContinue(pi, ctx, consecutive)` helper; (c) `session_start` handler (~line 534): call `resetLengthContinue()`; (d) import from `./length-continue.js`.

---

## Task 1: Pure module `length-continue.ts` (verbatim) + unit tests

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/goal/length-continue.ts`
- Test: `bun-apps/pi-agent-ext-core-task/src/goal/__tests__/length-continue.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (used by Task 2):
  - `LENGTH_CONTINUE_MAX: number` (= 3)
  - `LENGTH_CONTINUE_TEXT: string`
  - `type LengthContinueTick = { fire: boolean; giveUpNow: boolean; consecutive: number }`
  - `makeLengthContinueTracker(max?: number): { tick(stopped: boolean): LengthContinueTick; get consecutive(): number }`
  - `tickLengthContinue(stopped: boolean): LengthContinueTick` (module singleton)
  - `resetLengthContinue(): void`

- [ ] **Step 1: Write the failing tests**

Create `src/goal/__tests__/length-continue.test.ts`:

```typescript
import { test, expect, describe } from "bun:test";
import {
	LENGTH_CONTINUE_MAX,
	LENGTH_CONTINUE_TEXT,
	makeLengthContinueTracker,
	tickLengthContinue,
	resetLengthContinue,
} from "../length-continue.js";

describe("makeLengthContinueTracker", () => {
	test("a normal turn (stopped=false) does not fire and resets the streak", () => {
		const t = makeLengthContinueTracker();
		expect(t.tick(false)).toEqual({ fire: false, giveUpNow: false, consecutive: 0 });
	});

	test("a truncated turn fires and increments the streak", () => {
		const t = makeLengthContinueTracker();
		expect(t.tick(true)).toEqual({ fire: true, giveUpNow: false, consecutive: 1 });
		expect(t.tick(true).consecutive).toBe(2);
		expect(t.tick(true).consecutive).toBe(3);
	});

	test("after MAX consecutive truncations it gives up once, then stops firing", () => {
		const t = makeLengthContinueTracker(); // max = 3
		t.tick(true); t.tick(true); t.tick(true); // 1,2,3 — all fire
		const over = t.tick(true); // 4 > MAX
		expect(over.fire).toBe(false);
		expect(over.giveUpNow).toBe(true);
		expect(over.consecutive).toBe(4);
		const still = t.tick(true); // 5 — still over, already gave up
		expect(still.fire).toBe(false);
		expect(still.giveUpNow).toBe(false);
	});

	test("a normal turn after the cap resets gaveUp, so a later truncate fires again", () => {
		const t = makeLengthContinueTracker();
		for (let i = 0; i < 4; i++) t.tick(true); // hit cap + give up
		t.tick(false); // normal turn resets
		expect(t.tick(true)).toEqual({ fire: true, giveUpNow: false, consecutive: 1 });
	});
});

describe("module singleton", () => {
	test("resetLengthContinue zeroes the singleton streak", () => {
		resetLengthContinue();
		tickLengthContinue(true);
		tickLengthContinue(true);
		expect(tickLengthContinue(true).consecutive).toBe(3);
		resetLengthContinue();
		expect(tickLengthContinue(true).consecutive).toBe(1);
	});
});

describe("constants", () => {
	test("MAX is 3 and the continue text instructs continuing where it stopped", () => {
		expect(LENGTH_CONTINUE_MAX).toBe(3);
		expect(LENGTH_CONTINUE_TEXT).toMatch(/Continue EXACTLY where you stopped/);
		expect(LENGTH_CONTINUE_TEXT.length).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/length-continue.test.ts )`
Expected: FAIL — `Cannot find module "../length-continue.js"` (module does not exist yet).

- [ ] **Step 3: Write the implementation (verbatim port of GLA's module)**

Create `src/goal/length-continue.ts`:

```typescript
// Auto-continue for output-token truncation. When ONE assistant response
// exceeds the model's provider-side per-response output cap, pi ends the turn
// with stopReason "length" and idles — a dead stop on unattended rigs. The
// tracker decides when to re-trigger; goal.ts's agent_end handler wires it
// BEFORE all turn bookkeeping: a truncated turn is not a completed turn (no
// telemetry), not a stall (no no-tool nudge), and must not run the normal goal
// continuation on half a response.
//
// Guards:
//   - consecutive cap: after MAX back-to-back truncations, give up (once)
//     instead of burning quota in a truncation ping-pong. Any normally
//     finished turn resets the counter.
//   - the caller skips when messages are already pending (a queued message
//     triggers a turn anyway).
//
// Pure module — zero @earendil-works/* imports. All side effects (sending the
// continue message, notify, ledger) live in the goal.ts wiring.
//
// Verbatim port of GLA extensions/length-continue.ts (faithful baseline).

export const LENGTH_CONTINUE_MAX = 3;

export const LENGTH_CONTINUE_TEXT = [
	"Your previous response was cut off at the model's per-response output token limit.",
	"Continue EXACTLY where you stopped — finish the current artifact, then keep going.",
	"Keep each individual response shorter from here: split large file writes into multiple smaller write/edit calls across turns instead of one giant response.",
].join(" ");

export interface LengthContinueTick {
	/** Send the continue message this round. */
	fire: boolean;
	/** The cap was just exceeded — notify the give-up exactly once. */
	giveUpNow: boolean;
	/** Current consecutive truncation streak (after this tick). */
	consecutive: number;
}

export function makeLengthContinueTracker(max: number = LENGTH_CONTINUE_MAX) {
	let consecutive = 0;
	let gaveUp = false;
	return {
		tick(stopped: boolean): LengthContinueTick {
			if (!stopped) {
				consecutive = 0;
				gaveUp = false;
				return { fire: false, giveUpNow: false, consecutive: 0 };
			}
			consecutive++;
			if (consecutive > max) {
				const giveUpNow = !gaveUp;
				gaveUp = true;
				return { fire: false, giveUpNow, consecutive };
			}
			return { fire: true, giveUpNow: false, consecutive };
		},
		get consecutive(): number {
			return consecutive;
		},
	};
}

// Session-level singleton — one tracker per extension runtime. session_start
// calls resetLengthContinue() so a fresh session starts clean.
let tracker = makeLengthContinueTracker();

export function tickLengthContinue(stopped: boolean): LengthContinueTick {
	return tracker.tick(stopped);
}

export function resetLengthContinue(): void {
	tracker = makeLengthContinueTracker();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/length-continue.test.ts )`
Expected: PASS (all tests green).

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-core-task && bunx tsc --noEmit && echo TSC_EXIT=$? )`
Expected: `TSC_EXIT=0` (the new module is pure; no type errors).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/length-continue.ts bun-apps/pi-agent-ext-core-task/src/goal/__tests__/length-continue.test.ts
git commit -m "feat(core-task/length-continue): pure tracker module + unit tests (port from GLA)"
```

---

## Task 2: Wiring — agent_end integration + sendLengthContinue helper + session_start reset

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/goal.ts` (agent_end handler ~line 647; session_start ~line 534; new helper fn; import)
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/__tests__/hardening-loop.test.ts` (ADD wiring tests + `fireAgentEndLength` helper + import; REUSE the existing harness — do NOT duplicate `createMockPi`/`createMockCtx`/`createMockOverlay`/`bootstrap`/`shutdown`/`fireAgentEnd`)

**Interfaces:**
- Consumes (from Task 1): `tickLengthContinue(stopped): LengthContinueTick`, `resetLengthContinue(): void`, `LENGTH_CONTINUE_MAX`, `LENGTH_CONTINUE_TEXT`.
- Consumes (existing in goal.ts): `findFinalAssistantMessage(messages): ... | undefined`, `hasPendingMessages(ctx): boolean`, `pi.sendUserMessage(text, options?)`, `pi.appendEntry?(customType, data)`, `ctx.ui.notify(msg, level)`.
- Consumes (existing test harness in hardening-loop.test.ts): `createMockPi()` → `{ pi, commands, events, entries, sentUserMessages }`; `createMockCtx(overrides)` → `{ ctx, notifications }`; `bootstrap()` → fires `session_start` + starts a goal via the registered `/goal` command, returns `{ mock, ctx, notifications }`; `shutdown(mock, ctx)` → resets. `ActiveGoal.iteration` (state.ts) is the field `incrementGoal` bumps — the bookkeeping-skipped signal.
- Produces: the wired `agent_end` length-continue behavior + `sendLengthContinue(pi, ctx, consecutive)` helper.

- [ ] **Step 1: Write the failing wiring tests (ADD to hardening-loop.test.ts)**

Open `src/goal/__tests__/hardening-loop.test.ts`. Add the import next to the other `../` imports:

```typescript
import { LENGTH_CONTINUE_TEXT, resetLengthContinue } from "../length-continue.js";
```

Add this helper next to the existing `fireAgentEnd`:

```typescript
/** Fire an agent_end carrying a final assistant truncated at the output cap. */
async function fireAgentEndLength(mock: ReturnType<typeof createMockPi>, ctx: StatusContext, text = "x") {
	for (const h of mock.events.get("agent_end") ?? []) {
		await h(
			{ messages: [{ role: "assistant", stopReason: "length", content: [{ type: "text", text }] }] },
			ctx,
		);
	}
}
```

Add this describe block at the end of the file (reuses `bootstrap()`/`shutdown()` — a goal-active test starts with streak 0 and a real `activeGoal`; the no-goal / pending tests inline a minimal setup with no `/goal` call):

```typescript
describe("agent_end length-continue wiring", () => {
	test("a truncated turn re-triggers with LENGTH_CONTINUE_TEXT and skips bookkeeping", async () => {
		const { mock, ctx, notifications } = await bootstrap();
		try {
			const before = goalState.activeGoal?.iteration ?? 0;
			await fireAgentEndLength(mock, ctx);
			// fired the continue message exactly once, with followUp delivery
			expect(mock.sentUserMessages).toEqual([{ text: LENGTH_CONTINUE_TEXT, options: { deliverAs: "followUp" } }]);
			// fire-path notify present (consecutive/MAX)
			expect(notifications.some((n) => /auto-continuing \(1\/3\)/.test(n.message))).toBe(true);
			// ledger entry recorded
			expect(mock.entries.some((e) => e.customType === "length_continue_sent" && (e.data as { consecutive: number }).consecutive === 1)).toBe(true);
			// bookkeeping skipped: incrementGoal did NOT run (iteration unchanged)
			expect(goalState.activeGoal?.iteration).toBe(before);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("works with NO active goal (plain session truncates too)", async () => {
		__resetGoalState();
		resetLengthContinue();
		const mock = createMockPi();
		goal(mock.pi, createMockOverlay().impl);
		const { ctx } = createMockCtx();
		await (mock.events.get("session_start")?.[0] as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);
		try {
			expect(goalState.activeGoal).toBeUndefined();
			await fireAgentEndLength(mock, ctx);
			expect(mock.sentUserMessages).toEqual([{ text: LENGTH_CONTINUE_TEXT, options: { deliverAs: "followUp" } }]);
		} finally {
			for (const h of mock.events.get("session_shutdown") ?? []) await (h as (e: unknown, c: unknown) => void)({}, ctx);
			__resetGoalState();
		}
	});

	test("a non-length turn does NOT send the continue message", async () => {
		const { mock, ctx } = await bootstrap();
		try {
			await fireAgentEnd(mock, ctx, "normal turn text"); // stopReason "stop"
			expect(mock.sentUserMessages.some((m) => m.text === LENGTH_CONTINUE_TEXT)).toBe(false);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("pending messages suppress the send (a queued message triggers a turn anyway)", async () => {
		__resetGoalState();
		resetLengthContinue();
		const mock = createMockPi();
		goal(mock.pi, createMockOverlay().impl);
		const { ctx } = createMockCtx({ hasPendingMessages: () => true });
		await (mock.events.get("session_start")?.[0] as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);
		try {
			await fireAgentEndLength(mock, ctx);
			expect(mock.sentUserMessages).toEqual([]);
		} finally {
			for (const h of mock.events.get("session_shutdown") ?? []) await (h as (e: unknown, c: unknown) => void)({}, ctx);
			__resetGoalState();
		}
	});

	test("after MAX+1 consecutive truncations it gives up once and stops firing", async () => {
		const { mock, ctx, notifications } = await bootstrap();
		try {
			await fireAgentEndLength(mock, ctx); // 1 fire
			await fireAgentEndLength(mock, ctx); // 2 fire
			await fireAgentEndLength(mock, ctx); // 3 fire
			mock.sentUserMessages.length = 0;
			await fireAgentEndLength(mock, ctx); // 4 > MAX → giveUp, no fire
			expect(mock.sentUserMessages).toEqual([]);
			expect(notifications.some((n) => /stepping aside from auto-continue/.test(n.message))).toBe(true);
			await fireAgentEndLength(mock, ctx); // 5 — still suppressed, no second give-up
			expect(notifications.filter((n) => /stepping aside from auto-continue/.test(n.message)).length).toBe(1);
		} finally {
			await shutdown(mock, ctx);
		}
	});

	test("session_start resets the singleton streak (a later truncate fires again)", async () => {
		const { mock, ctx } = await bootstrap();
		try {
			await fireAgentEndLength(mock, ctx); // streak 1
			await (mock.events.get("session_start")?.[0] as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);
			mock.sentUserMessages.length = 0;
			await fireAgentEndLength(mock, ctx); // streak reset → fires again
			expect(mock.sentUserMessages).toEqual([{ text: LENGTH_CONTINUE_TEXT, options: { deliverAs: "followUp" } }]);
		} finally {
			await shutdown(mock, ctx);
		}
	});
});
```

- [ ] **Step 2: Run the wiring tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/hardening-loop.test.ts -t "length-continue" )`
Expected: FAIL — the `agent_end` handler does not yet call `tickLengthContinue`/`sendLengthContinue`; `sentUserMessages` is empty where the tests expect a continue message. (Task 1 must be merged first.)

- [ ] **Step 3: Implement the wiring in goal.ts**

**(3a) Add the import** near the other `./` imports at the top of `src/goal/goal.ts`:

```typescript
import { LENGTH_CONTINUE_MAX, LENGTH_CONTINUE_TEXT, tickLengthContinue, resetLengthContinue } from "./length-continue.js";
```

**(3b) Add the `sendLengthContinue` helper** (place it near `sendContinuationPrompt`):

```typescript
/**
 * length-continue (GLA faithful baseline): re-trigger the agent after a
 * truncated response. The text is constant (LENGTH_CONTINUE_TEXT); `consecutive`
 * drives the fire-path notify + the ledger. Wrapped in try/catch so a stale API
 * handle never crashes the agent_end handler (GLA's goStaleTerminal intent).
 */
function sendLengthContinue(pi: ExtensionAPI, ctx: StatusContext, consecutive: number): void {
	try {
		pi.sendUserMessage(LENGTH_CONTINUE_TEXT, { deliverAs: "followUp" });
		pi.appendEntry?.("length_continue_sent", { consecutive });
		ctx.ui.notify(`Response hit the output-token cap — auto-continuing (${consecutive}/${LENGTH_CONTINUE_MAX})`, "warning");
	} catch (err) {
		pi.appendEntry?.("length_continue_send_failed", { consecutive, error: err instanceof Error ? err.message : String(err) });
	}
}
```

**(3c) Wire the top of the `agent_end` handler.** Find the handler:
```typescript
	pi.on("agent_end", async (event: { messages?: unknown[] }, ctx: StatusContext) => {
		// Loop 3 dispatch: a live loop drives the continuation, not a goal.
		if (isLoopActive()) {
```
**Hoist `findFinalAssistantMessage` to the very top and insert the length-continue block BEFORE the `isLoopActive()` dispatch** (so it covers `/loop` and plain sessions, not just the goal loop). Remove the now-duplicate `const finalAssistant = findFinalAssistantMessage(...)` that currently sits a few lines below the no-goal bail (the hoisted binding is in scope for the later `stopReason === "aborted"/"error"` check):

```typescript
	pi.on("agent_end", async (event: { messages?: unknown[] }, ctx: StatusContext) => {
		// length-continue (folded-in, GLA faithful baseline): a truncated turn is
		// NOT a completed turn — re-trigger with split-smaller guidance and skip
		// ALL turn bookkeeping (no liveness stamp, no incrementGoal, no usage, no
		// nudge/repetition, no continuation). Placed before the loop dispatch and
		// the no-goal bail so it also covers /loop and plain (no-goal) sessions.
		const finalAssistant = findFinalAssistantMessage(event.messages ?? []);
		const lc = tickLengthContinue(finalAssistant?.stopReason === "length");
		if (lc.giveUpNow) {
			ctx.ui.notify(
				`Response hit the output-token cap ${LENGTH_CONTINUE_MAX}× in a row — stepping aside from auto-continue. Ask the model to split the work into smaller pieces.`,
				"warning",
			);
		}
		if (finalAssistant?.stopReason === "length") {
			if (lc.fire && !hasPendingMessages(ctx)) sendLengthContinue(pi, ctx, lc.consecutive);
			return;
		}

		// Loop 3 dispatch: a live loop drives the continuation, not a goal.
		if (isLoopActive()) {
			await runLoopTick(pi, ctx as StatusContext, event);
			return;
		}
		if (!goalState.activeGoal || goalState.activeGoal.status !== "active") return;
		// (the prior `const finalAssistant = findFinalAssistantMessage(...)` line
		//  here is REMOVED — the hoisted binding above is reused by the aborted/
		//  error check below.)
		goalState.lastActivityAt = Date.now();
		// ... existing handler body unchanged from here ...
```

> **Implementer note:** `findFinalAssistantMessage`, `hasPendingMessages`, and `runLoopTick` already exist in goal.ts. Verify the hoisted `finalAssistant` name matches the existing later references (the `stopReason === "aborted" || ... === "error"` block uses `finalAssistant` — keep that name; if the existing local was named differently, unify on `finalAssistant`).

**(3d) Add `resetLengthContinue()` to the `session_start` handler** (~line 534, alongside `clearContinuationTracking()` / `clearGoalRecovery()`):

```typescript
		stopStatusRefreshTimer();
		clearContinuationTracking();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		resetLengthContinue(); // length-continue: fresh session, fresh truncation streak
```

- [ ] **Step 4: Run the wiring tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/hardening-loop.test.ts -t "length-continue" )`
Expected: PASS (all 6 tests green).

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test )`
Expected: PASS — all pre-existing tests (577) + the new length-continue tests green. If a regression appears (e.g., the hoist changed a `finalAssistant` scoping detail), fix the wiring, not the existing tests.

- [ ] **Step 6: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-core-task && bunx tsc --noEmit && echo TSC_EXIT=$? )`
Expected: `TSC_EXIT=0`. (persistence.ts:89 already calls `api?.appendEntry(...)` on the same ExtensionAPI type, so `pi.appendEntry?.(...)` resolves; if the type lacks it, cast via `(pi as { appendEntry?: (t: string, d: unknown) => void }).appendEntry?.(...)`.)

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/goal.ts bun-apps/pi-agent-ext-core-task/src/goal/__tests__/hardening-loop.test.ts
git commit -m "feat(core-task/goal): wire length-continue at agent_end + session_start reset (GLA on-mode baseline)"
```

---

## Task 3: Verify gate (typecheck both scopes + naming grep + full suite)

**Files:** none (verification only).

- [ ] **Step 1: Per-package typecheck**

Run: `( cd bun-apps/pi-agent-ext-core-task && bunx tsc --noEmit && echo TSC_EXIT=$? )`
Expected: `TSC_EXIT=0`.

- [ ] **Step 2: Cross-package typecheck (the CI `test · pi-agent` gate)**

Run: `( cd bun-apps/pi-agent && bun run typecheck 2>&1 | tail -5; echo "PI_AGENT_TSC_EXIT=${PIPESTATUS[0]}" )`
Expected: `PI_AGENT_TSC_EXIT=0` (siblings import core-task via the seam; length-continue is internal, but verify no public-seam breakage).

- [ ] **Step 3: Naming grep guard (no leaked GLA vocabulary in core-task src)**

Run: `( cd bun-apps/pi-agent-ext-core-task && grep -rnE '\b(oracle|sisyphus|squad|forge|pi-gla-|/glla)\b' src/ || echo "naming: clean" )`
Expected: `naming: clean` (the only acceptable hit would be a substring false-positive like "forge**t**"). The give-up notify text must NOT contain `/glla` (Reviewer M2 lesson — verified in Task 2).

- [ ] **Step 4: Full suite**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test )`
Expected: PASS — 577 + new tests, 0 fail.

- [ ] **Step 5: If any step above failed, fix and re-run; otherwise record the gate result**

If steps 1–4 are all green, the branch is merge-ready. Note the test count + tsc exits in the SDD progress ledger. If a fixup was needed (e.g., a type the per-task `bun test`-only run missed), commit it:
```bash
git commit -am "fix(core-task/length-continue): typecheck — <one-line reason>"
```

---

## Self-Review (completed by plan author)

**1. Spec coverage:** §4 pure module → Task 1. §5 wiring (helper + agent_end top + hoist + give-up text + notifyExternal-drop) → Task 2 (3a–3d). §6 reset hook → Task 2 (3d). §7 guards → covered by Task 1 module + Task 2 wiring (pending-skip at 3c, reset at 3d). §8 compose-with-PR962 → Global Constraints (branch off main). §9 testing → Task 1 (unit) + Task 2 (wiring, 6 cases). §10 acceptance criteria → Task 3 + the criteria map to the tests. No gaps.

**2. Placeholder scan:** No TBD/TODO. Every code step has actual code. The wiring tests reuse `hardening-loop.test.ts`'s `bootstrap()` (starts a real goal via the `/goal` command) — no hand-rolled activeGoal. The bookkeeping-skipped signal is `ActiveGoal.iteration` unchanged (the field `incrementGoal` bumps, state.ts:103) — verified against the type.

**3. Type consistency:** `sendLengthContinue(pi, ctx, consecutive)` signature consistent across §3c call site and the helper. `tickLengthContinue`/`resetLengthContinue`/`LENGTH_CONTINUE_MAX`/`LENGTH_CONTINUE_TEXT` match Task 1's exports. `finalAssistant` hoist unifies the name with the existing aborted/error check. `mock.entries`/`mock.sentUserMessages`/`notifications` match the real `createMockPi`/`createMockCtx` return shapes in hardening-loop.test.ts.
