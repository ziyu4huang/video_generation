# core-task quota-retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop an infinite token-burning loop when the goal-completion auditor fails with a 429/quota error — pause the goal and schedule a one-shot auto-resume at the upstream's Retry-After, instead of telling the agent to immediately retry (which re-runs the auditor against a quota window that resets in ~1h).

**Architecture:** A pure module `src/goal/quota-retry.ts` (verbatim port of GLA's 102-line module, with the `ExtensionContext` type localized to a `QuotaRetryCtx` interface so it has zero `@earendil-works/*` imports) + a wiring inside `goal.ts`'s `goal_complete` auditor-error branch that detects the quota subclass, parses Retry-After, pauses the goal, and schedules a one-shot `resumeGoal` via `setTimeout`. Pure-module + injected-side-effects invariant (mirrors `reviewer.ts`/`length-continue.ts`).

**Tech Stack:** TypeScript, Bun (`bun:test`), `@earendil-works/pi-coding-agent` ExtensionAPI (`pi.sendUserMessage`, `pi.appendEntry`, `ctx.ui.notify`, `setTimeout`).

## Global Constraints

- **Pure module:** `src/goal/quota-retry.ts` has ZERO `@earendil-works/*` imports — **even type-only**. GLA's `import type { ExtensionContext }` is replaced by a local `QuotaRetryCtx` interface. (Invariant established by `reviewer.ts`/`length-continue.ts`.)
- **Verbatim port:** the module's LOGIC (`isQuotaError`, `parseQuotaError`, `isSubagentQuotaResult`, the timer singleton, `scheduleQuotaRetry`/`cancelQuotaRetry`) ports GLA's `extensions/quota-retry.ts` verbatim. The ONE adaptation is the ctx type (D2). Do not "improve" the regex/parser/timer logic.
- **`terminate: true` is load-bearing** in the wiring — it stops the in-turn loop so the agent doesn't immediately re-call `goal_complete` (the bug). The scheduled `resumeGoal` re-triggers.
- **No `/glla` references** anywhere.
- **`DEFAULT_QUOTA_RETRY_SEC = 3600`** constant (core-task has no settings menu).
- **Compose with #962 (Reviewer) + #966 (length-continue):** branch off latest main. quota-retry edits the `goal_complete` auditor-error branch (goal.ts:271); Reviewer edits the clean-complete terminal (~316-342); length-continue edits `agent_end`. Different regions → compose cleanly.
- **Tests:** `bunx tsc --noEmit` exit 0 (per-package AND cross-package `( cd bun-apps/pi-agent && bun run typecheck )`); `bun test` green. `bun test` alone does NOT run tsc — every implementer shows real `bunx tsc --noEmit` exit. **core-task baseline on main = 541** (NOT 577 — 577 was the core-task/reviewer branch with Reviewer tests). Each port adds its tests.
- **Shell discipline:** no top-level `cd`. Use `( cd bun-apps/pi-agent-ext-core-task && ... )`. Run from repo root.
- **Effort dir:** `.planning/2026-07-31-core-task-quota-retry/` (spec + this plan + sdd).

---

## File Structure

- **Create** `src/goal/quota-retry.ts` — pure module (verbatim port + `QuotaRetryCtx` local interface). Exports `QuotaError`, `isQuotaError`, `parseQuotaError`, `DEFAULT_QUOTA_RETRY_SEC`, `isSubagentQuotaResult`, `QuotaRetryCtx`, `isQuotaRetryPending`, `cancelQuotaRetry`, `scheduleQuotaRetry`.
- **Create** `src/goal/__tests__/quota-retry.test.ts` — pure-module unit tests.
- **Modify** `src/goal/__tests__/audit-wiring.test.ts` — ADD the quota-retry wiring tests + canned `QUOTA_ERROR` verdict + the `isQuotaError`/`isQuotaRetryPending`/`cancelQuotaRetry` import. REUSE its existing harness (`createMockPi`/`createMockCtx`/`createMockOverlay`/`bootstrap`/`shutdown`/`callGoalComplete`/`__setAuditRunnerForTest`) — do NOT duplicate.
- **Modify** `src/goal/goal.ts` — (a) `goal_complete` auditor-error branch (~line 271): insert the quota sub-check; (b) `resumeGoal` (~line 867): call `cancelQuotaRetry()`; (c) `session_start` (~line 534): call `cancelQuotaRetry()`; (d) import from `./quota-retry.js`.

---

## Task 1: Pure module `quota-retry.ts` (verbatim + QuotaRetryCtx) + unit tests

**Files:**
- Create: `bun-apps/pi-agent-ext-core-task/src/goal/quota-retry.ts`
- Test: `bun-apps/pi-agent-ext-core-task/src/goal/__tests__/quota-retry.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (used by Task 2):
  - `DEFAULT_QUOTA_RETRY_SEC: number` (= 3600)
  - `QuotaError = { raw: string; retryAfterSec: number; fromUpstream: boolean }`
  - `isQuotaError(error: string | undefined): boolean`
  - `parseQuotaError(error: string, defaultRetryAfterSec?: number): QuotaError`
  - `isSubagentQuotaResult(toolName: string, isError: boolean, payload: unknown): boolean`
  - `QuotaRetryCtx = { readonly ui: { notify(message: string, level?: string): void } }`
  - `isQuotaRetryPending(): boolean`
  - `cancelQuotaRetry(): void`
  - `scheduleQuotaRetry(ctx: QuotaRetryCtx, retryAfterSec: number, reason: string, fire: () => void, label?: string): void`

- [ ] **Step 1: Write the failing tests**

Create `src/goal/__tests__/quota-retry.test.ts`:

```typescript
import { test, expect, describe } from "bun:test";
import {
	DEFAULT_QUOTA_RETRY_SEC,
	isQuotaError,
	parseQuotaError,
	isSubagentQuotaResult,
	isQuotaRetryPending,
	cancelQuotaRetry,
	scheduleQuotaRetry,
} from "../quota-retry.js";

describe("isQuotaError", () => {
	test("matches 429 / quota / rate-limit / credit shapes", () => {
		expect(isQuotaError("429 Too Many Requests")).toBe(true);
		expect(isQuotaError("rate limit exceeded")).toBe(true);
		expect(isQuotaError("insufficient balance")).toBe(true);
		expect(isQuotaError("too many requests")).toBe(true);
		expect(isQuotaError("quota exhausted")).toBe(true);
	});
	test("rejects undefined / empty / non-quota errors", () => {
		expect(isQuotaError(undefined)).toBe(false);
		expect(isQuotaError("")).toBe(false);
		expect(isQuotaError("network error")).toBe(false);
		expect(isQuotaError("connection reset")).toBe(false);
	});
});

describe("parseQuotaError", () => {
	test("Retry-After header → seconds, fromUpstream", () => {
		expect(parseQuotaError("429 — Retry-After: 5")).toEqual({ raw: "429 — Retry-After: 5", retryAfterSec: 5, fromUpstream: true });
	});
	test("'retry in 2m' prose → 120s", () => {
		expect(parseQuotaError("rate limited, retry in 2m").retryAfterSec).toBe(120);
		expect(parseQuotaError("rate limited, retry in 2m").fromUpstream).toBe(true);
	});
	test("'retry after 30 seconds' → 30s", () => {
		expect(parseQuotaError("retry after 30 seconds").retryAfterSec).toBe(30);
	});
	test("no hint → default 3600, !fromUpstream", () => {
		const q = parseQuotaError("429 with no retry hint");
		expect(q.retryAfterSec).toBe(DEFAULT_QUOTA_RETRY_SEC);
		expect(q.fromUpstream).toBe(false);
	});
});

describe("isSubagentQuotaResult", () => {
	test("Agent tool + isError + quota payload → true", () => {
		expect(isSubagentQuotaResult("Agent", true, "429 rate limited")).toBe(true);
	});
	test("non-Agent tool → false; !isError → false; non-quota payload → false", () => {
		expect(isSubagentQuotaResult("read", true, "429")).toBe(false);
		expect(isSubagentQuotaResult("Agent", false, "429")).toBe(false);
		expect(isSubagentQuotaResult("Agent", true, "network error")).toBe(false);
	});
});

describe("quota retry timer", () => {
	test("schedule → pending true + notify; cancel → pending false; reschedule cancels prior", () => {
		cancelQuotaRetry();
		expect(isQuotaRetryPending()).toBe(false);
		const notes: string[] = [];
		scheduleQuotaRetry({ ui: { notify: (m: string) => void notes.push(m) } }, 60, "429 rate limited", () => {});
		expect(isQuotaRetryPending()).toBe(true);
		expect(notes.some((n) => /auto-retry|quota/i.test(n))).toBe(true);
		// reschedule cancels the prior — still exactly one pending
		scheduleQuotaRetry({ ui: { notify: () => {} } }, 120, "429 again", () => {});
		expect(isQuotaRetryPending()).toBe(true);
		cancelQuotaRetry();
		expect(isQuotaRetryPending()).toBe(false);
	});

	test("fire callback runs after the window, then pending clears", async () => {
		cancelQuotaRetry();
		let fired = false;
		// retryAfterSec=1 → Math.max(1_000, 1*1000) = 1000ms minimum
		scheduleQuotaRetry({ ui: { notify: () => {} } }, 1, "test", () => { fired = true; });
		expect(isQuotaRetryPending()).toBe(true);
		await new Promise((r) => setTimeout(r, 1150));
		expect(fired).toBe(true);
		expect(isQuotaRetryPending()).toBe(false);
	});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/quota-retry.test.ts )`
Expected: FAIL — `Cannot find module "../quota-retry.js"`.

- [ ] **Step 3: Write the implementation (verbatim port + QuotaRetryCtx)**

Create `src/goal/quota-retry.ts`:

```typescript
// Quota-aware retry. When the goal-completion auditor (a separate model call)
// fails with a 429 / quota error, the goal_complete error branch used to tell
// the agent to "re-verify and call goal_complete again" — which re-ran the
// auditor against a quota window that only resets in ~1h, looping forever and
// burning tokens. This module detects the quota subclass, parses the upstream's
// Retry-After hint, and exposes a one-shot scheduled resume so the goal can
// pause + auto-resume instead of spinning.
//
// Pure module — zero @earendil-works/* imports (even type-only). The ctx shape
// quota-retry needs is the local QuotaRetryCtx interface; the goal.ts wiring
// passes the real ctx (structural satisfaction). The setTimeout + the module
// singleton are side-effect state local to this module (no @earendil runtime
// coupling) — same shape as length-continue.ts's tracker singleton.
//
// Verbatim port of GLA extensions/quota-retry.ts (faithful baseline); the only
// deviation is the ctx type (QuotaRetryCtx instead of import type ExtensionContext).

/** The ctx shape quota-retry needs (local — keeps the module free of @earendil imports). */
export interface QuotaRetryCtx {
	readonly ui: { notify(message: string, level?: string): void };
}

export const DEFAULT_QUOTA_RETRY_SEC = 3600;

export interface QuotaError {
	raw: string;
	/** Seconds until retry, from the upstream hint or the default. */
	retryAfterSec: number;
	/** True when retryAfterSec came from the upstream (Retry-After / "retry in Ns"), false when the default was used. */
	fromUpstream: boolean;
}

/** Match 429, "quota", "rate limit", "temporarily rate-limited upstream", credit exhaustion. */
export function isQuotaError(error: string | undefined): boolean {
	if (!error) return false;
	return /429|quota|rate.?limit|temporarily|credits?|key limit exceeded|insufficient.?balance|too many requests/i.test(error);
}

/** Parse the retry window out of an error string: `Retry-After: N`, `retry after/in N (s|m|h)` prose, else default. */
export function parseQuotaError(error: string, defaultRetryAfterSec = DEFAULT_QUOTA_RETRY_SEC): QuotaError {
	let m = error.match(/retry-after:\s*(\d+)/i);
	if (m) {
		const sec = Number(m[1]);
		if (Number.isFinite(sec) && sec >= 0) return { raw: error, retryAfterSec: sec, fromUpstream: true };
	}
	m = error.match(/retry (?:after|in)\s+(\d+)\s*(s|sec|seconds|m|min|minutes|h|hours?)/i);
	if (m) {
		const n = Number(m[1]);
		const unit = m[2]!.toLowerCase();
		const mult = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
		if (Number.isFinite(n) && n >= 0) return { raw: error, retryAfterSec: n * mult, fromUpstream: true };
	}
	return { raw: error, retryAfterSec: defaultRetryAfterSec, fromUpstream: false };
}

/** Detect a SUBAGENT (Agent-tool) quota failure in a tool_result. Pure; wiring deferred. */
export function isSubagentQuotaResult(toolName: string, isError: boolean, payload: unknown): boolean {
	if (!isError) return false;
	if (toolName !== "Agent" && toolName !== "agent") return false;
	const text = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
	return isQuotaError(text);
}

let quotaRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** Test hook — is a quota retry currently scheduled? */
export function isQuotaRetryPending(): boolean {
	return quotaRetryTimer !== null;
}

/** Cancel any pending quota retry (e.g. the user resumed manually, or a fresh session). */
export function cancelQuotaRetry(): void {
	if (quotaRetryTimer) {
		clearTimeout(quotaRetryTimer);
		quotaRetryTimer = null;
	}
}

/**
 * Schedule a one-shot auto-resume after the quota window. The fire callback
 * re-checks the goal is still paused for the quota reason before resuming
 * (the caller's resume is idempotent; a user /goal pause during the window is
 * not stomped because resumeGoal/session_start call cancelQuotaRetry).
 */
export function scheduleQuotaRetry(
	ctx: QuotaRetryCtx,
	retryAfterSec: number,
	reason: string,
	fire: () => void,
	label = "Auditor quota exhausted — auto-retry",
): void {
	cancelQuotaRetry();
	const ms = Math.max(1_000, retryAfterSec * 1_000);
	quotaRetryTimer = setTimeout(() => {
		quotaRetryTimer = null;
		try {
			fire();
		} catch {
			/* session may be gone; session_start will re-evaluate */
		}
	}, ms);
	quotaRetryTimer.unref?.();
	ctx.ui.notify(
		`${label} in ${Math.round(retryAfterSec / 60)}m (${reason.slice(0, 80)}). /goal resume retries now.`,
		"info",
	);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/quota-retry.test.ts )`
Expected: PASS (all tests green; the fire-callback test waits ~1.15s).

- [ ] **Step 5: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-core-task && bunx tsc --noEmit && echo TSC_EXIT=$? )`
Expected: `TSC_EXIT=0`.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/quota-retry.ts bun-apps/pi-agent-ext-core-task/src/goal/__tests__/quota-retry.test.ts
git commit -m "feat(core-task/quota-retry): pure module + unit tests (port from GLA)"
```

---

## Task 2: Wiring — goal_complete auditor-error branch + resume/session_start cancel hooks + wiring tests

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/goal.ts` (goal_complete auditor-error branch ~line 271; `resumeGoal` ~line 867; `session_start` ~line 534; import)
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/__tests__/audit-wiring.test.ts` (ADD wiring tests + `QUOTA_ERROR` verdict + import; REUSE the existing harness — do NOT duplicate `createMockPi`/`createMockCtx`/`createMockOverlay`/`bootstrap`/`shutdown`/`callGoalComplete`/`__setAuditRunnerForTest`)

**Interfaces:**
- Consumes (from Task 1): `isQuotaError`, `parseQuotaError`, `scheduleQuotaRetry`, `cancelQuotaRetry`, `isQuotaRetryPending`.
- Consumes (existing in goal.ts): `transitionGoal(g, "paused")`, `persistGoal(api, goal)`, `updateStatus(ctx, goal)`, `cancelContinuationPending()`, `resumeGoal(pi, ctx)` (line 867), `goalState`, `completedGoal` (the handler local, line 193).
- Consumes (existing test harness in audit-wiring.test.ts): `bootstrap(commandArgs, runner)` (injects a fake auditor via `__setAuditRunnerForTest`, starts a `--audit` goal); `callGoalComplete(mock, ctx, summary)` (invokes `mock.tools[0].execute`); `shutdown(mock, ctx)`; the canned verdicts (`APPROVED`/`DISAPPROVED`/`INFRA_ERROR`).
- Produces: the wired `goal_complete` quota-error pause-and-reschedule + the cancel hooks.

- [ ] **Step 1: Write the failing wiring tests (ADD to audit-wiring.test.ts)**

Open `src/goal/__tests__/audit-wiring.test.ts`. Add the import next to the other `../` imports:

```typescript
import { isQuotaRetryPending, cancelQuotaRetry } from "../quota-retry.js";
```

Add a canned quota verdict next to `INFRA_ERROR`:

```typescript
const QUOTA_ERROR = { approved: false, disapproved: false, output: "", model: "fake", error: "429 Too Many Requests — Retry-After: 60" } as const;
```

Add this describe block at the end of the file (reuses `bootstrap`/`callGoalComplete`/`shutdown`):

```typescript
describe("goal_complete quota-retry wiring", () => {
	test("quota auditor error → pause + schedule + terminate:true (no re-loop)", async () => {
		const { mock, ctx } = await bootstrap("--audit finish the task", async () => ({ ...QUOTA_ERROR }));
		try {
			const result = await callGoalComplete(mock, ctx, "Done.");
			expect(goalState.activeGoal?.status).toBe("paused"); // NOT active (no re-loop)
			expect(result.terminate).toBe(true); // load-bearing: stops the in-turn retry
			expect(isQuotaRetryPending()).toBe(true); // a one-shot resume is scheduled
			expect(result.content?.[0]?.text ?? "").toMatch(/quota|rate limit|paused|auto-retry/i);
		} finally {
			cancelQuotaRetry();
			await shutdown(mock, ctx);
		}
	});

	test("non-quota infra error → existing 're-verify' path (NOT paused, no scheduled retry)", async () => {
		const { mock, ctx } = await bootstrap("--audit finish the task", async () => ({ ...INFRA_ERROR }));
		try {
			cancelQuotaRetry();
			const result = await callGoalComplete(mock, ctx, "Done.");
			expect(goalState.activeGoal?.status).toBe("active"); // unchanged
			expect(result.terminate).toBeUndefined();
			expect(isQuotaRetryPending()).toBe(false);
		} finally {
			cancelQuotaRetry();
			await shutdown(mock, ctx);
		}
	});

	test("disapproved + quota error → disapproval path owns it (NOT quota-paused)", async () => {
		const both = { approved: false, disapproved: true, output: "incomplete", model: "fake", error: "429 rate limited" } as const;
		const { mock, ctx } = await bootstrap("--audit finish the task", async () => ({ ...both }));
		try {
			const result = await callGoalComplete(mock, ctx, "Done.");
			expect(goalState.activeGoal?.status).toBe("active"); // disapproval re-loop, not quota pause
			expect(goalState.activeGoal?.auditAttempts).toBe(1);
			expect(isQuotaRetryPending()).toBe(false);
			expect(result.terminate).toBeUndefined();
		} finally {
			cancelQuotaRetry();
			await shutdown(mock, ctx);
		}
	});

	test("/goal resume cancels the scheduled quota retry", async () => {
		const { mock, ctx } = await bootstrap("--audit finish the task", async () => ({ ...QUOTA_ERROR }));
		try {
			await callGoalComplete(mock, ctx, "Done.");
			expect(isQuotaRetryPending()).toBe(true);
			const goalCmd = mock.commands.get("goal");
			await goalCmd?.handler("resume", ctx);
			expect(isQuotaRetryPending()).toBe(false);
			expect(goalState.activeGoal?.status).toBe("active");
		} finally {
			cancelQuotaRetry();
			await shutdown(mock, ctx);
		}
	});

	test("session_start cancels a pending quota retry", async () => {
		const { mock, ctx } = await bootstrap("--audit finish the task", async () => ({ ...QUOTA_ERROR }));
		try {
			await callGoalComplete(mock, ctx, "Done.");
			expect(isQuotaRetryPending()).toBe(true);
			await (mock.events.get("session_start")?.[0] as ((e: unknown, c: unknown) => void) | undefined)?.({}, ctx);
			expect(isQuotaRetryPending()).toBe(false);
		} finally {
			cancelQuotaRetry();
			await shutdown(mock, ctx);
		}
	});
});
```

- [ ] **Step 2: Run the wiring tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/audit-wiring.test.ts -t "quota-retry" )`
Expected: FAIL — the auditor-error branch returns the existing "re-verify" path (`terminate` undefined, goal stays active) for the quota error too; `isQuotaRetryPending()` is false where true is expected. (Task 1 must be merged first.)

- [ ] **Step 3: Implement the wiring in goal.ts**

**(3a) Add the import** near the other `./` imports:

```typescript
import { isQuotaError, parseQuotaError, scheduleQuotaRetry, cancelQuotaRetry } from "./quota-retry.js";
```

**(3b) Insert the quota sub-check** as the FIRST thing inside the existing `if (auditResult.error && !auditResult.disapproved)` block (~line 271), before the current notify+return. `completedGoal` (the handler local, line 193) === `goalState.activeGoal` here (lines 262-266 sync them after the auditHistory push); pause `completedGoal` to mirror the disapproved path's idiom at line 292:

```typescript
		if (auditResult.error && !auditResult.disapproved) {
			// quota-retry (GLA faithful baseline): a 429/quota auditor error must NOT
			// loop — the default "re-verify" return re-fires goal_complete → auditor →
			// 429 → burn tokens. Pause + schedule a one-shot resume at Retry-After.
			if (isQuotaError(auditResult.error)) {
				const quota = parseQuotaError(auditResult.error);
				cancelContinuationPending();
				goalState.activeGoal = transitionGoal(completedGoal, "paused");
				persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
				updateStatus(ctx, goalState.activeGoal);
				scheduleQuotaRetry(ctx, quota.retryAfterSec, auditResult.error, () => resumeGoal(pi, ctx));
				return {
					content: [{ type: "text", text: `Goal audit hit a quota/rate limit — paused, auto-retry in ${Math.max(1, Math.round(quota.retryAfterSec / 60))}m (${quota.fromUpstream ? "upstream hint" : "default"}). /goal resume retries now.` }],
					terminate: true, // stop the agent; the scheduled resume re-triggers
				};
			}
			ctx.ui.notify(`Goal audit failed (infrastructure): ${auditResult.error}`, "warning");
			return {
				content: [{ type: "text", text: `Audit could not produce a verdict: ${auditResult.error}. Re-verify and call goal_complete again.` }],
			};
		}
```

**(3c) Cancel the scheduled retry on manual resume.** In `resumeGoal` (~line 867), add `cancelQuotaRetry();` at the top (a manual `/goal resume` during the quota window must not be stomped by the later auto-resume):

```typescript
async function resumeGoal(pi: ExtensionAPI, ctx: StatusContext) {
	cancelQuotaRetry(); // quota-retry: a manual resume cancels the scheduled auto-resume
	// ... existing resumeGoal body unchanged ...
```

**(3d) Cancel the scheduled retry on a fresh session.** In the `session_start` handler (~line 534), add `cancelQuotaRetry();` alongside the other resets (a scheduled timer is process-local; a fresh session drops it):

```typescript
		stopStatusRefreshTimer();
		clearContinuationTracking();
		clearGoalRecovery();
		clearStaleGoalToolCallBlock();
		resetLengthContinue(); // length-continue
		cancelQuotaRetry();    // quota-retry: fresh session, no stale scheduled resume
```

> **Implementer note:** verify `resetLengthContinue()` is already present (it's from PR #966; if this branch is off a main that already has #966 merged, it's there; if not — #966 not yet merged — omit that line and keep only `cancelQuotaRetry()`). The `cancelQuotaRetry()` line is the one this task adds.

- [ ] **Step 4: Run the wiring tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/audit-wiring.test.ts -t "quota-retry" )`
Expected: PASS (all 5 tests green).

- [ ] **Step 5: Run the full suite to confirm no regression**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test )`
Expected: PASS — 541 baseline + new tests, 0 fail. The existing "auditor infrastructure error" test (INFRA_ERROR) must still pass (the non-quota path is unchanged). If a regression appears (e.g., the new branch altered the error-path flow), fix the wiring, not the existing tests.

- [ ] **Step 6: Typecheck**

Run: `( cd bun-apps/pi-agent-ext-core-task && bunx tsc --noEmit && echo TSC_EXIT=$? )`
Expected: `TSC_EXIT=0`. (`scheduleQuotaRetry(ctx, ...)` takes a `QuotaRetryCtx`; the real `ctx` satisfies it structurally — `{ ui: { notify } }`. If tsc complains, verify `ctx`'s `ui.notify` signature matches.)

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/goal.ts bun-apps/pi-agent-ext-core-task/src/goal/__tests__/audit-wiring.test.ts
git commit -m "feat(core-task/goal): wire quota-retry on auditor quota error + cancel hooks"
```

---

## Task 3: Verify gate (typecheck both scopes + naming grep + full suite)

**Files:** none (verification only).

- [ ] **Step 1: Per-package typecheck**

Run: `( cd bun-apps/pi-agent-ext-core-task && bunx tsc --noEmit && echo TSC_EXIT=$? )`
Expected: `TSC_EXIT=0`.

- [ ] **Step 2: Cross-package typecheck (the CI `test · pi-agent` gate)**

Run: `( cd bun-apps/pi-agent && bun run typecheck 2>&1 | tail -5; echo "PI_AGENT_TSC_EXIT=${PIPESTATUS[0]}" )`
Expected: `PI_AGENT_TSC_EXIT=0`.

- [ ] **Step 3: Naming grep guard (no leaked GLA vocabulary in core-task src)**

Run: `( cd bun-apps/pi-agent-ext-core-task && grep -rnE '\b(oracle|sisyphus|squad|forge|pi-gla-|/glla)\b' src/ || echo "naming: clean" )`
Expected: `naming: clean` (acceptable substring false-positives only, e.g. "forge**t**"). The scheduleQuotaRetry label/notify must NOT contain `/glla`.

- [ ] **Step 4: Full suite**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test )`
Expected: PASS — 541 + new, 0 fail.

- [ ] **Step 5: If any step failed, fix and re-run; otherwise record the gate result**

If steps 1–4 are all green, the branch is merge-ready. Note the test count + tsc exits in the SDD progress ledger. If a fixup was needed, commit it:
```bash
git commit -am "fix(core-task/quota-retry): typecheck — <one-line reason>"
```

---

## Self-Review (completed by plan author)

**1. Spec coverage:** §4 pure module → Task 1. §5 wiring (goal.ts:271 quota sub-check, pause `completedGoal`, terminate:true, scheduleQuotaRetry) → Task 2 (3b). §6 cancel hooks (resumeGoal + session_start) → Task 2 (3c, 3d). §7 guards → covered by the module (Task 1) + wiring (the `isQuotaError` INSIDE `error && !disapproved` guard at 3b). §8 compose-with-#962/#966 → Global Constraints (branch off main) + the Task 2 3d note about resetLengthContinue. §9 testing → Task 1 (unit) + Task 2 (wiring, 5 cases). §10 acceptance → Task 3 + the tests. No gaps.

**2. Placeholder scan:** No TBD/TODO. Every code step has actual code. The Task 2 3d note about `resetLengthContinue()` presence (depends on whether #966 is merged into the base) is concrete guidance, not a placeholder.

**3. Type consistency:** `scheduleQuotaRetry(ctx, sec, reason, fire, label?)` signature consistent across the Task 1 module, the Task 2 3b call site, and the Task 1 unit tests. `QuotaRetryCtx = { ui: { notify } }` — the real `ctx` satisfies it. `isQuotaError`/`parseQuotaError`/`cancelQuotaRetry`/`isQuotaRetryPending` match Task 1's exports. `completedGoal`/`goalState.activeGoal`/`transitionGoal`/`persistGoal`/`updateStatus`/`cancelContinuationPending`/`resumeGoal` all exist in goal.ts (verified: completedGoal at 193, transitionGoal("paused") idiom at 292, resumeGoal at 867, session_start at 534). `QUOTA_ERROR`/`INFRA_ERROR` canned verdicts match the audit-wiring.test.ts `GoalAuditorResult` shape.
