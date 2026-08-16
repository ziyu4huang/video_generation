# Opt-in Isolated Completion Auditor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in isolated completion auditor to `pi-agent-ext-task` so an audit-enabled goal's `goal_complete` is gated by a fresh read-only pi session's three-way verdict, closing the self-report bamboozle.

**Architecture:** Two new `src/goal/` modules — `shield.ts` (pure verdict/shield logic, pi-import-free) and `auditor.ts` (the `createAgentSession` runner, lazy-imported so default sessions pay zero cost) — plus a typed hook in the `goal_complete` tool and `--audit` flags in `commands.ts`. The auditor reuses the parent's `ctx.modelRegistry.runtime` (verified public in pi 0.82.0) so extension-registered providers auth. All six safety floors (must-read-tool, silent→error, 10-min stall→error, three-way verdict, evidence shield, exception→error) are ported clean-room from `../pi-goal-list-loop-audit`.

**Tech Stack:** TypeScript (Bun runtime), `@earendil-works/pi-coding-agent` 0.82.0 SDK (`createAgentSession`, `SessionManager`, `SettingsManager`, `createExtensionRuntime`, `ResourceLoader`), TypeBox (`@sinclair/typebox`), `bun test`.

**Spec:** `bun-apps/pi-agent-ext-task/docs/2026-07-25-opt-in-auditor.md`

## Global Constraints

- **Default off.** Non-audited goals' `goal_complete` is byte-for-byte the current path. The auditor module is lazy-imported (`await import("./auditor.js")`) only when an audit runs → default sessions pay zero import cost.
- **`state.ts` / `format.ts` / `shield.ts` stay pi-import-free** (the Phase-1 invariant). `GoalAuditorResult` is defined in `shield.ts` (pure) and imported type-only where needed. `auditor.ts` is the ONLY new file that imports `@earendil-works/*`.
- **Model-auth via parent runtime:** `createAgentSession({ modelRuntime: ctx.modelRegistry.runtime, model: overrideModel ?? ctx.model })`. No `as any` (pi 0.82.0 `ModelRegistry.runtime` is public).
- **Safety floors are non-negotiable** — ported verbatim from the reference; do not weaken them.
- **Conversation zh-TW; written artifacts English.** Run from repo root: `python/venv/bin/python …` for python, `bun` for TS. Tests: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`.
- **Branch:** `core-task/opt-in-auditor` (base = `core-task/goal-loop-hardening` head `fc767e29`, the modularized base from PR #814).

## File Structure

```
src/goal/
  shield.ts      NEW   pure: parseAuditorVerdict + checkRegressionShield + contractItems
                        + GoalAuditorResult type. Zero pi imports.
  auditor.ts     NEW   createAgentSession runner: runGoalCompletionAuditor()
                        + makeAuditorResourceLoader() + buildGoalAuditorPrompt()
                        + AuditProgress/AuditorProgressCallback types + constants.
                        LAZY-imported by goal.ts. Injectable sessionFactory for tests.
  format.ts      EDIT  ActiveGoal += optional audit fields (auditEnabled, auditorModel,
                        verificationContract, auditHistory, auditAttempts).
  state.ts       EDIT  createGoal() += audit-options param; pass-through only.
  commands.ts    EDIT  parseCommand: --audit + --model provider/id flags;
                        /goal audit toggle. CommandResult += audit fields.
  goal.ts        EDIT  hook audit into goal_complete execute (D3 routing);
                        startGoal plumbing; __setAuditRunnerForTest seam;
                        one-line status + final notify.
```

---

## Task 1: `shield.ts` — pure verdict parser + regression shield

**Files:**
- Create: `bun-apps/pi-agent-ext-task/src/goal/shield.ts`
- Test: `bun-apps/pi-agent-ext-task/src/goal/__tests__/shield.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `contractItems(contract: string): string[]`, `checkRegressionShield(report: string, contract: string): RegressionShieldResult`, `parseAuditorVerdict(output: string): { approved: boolean; disapproved: boolean; impossible: boolean; impossibleReason?: string }`, `interface RegressionShieldResult`, `interface GoalAuditorResult` (the data shape later tasks + format.ts use).

- [ ] **Step 1: Write the failing tests** (`__tests__/shield.test.ts`):

```ts
import { describe, expect, test } from "bun:test";
import {
	contractItems,
	checkRegressionShield,
	parseAuditorVerdict,
	type RegressionShieldResult,
} from "../shield.js";

describe("contractItems", () => {
	test("strips bullets, numbers, and 'done when:' prefixes", () => {
		const items = contractItems("Done when: all green\n- file X exists\n2) no crashes\nout of scope: perf");
		expect(items).toEqual(["all green", "file X exists", "no crashes"]);
	});
	test("drops preamble lines ending in colon or 'the following'", () => {
		const items = contractItems("Done when ALL of the following are true:\nitem one\nitem two:");
		expect(items).toEqual(["item one"]);
	});
});

describe("parseAuditorVerdict", () => {
	test("approved from the last verdict-bearing block", () => {
		expect(parseAuditorVerdict("some analysis\n\n<approved/>")).toEqual({
			approved: true, disapproved: false, impossible: false, impossibleReason: undefined,
		});
	});
	test("disapproved", () => {
		expect(parseAuditorVerdict("<disapproved/>").disapproved).toBe(true);
	});
	test("impossible captures reason", () => {
		const r = parseAuditorVerdict("<impossible>needs a resource we lack</impossible>");
		expect(r.impossible).toBe(true);
		expect(r.impossibleReason).toBe("needs a resource we lack");
	});
	test("no verdict marker → all false", () => {
		const r = parseAuditorVerdict("just analysis, no tag");
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(false);
		expect(r.impossible).toBe(false);
	});
});

describe("checkRegressionShield", () => {
	test("passes when evidence block addresses all items", () => {
		const contract = "file X exists\nno crashes";
		const report = "<evidence>\nItem: file X exists\nOutput: ls shows X\nItem: no crashes\nOutput: ran tests\n</evidence>";
		const r: RegressionShieldResult = checkRegressionShield(report, contract);
		expect(r.passed).toBe(true);
		expect(r.missingItems).toEqual([]);
		expect(r.hasEvidenceBlock).toBe(true);
	});
	test("fails when evidence block is missing", () => {
		const r = checkRegressionShield("approved with prose only, no evidence", "file X exists");
		expect(r.passed).toBe(false);
		expect(r.hasEvidenceBlock).toBe(false);
	});
	test("fails when an item is unaddressed", () => {
		const report = "<evidence>\nItem: file X exists\nOutput: ls shows X\n</evidence>";
		const r = checkRegressionShield(report, "file X exists\nno crashes");
		expect(r.passed).toBe(false);
		expect(r.missingItems).toEqual(["no crashes"]);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/shield.test.ts )`
Expected: FAIL (module `../shield.js` not found / exports undefined).

- [ ] **Step 3: Create `shield.ts`** — clean-room port (verbatim logic) from `../pi-goal-list-loop-audit/extensions/goal-loop-shield.ts`, adapted to core-task naming. Plus the `GoalAuditorResult` data type (pure shape; lives here so format.ts can reference it type-only without pulling pi):

```ts
/**
 * regression_shield + verdict parser — pure, dependency-free.
 *
 * Clean-room port from ../pi-goal-list-loop-audit/extensions/goal-loop-shield.ts
 * (read-only mentor; no runtime coupling). Kept free of pi imports so unit tests
 * exercise it under plain node. `GoalAuditorResult` lives here (not auditor.ts)
 * so format.ts can reference it type-only without importing the pi-bearing
 * auditor module — preserving the Phase-1 "state.ts/format.ts are pi-free" rule.
 */

/** Split a verification contract into its individual checkable items. */
export function contractItems(contract: string): string[] {
	return contract
		.split("\n")
		.map((l) => l.trim())
		.map((l) => l.replace(/^(?:done when|verify|verified when|verification|done)\s*:\s*/i, ""))
		.map((l) => l.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""))
		.filter((l) => l.length > 0)
		.filter((l) => !/^out of scope\b/i.test(l))
		.filter((l) => !l.endsWith(":"))
		.filter((l) => !/^(?:done when\s+)?(?:all of\s+)?the following\b/i.test(l));
}

export interface RegressionShieldResult {
	passed: boolean;
	missingItems: string[];
	hasEvidenceBlock: boolean;
}

function stripEdgePunct(w: string): string {
	return w.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9/_.-]+$/, "");
}

function tokenPresent(candidate: string, reportLower: string): boolean {
	const c = candidate.toLowerCase();
	if (reportLower.includes(c)) return true;
	const segments = c.split(/[-/]+/).filter((s) => s.length >= 3);
	return segments.length > 1 && segments.every((s) => reportLower.includes(s));
}

export function checkRegressionShield(report: string, contract: string): RegressionShieldResult {
	const hasEvidenceBlock = /<evidence>[\t\n\r ]*[\s\S]*?<\/evidence>/i.test(report);
	const items = contractItems(contract);
	const missingItems: string[] = [];
	const reportLower = report.toLowerCase();
	for (const item of items) {
		const candidates = item
			.split(/[^A-Za-z0-9_.\-/]+/)
			.map(stripEdgePunct)
			.filter((w) => w.length >= 5)
			.sort((a, b) => b.length - a.length)
			.slice(0, 3);
		const addressed = candidates.length > 0
			? candidates.some((c) => tokenPresent(c, reportLower))
			: reportLower.includes(item.toLowerCase());
		if (!addressed) missingItems.push(item);
	}
	return { passed: hasEvidenceBlock && missingItems.length === 0, missingItems, hasEvidenceBlock };
}

/** Three-way verdict parser (approved / disapproved / impossible). */
export function parseAuditorVerdict(output: string): {
	approved: boolean;
	disapproved: boolean;
	impossible: boolean;
	impossibleReason?: string;
} {
	const parts = output.split("\n\n");
	const lastAssistant = [...parts].reverse().find((t) => /<\/?(approved|disapproved|impossible)[ />]/i.test(t)) ?? output;
	const impossibleMatch = /<impossible>([\s\S]*?)<\/impossible>/i.exec(lastAssistant);
	return {
		approved: /<approved\/>/i.test(lastAssistant),
		disapproved: /<disapproved\/>/i.test(lastAssistant),
		impossible: impossibleMatch !== null,
		impossibleReason: impossibleMatch?.[1]?.trim().slice(0, 300) || undefined,
	};
}

/**
 * Auditor result data shape. Pure (no pi types) so it can live on ActiveGoal
 * (format.ts) and flow through the session store without dragging pi into the
 * pi-free modules. auditor.ts constructs these; goal.ts consumes them.
 */
export interface GoalAuditorResult {
	approved: boolean;
	disapproved: boolean;
	impossible?: boolean;
	impossibleReason?: string;
	output: string;
	model: string;
	error?: string;
	regressionShieldPassed?: boolean;
	regressionShieldMissing?: string[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/shield.test.ts )`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Run full gate**

Run: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`
Expected: full suite green (shield tests added, no regressions); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-task/src/goal/shield.ts bun-apps/pi-agent-ext-task/src/goal/__tests__/shield.test.ts
git commit -m "feat(core-task/goal): add pure verdict parser + regression shield (ported)"
```

---

## Task 2: Audit fields on `ActiveGoal` + `createGoal` pass-through

**Files:**
- Modify: `bun-apps/pi-agent-ext-task/src/goal/format.ts` (ActiveGoal interface)
- Modify: `bun-apps/pi-agent-ext-task/src/goal/state.ts` (createGoal signature)
- Test: `bun-apps/pi-agent-ext-task/src/goal/__tests__/state.test.ts` (extend the existing createGoal test)

**Interfaces:**
- Consumes: `GoalAuditorResult` from `./shield.js` (Task 1).
- Produces: `ActiveGoal.auditEnabled?`, `ActiveGoal.auditorModel?`, `ActiveGoal.verificationContract?`, `ActiveGoal.auditHistory?`, `ActiveGoal.auditAttempts?`; `createGoal(text, tokenBudget, baselineTokens, audit?)`.

- [ ] **Step 1: Write the failing test** (append to `state.test.ts`):

```ts
import { createGoal, __resetGoalState } from "../state.js";

describe("createGoal audit options", () => {
	test("defaults: audit disabled, no contract, zero attempts", () => {
		const g = createGoal("ship feature X", undefined, 100);
		expect(g.auditEnabled).toBeUndefined();
		expect(g.verificationContract).toBeUndefined();
		expect(g.auditAttempts).toBeUndefined();
		expect(g.auditHistory).toBeUndefined();
	});
	test("audit options are passed through onto the goal", () => {
		const g = createGoal("ship feature X", undefined, 100, {
			auditEnabled: true,
			auditorModel: "anthropic/claude-sonnet-4",
			verificationContract: "tests green\nno regressions",
		});
		expect(g.auditEnabled).toBe(true);
		expect(g.auditorModel).toBe("anthropic/claude-sonnet-4");
		expect(g.verificationContract).toBe("tests green\nno regressions");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/state.test.ts -t "audit options" )`
Expected: FAIL (TS error: `audit` arg does not exist / `auditEnabled` not on ActiveGoal).

- [ ] **Step 3: Extend `ActiveGoal` in `format.ts`** — add the optional audit fields + import `GoalAuditorResult` type-only from `./shield.js`:

```ts
import type { GoalAuditorResult } from "./shield.js";

export interface ActiveGoal {
	id: string;
	text: string;
	status: GoalStatus;
	startedAt: number;
	updatedAt: number;
	iteration: number;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	baselineTokens: number;
	// T04 opt-in auditor (all optional → absent = current behavior).
	auditEnabled?: boolean;
	auditorModel?: string;
	verificationContract?: string;
	auditHistory?: GoalAuditorResult[];
	auditAttempts?: number;
}
```

- [ ] **Step 4: Extend `createGoal` in `state.ts`** — add an optional 4th param + spread the audit fields onto the returned goal. Import the options type inline (no new exported type needed):

```ts
/** Options that enable + configure the opt-in completion auditor on a goal. */
export interface GoalAuditOptions {
	auditEnabled?: boolean;
	auditorModel?: string;
	verificationContract?: string;
}

export function createGoal(
	text: string,
	tokenBudget: number | undefined,
	baselineTokens: number,
	audit?: GoalAuditOptions,
): ActiveGoal {
	const now = Date.now();
	return {
		id: randomUUID(),
		text,
		status: "active",
		startedAt: now,
		updatedAt: now,
		iteration: 0,
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens,
		auditEnabled: audit?.auditEnabled,
		auditorModel: audit?.auditorModel,
		verificationContract: audit?.verificationContract,
	};
}
```

Note: `auditHistory` / `auditAttempts` are NOT set at creation (they accumulate during auditing) — leave them `undefined`.

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/state.test.ts )`
Expected: PASS (new audit-options tests + all existing state tests).

- [ ] **Step 6: Run full gate + commit**

Run: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`
Expected: full suite green; typecheck clean. Note: existing `createGoal` call sites (in goal.ts startGoal) still compile because the 4th param is optional.

```bash
git add bun-apps/pi-agent-ext-task/src/goal/format.ts bun-apps/pi-agent-ext-task/src/goal/state.ts bun-apps/pi-agent-ext-task/src/goal/__tests__/state.test.ts
git commit -m "feat(core-task/goal): add audit fields to ActiveGoal + createGoal pass-through"
```

---

## Task 3: `auditor.ts` — the `createAgentSession` runner (lazy-imported)

**Files:**
- Create: `bun-apps/pi-agent-ext-task/src/goal/auditor.ts`
- Test: `bun-apps/pi-agent-ext-task/src/goal/__tests__/auditor.test.ts`

**Interfaces:**
- Consumes: `ActiveGoal` from `./format.js`, `parseAuditorVerdict` + `checkRegressionShield` + `GoalAuditorResult` from `./shield.js`.
- Produces: `runGoalCompletionAuditor(args)`, `interface AuditRunnerArgs`, types `AuditProgress`/`AuditorProgressCallback`, constants `AUDITOR_STALL_MS` / `AUDIT_MAX_RETRIES` / `AUDIT_HISTORY_CAP`. `goal.ts` lazy-imports `runGoalCompletionAuditor`.

**Testability seam:** the runner takes an optional `sessionFactory?` (default = the real `createAgentSession`). Tests inject a fake factory returning a stub session — NO real model calls in unit tests.

- [ ] **Step 1: Write the failing tests** (`__tests__/auditor.test.ts`) using a fake session factory. The fake session implements `prompt()`, `subscribe()`, `abort()`:

```ts
import { describe, expect, test } from "bun:test";
import { runGoalCompletionAuditor, AUDIT_MAX_RETRIES, AUDIT_HISTORY_CAP } from "../auditor.js";
import type { ActiveGoal } from "../format.js";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

function makeGoal(overrides: Partial<ActiveGoal> = {}): ActiveGoal {
	return { id: "g1", text: "ship feature X", status: "active", startedAt: 0, updatedAt: 0,
		iteration: 0, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: 0, ...overrides };
}

/** Build a fake session that emits canned events to subscribers. */
function fakeSession(opts: {
	output?: string;            // assistant text to emit on message_end
	stopReason?: string;        // message_end stopReason (default "stop")
	toolCalls?: string[];       // tool_execution_start/end pairs to emit before message_end
	throwOnPrompt?: string;     // if set, prompt() throws this
}) {
	let sub: ((e: any) => void) | undefined;
	return {
		subscribe: (fn: (e: any) => void) => { sub = fn; return () => { sub = undefined; }; },
		prompt: async () => {
			if (opts.throwOnPrompt) throw new Error(opts.throwOnPrompt);
			const s = sub; if (!s) return;
			for (const name of opts.toolCalls ?? []) {
				s({ type: "tool_execution_start", toolName: name, args: {} });
				s({ type: "tool_execution_end", toolName: name });
			}
			s({ type: "message_end", message: { role: "assistant", stopReason: opts.stopReason ?? "stop",
				content: [{ type: "text", text: opts.output ?? "" }] } });
		},
		abort: () => {},
	};
}

describe("runGoalCompletionAuditor — safety floors", () => {
	test("approved after a read tool → approved=true", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "anthropic/claude-sonnet-4", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			completionSummary: "done",
			sessionFactory: async () => ({ session: fakeSession({ output: "looks good\n<approved/>", toolCalls: ["read"] }) } as any),
		});
		expect(r.approved).toBe(true);
		expect(r.error).toBeUndefined();
	});
	test("approved with NO read tool → converted to disapproval", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			sessionFactory: async () => ({ session: fakeSession({ output: "<approved/>" }) } as any),
		});
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(true);
		expect(r.error).toContain("read tool");
	});
	test("silent (no output) → error, not a verdict", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			sessionFactory: async () => ({ session: fakeSession({ output: "" }) } as any),
		});
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(false);
		expect(r.error).toBeTruthy();
	});
	test("no verdict marker → error, not a verdict", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			sessionFactory: async () => ({ session: fakeSession({ output: "just analysis, no tag", toolCalls: ["read"] }) } as any),
		});
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(false);
		expect(r.error).toContain("verdict");
	});
	test("prompt() throws → error, not a verdict", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			sessionFactory: async () => ({ session: fakeSession({ throwOnPrompt: "boom" }) } as any),
		});
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(false);
		expect(r.error).toBe("boom");
	});
	test("impossible verdict captures reason", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
			sessionFactory: async () => ({ session: fakeSession({ output: "<impossible>contradictory reqs</impossible>", toolCalls: ["read"] }) } as any),
		});
		expect(r.impossible).toBe(true);
		expect(r.impossibleReason).toBe("contradictory reqs");
	});
	test("regression shield: approval without evidence → disapproval + missing items", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: "m", modelRegistry: { runtime: {} } } as any,
			goal: makeGoal({ verificationContract: "tests green\nno crashes" }),
			sessionFactory: async () => ({ session: fakeSession({ output: "<approved/>", toolCalls: ["read"] }) } as any),
		});
		expect(r.approved).toBe(false);
		expect(r.disapproved).toBe(true);
		expect(r.regressionShieldPassed).toBe(false);
		expect(r.regressionShieldMissing?.length).toBe(2);
	});
	test("no model → error (never a silent audit failure)", async () => {
		const r = await runGoalCompletionAuditor({
			ctx: { cwd: "/repo", model: undefined, modelRegistry: { runtime: {} } } as any,
			goal: makeGoal(),
		});
		expect(r.error).toContain("no model");
	});
	test("constants exported", () => {
		expect(AUDIT_MAX_RETRIES).toBe(3);
		expect(AUDIT_HISTORY_CAP).toBe(8);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/auditor.test.ts )`
Expected: FAIL (module `../auditor.js` not found).

- [ ] **Step 3: Create `auditor.ts`** — clean-room port of `runGoalCompletionAuditor` adapted to core-task's `ActiveGoal`, with the injectable `sessionFactory` seam and the stall watchdog. This is the ONLY new file importing `@earendil-works/*`:

```ts
/**
 * Isolated completion auditor — runs in a fresh pi agent session with no
 * extensions/skills/prompts/themes, read-only tools only.
 *
 * Clean-room port from ../pi-goal-list-loop-audit/extensions/goal-loop-auditor.ts
 * (read-only mentor). LAZY-IMPORTED by goal.ts so default sessions pay zero
 * import cost — the auditor module is only pulled in when an audit runs.
 *
 * Safety floors (non-negotiable, ported verbatim):
 *   1. must-call-a-read-tool (an approval with zero read tools → disapproval)
 *   2. silent-failure → error, not verdict (empty/no-marker output is infra)
 *   3. 10-min stall abort → error (never an unbounded hang, never a verdict)
 *   4. three-way verdict (approved/disapproved/impossible)
 *   5. regression_shield (approval w/o per-item evidence → disapproval)
 *   6. exception → error, not verdict
 *
 * Model-auth: reuses the PARENT's ModelRuntime (ctx.modelRegistry.runtime, a
 * public field in pi 0.82.0) so extension-registered providers auth. No `as any`.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	createExtensionRuntime,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionResult,
	type ExtensionContext,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { ActiveGoal } from "./format.js";
import { checkRegressionShield, parseAuditorVerdict, type GoalAuditorResult } from "./shield.js";

export const AUDITOR_STALL_MS = 10 * 60_000; // 10-min inactivity → abort → error
export const AUDIT_MAX_RETRIES = 3;           // consecutive disapprovals before escalate-to-user
export const AUDIT_HISTORY_CAP = 8;           // max audit results retained on the goal

export interface AuditProgress {
	recentOutput: string[];
	toolCalls: Array<{ name: string; argsPrefix: string; finishedAt: number }>;
}
export type AuditorProgressCallback = (progress: AuditProgress) => void;

/** A session factory (the real createAgentSession by default; faked in tests). */
export type SessionFactory = (opts: {
	cwd: string;
	model: Model<any>;
	modelRuntime: unknown;
	resourceLoader: ResourceLoader;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	tools: string[];
}) => Promise<CreateAgentSessionResult>;

export interface AuditRunnerArgs {
	ctx: ExtensionContext;
	goal: ActiveGoal;
	completionSummary?: string | null;
	/** Override the auditor model; defaults to the session model. */
	model?: Model<any>;
	/** Test seam: inject a fake session factory. */
	sessionFactory?: SessionFactory;
	signal?: AbortSignal;
	onProgress?: AuditorProgressCallback;
}

function makeAuditorResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => [
			"You are a read-only completion auditor running in an isolated pi agent session.",
			"Inspect the repository and decide whether the claimed goal completion is genuinely satisfied.",
			"Never modify files. Never approve unless the actual user objective is complete.",
		].join("\n"),
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

function buildGoalAuditorPrompt(goal: ActiveGoal, completionSummary: string | null | undefined): string {
	return [
		"You are the independent completion auditor for core-task.",
		"The executor claims the goal is complete. Decide whether the user's objective is actually satisfied.",
		"Be skeptical and semantic. Do not approve from paperwork, intent, file count, word count, build success, or a plausible summary alone.",
		"Use read/grep/find/ls/bash to inspect real artifacts. Do not mutate files or run destructive commands.",
		"If the work is an alpha scaffold, generated template, shallow draft, or lacks the user-facing value requested, disapprove.",
		"If any explicit requirement is missing, weakly verified, contradicted, or not inspectable, disapprove.",
		"Return a concise audit report. The final line MUST be exactly one of:",
		"<approved/>",
		"<disapproved/>",
		"<impossible>one-line reason</impossible>",
		"Use <impossible> ONLY when the objective can NEVER be satisfied as stated. Incomplete/shoddy work is <disapproved/>, not impossible.",
		"",
		"Goal objective:",
		"<goal>",
		goal.text,
		"</goal>",
		"",
		"Executor completion claim:",
		"<completion_summary>",
		(completionSummary?.trim() || "(none provided)"),
		"</completion_summary>",
		...(goal.verificationContract?.trim() ? [
			"",
			"Goal verification contract (what the executor was required to verify):",
			"<verification_contract>",
			goal.verificationContract.trim(),
			"</verification_contract>",
			"",
			"REGRESSION SHIELD (mandatory because this goal has a verification contract):",
			"Your report MUST contain an <evidence> section. For EACH contract item,",
			"quote the item, then paste the RAW tool output that proves it. Format:",
			"",
			"<evidence>",
			"Item: <contract item>",
			"Output:",
			"<raw command output>",
			"</evidence>",
			"",
			"An approval without a complete <evidence> section will be rejected automatically.",
		] : []),
	].join("\n");
}

function modelLabel(model: Model<any> | undefined): string {
	if (!model) return "(unset)";
	if (typeof model === "string") return model;
	if (model && typeof model === "object" && "id" in model) return (model as { id: string }).id;
	return "(unknown model)";
}

export async function runGoalCompletionAuditor(args: AuditRunnerArgs): Promise<GoalAuditorResult> {
	const { ctx } = args;
	const model = args.model ?? (ctx as { model?: Model<any> }).model;
	if (!model) {
		return { approved: false, disapproved: false, output: "", model: "(unset)", error: "no model (session model also unset)" };
	}
	const sessionFactory: SessionFactory = args.sessionFactory ?? (async (opts) => createAgentSession(opts));
	const outputParts: string[] = [];
	const toolCalls: AuditProgress["toolCalls"] = [];
	let currentTool: string | undefined;
	let currentToolArgs: string | undefined;
	let streamError: string | undefined;

	try {
		const { session } = await sessionFactory({
			cwd: ctx.cwd,
			model,
			modelRuntime: (ctx.modelRegistry as { runtime: unknown }).runtime,
			resourceLoader: makeAuditorResourceLoader(),
			sessionManager: SessionManager.inMemory(ctx.cwd),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: true } }),
			tools: ["read", "grep", "find", "ls", "bash"],
		});

		// Stall watchdog: no session event for AUDITOR_STALL_MS → abort → error.
		let lastEventAt = Date.now();
		let stalled = false;
		const stallTimer = setInterval(() => {
			if (Date.now() - lastEventAt > AUDITOR_STALL_MS) { stalled = true; void session.abort(); }
		}, 15_000);
		stallTimer.unref?.();

		const unsub = session.subscribe((event: any) => {
			lastEventAt = Date.now();
			if (event.type === "error" || event.error || event.type === "auto_retry_start") {
				const msg = event.error?.message ?? event.message ?? event.errorMessage;
				if (typeof msg === "string") streamError = msg.slice(0, 300);
			}
			if (event.type === "tool_execution_start") {
				currentTool = event.toolName;
				currentToolArgs = typeof event.args === "object" && event.args !== null
					? JSON.stringify(event.args).slice(0, 120) : String(event.args ?? "").slice(0, 120);
				return;
			}
			if (event.type === "tool_execution_end") {
				if (currentTool) toolCalls.push({ name: currentTool, argsPrefix: currentToolArgs ?? "", finishedAt: Date.now() });
				currentTool = undefined; currentToolArgs = undefined;
				return;
			}
			if (event.type === "message_end") {
				const message = event.message;
				if (message?.role !== "assistant") return;
				if (message.stopReason === "error" && typeof message.errorMessage === "string" && message.errorMessage.trim()) {
					streamError = message.errorMessage.slice(0, 300);
				}
				for (const part of message.content ?? []) {
					if (part.type === "text" && typeof part.text === "string") outputParts.push(part.text);
				}
			}
		});
		const onAbort = () => { session.abort(); };
		args.signal?.addEventListener("abort", onAbort, { once: true });

		args.onProgress?.({ recentOutput: [], toolCalls });

		try {
			if (args.signal?.aborted) {
				return { approved: false, disapproved: false, output: "", model: modelLabel(model), error: "Auditor aborted." };
			}
			await session.prompt(buildGoalAuditorPrompt(args.goal, args.completionSummary));
		} finally {
			clearInterval(stallTimer);
			unsub();
			args.signal?.removeEventListener("abort", onAbort);
		}

		if (stalled) {
			return { approved: false, disapproved: false, output: outputParts.join("\n\n"), model: modelLabel(model),
				error: `Auditor stalled — no activity for ${Math.round(AUDITOR_STALL_MS / 60_000)}m, aborted. Infrastructure failure, not a verdict.` };
		}

		const output = outputParts.join("\n\n");
		if (!output.trim()) {
			return { approved: false, disapproved: false, output, model: modelLabel(model),
				error: `Auditor produced no output${streamError ? `: ${streamError}` : " — check the model's auth/quota."}` };
		}

		const parsed = parseAuditorVerdict(output);
		if (!parsed.approved && !parsed.disapproved && !parsed.impossible) {
			return { approved: false, disapproved: false, output, model: modelLabel(model),
				error: `Auditor produced no verdict marker${streamError ? ` — stream error: ${streamError}` : ""}. Treated as error, not a verdict.` };
		}

		const usedReadTool = toolCalls.some((c) => ["read", "grep", "find", "ls", "bash"].includes(c.name));
		if (parsed.approved && !usedReadTool) {
			return { approved: false, disapproved: true, output, model: modelLabel(model),
				error: "Auditor approved without calling any read tool; treated as disapproved." };
		}

		if (parsed.approved && args.goal.verificationContract?.trim()) {
			const shield = checkRegressionShield(output, args.goal.verificationContract);
			if (!shield.passed) {
				const why = !shield.hasEvidenceBlock ? "report has no <evidence> block"
					: `evidence does not address: ${shield.missingItems.join("; ")}`;
				return { approved: false, disapproved: true, output, model: modelLabel(model),
					error: `regression_shield: approved but ${why}`,
					regressionShieldPassed: false, regressionShieldMissing: shield.missingItems };
			}
			return { approved: true, disapproved: false, impossible: parsed.impossible, impossibleReason: parsed.impossibleReason,
				output, model: modelLabel(model), regressionShieldPassed: true };
		}

		return { approved: parsed.approved, disapproved: parsed.disapproved, impossible: parsed.impossible,
			impossibleReason: parsed.impossibleReason, output, model: modelLabel(model) };
	} catch (err) {
		// Exception is INFRASTRUCTURE, never a verdict (error && !disapproved).
		return { approved: false, disapproved: false, output: "", model: modelLabel(model),
			error: err instanceof Error ? err.message : String(err) };
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/auditor.test.ts )`
Expected: PASS (all 10 safety-floor tests green via the fake sessionFactory).

- [ ] **Step 5: Run full gate + commit**

Run: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`
Expected: full suite green; typecheck clean (auditor.ts is the only new pi-importing file; it is not imported by default-load paths yet — it will be lazy-imported in Task 5).

```bash
git add bun-apps/pi-agent-ext-task/src/goal/auditor.ts bun-apps/pi-agent-ext-task/src/goal/__tests__/auditor.test.ts
git commit -m "feat(core-task/goal): add isolated completion auditor runner (ported, lazy-imported)"
```

---

## Task 4: `commands.ts` — `--audit` / `--model` flags + `/goal audit` toggle

**Files:**
- Modify: `bun-apps/pi-agent-ext-task/src/goal/commands.ts`
- Test: `bun-apps/pi-agent-ext-task/src/goal/__tests__/commands.test.ts`

**Interfaces:**
- Consumes: nothing new (existing `parseCommand` + `CommandResult`).
- Produces: `CommandResult.audit?: boolean`, `CommandResult.auditorModel?: string`; `parseCommand` recognizes `--audit` + `--model provider/id` flags and the `audit` subcommand (toggle).

- [ ] **Step 1: Read the current `CommandResult` + `parseCommand`** to see the exact shape you're extending:

```bash
sed -n '16,100p' bun-apps/pi-agent-ext-task/src/goal/commands.ts
```

- [ ] **Step 2: Write the failing tests** (append to `commands.test.ts`):

```ts
import { parseCommand } from "../commands.js";

describe("parseCommand audit flags", () => {
	test("--audit flag sets audit=true and carries the objective", () => {
		const r = parseCommand('--audit "ship feature X"');
		expect(typeof r).toBe("object");
		if (typeof r === "object") {
			expect(r.audit).toBe(true);
			expect(r.objective ?? r.text).toBe("ship feature X");
		}
	});
	test("--audit --model provider/id carries the auditor model", () => {
		const r = parseCommand('--audit --model anthropic/claude-sonnet-4 "ship feature X"');
		if (typeof r === "object") expect(r.auditorModel).toBe("anthropic/claude-sonnet-4");
	});
	test("no --audit flag → audit is undefined (default off)", () => {
		const r = parseCommand('"ship feature X"');
		if (typeof r === "object") expect(r.audit).toBeUndefined();
	});
	test("'audit' subcommand → recognized as a toggle (not an objective)", () => {
		const r = parseCommand("audit");
		if (typeof r === "object") expect(r.subcommand ?? r.kind).toBe("audit");
	});
});
```

> **Note:** the exact assertion field names (`objective`/`text`, `subcommand`/`kind`) depend on the existing `CommandResult` shape you read in Step 1. Adjust the test to match the real field names; the INTENT (audit flag + model flag + audit toggle subcommand) is what matters.

- [ ] **Step 3: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/commands.test.ts -t "audit flags" )`
Expected: FAIL (`audit`/`auditorModel` not on CommandResult; flags not parsed).

- [ ] **Step 4: Extend `CommandResult` + `parseCommand`** in `commands.ts`. Add `audit?: boolean` and `auditorModel?: string` to the `CommandResult` interface. In `parseCommand`, before objective validation: detect the `--audit` flag (set `audit=true`, strip it from the token stream), the `--model <id>` flag (set `auditorModel`, strip both tokens), and the bare `audit` subcommand (return a CommandResult whose `subcommand`/`kind` = `"audit"` so goal.ts toggles the active goal). Follow the existing tokenizer (`tokenize`) + flag-detection patterns already in the file.

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/commands.test.ts )`
Expected: PASS (new audit-flag tests + all existing command tests).

- [ ] **Step 6: Run full gate + commit**

Run: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`
Expected: full suite green; typecheck clean.

```bash
git add bun-apps/pi-agent-ext-task/src/goal/commands.ts bun-apps/pi-agent-ext-task/src/goal/__tests__/commands.test.ts
git commit -m "feat(core-task/goal): parse --audit/--model flags + /goal audit toggle"
```

---

## Task 5: Wire the auditor into `goal_complete` + startGoal plumbing + visibility

**Files:**
- Modify: `bun-apps/pi-agent-ext-task/src/goal/goal.ts`
- Test: `bun-apps/pi-agent-ext-task/src/goal/__tests__/hardening-loop.test.ts` (extend) OR a new `__tests__/audit-wiring.test.ts`

**Interfaces:**
- Consumes: `runGoalCompletionAuditor`, `AUDIT_MAX_RETRIES`, `AUDIT_HISTORY_CAP`, `type GoalAuditorResult` from `./auditor.js` (lazy-imported); `createGoal` audit-options from `./state.js` (Task 2); `CommandResult.audit/auditorModel` from `./commands.js` (Task 4).
- Produces: the `goal_complete` audit hook (D3 routing), `startGoal` passes audit options, a `__setAuditRunnerForTest` seam, status line + final notify.

- [ ] **Step 1: Write the failing integration test** (`__tests__/audit-wiring.test.ts`) using the existing fake-pi/ctx harness pattern (mirror `hardening-loop.test.ts` + `goal.test.ts` pause/clear tests). Inject a fake auditor via the test seam:

```ts
import { describe, expect, test } from "bun:test";
// Build the fake pi/ctx exactly as hardening-loop.test.ts / goal.test.ts do.
// (Mirror their `mock` helpers — register tool + on(agent_end) + sendUserMessage etc.)

describe("goal_complete audit wiring", () => {
	test("non-audited goal: goal_complete is the current path (terminate:true, status complete)", async () => {
		// start a NON-audit goal, drive goal_complete, assert it completes normally.
	});
	test("audited goal, auditor approves → completes", async () => {
		__setAuditRunnerForTest(async () => ({ approved: true, disapproved: false, output: "<approved/>", model: "m" }));
		// start an --audit goal, drive goal_complete, assert status === "complete" + terminate:true.
	});
	test("audited goal, auditor disapproves → stays active, finding returned, terminate:false", async () => {
		__setAuditRunnerForTest(async () => ({ approved: false, disapproved: true, output: "not done", model: "m", error: "incomplete" }));
		// assert goal stays "active", auditAttempts === 1, tool result contains the finding.
	});
	test("3 consecutive disapprovals → goal pauses (escalate)", async () => {
		__setAuditRunnerForTest(async () => ({ approved: false, disapproved: true, output: "no", model: "m" }));
		// drive goal_complete 3x; after the 3rd, assert status === "paused" + a notify.
	});
	test("auditor impossible → completes with a note", async () => {
		__setAuditRunnerForTest(async () => ({ approved: false, disapproved: false, impossible: true, impossibleReason: "contradictory", output: "<impossible>contradictory</impossible>", model: "m" }));
		// assert status === "complete".
	});
	test("auditor error → does NOT complete; goal stays active", async () => {
		__setAuditRunnerForTest(async () => ({ approved: false, disapproved: false, output: "", model: "m", error: "no output" }));
		// assert status === "active", a warning notify fired.
	});
});
```

> **Note:** the harness details (how `mock` registers `goal_complete` + fires it + asserts `terminate`/notify) come from reading `goal.test.ts`'s existing `goal_complete` tests + `hardening-loop.test.ts`. Find them first; mirror their `mock` object. Do NOT invent a new harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/audit-wiring.test.ts )`
Expected: FAIL (`__setAuditRunnerForTest` not exported; audit hook not wired).

- [ ] **Step 3: Wire the audit hook into `goal_complete` execute** in `goal.ts`. In the `goalCompleteTool.execute` handler, AFTER the existing `planningGateBlocking(ctx)` check and BEFORE `transitionGoal(completedGoal, "complete")`, insert (when `completedGoal.auditEnabled`):

```ts
// T04 opt-in auditor: gate completion on an isolated read-only audit.
if (completedGoal.auditEnabled) {
	const { runGoalCompletionAuditor, AUDIT_MAX_RETRIES, AUDIT_HISTORY_CAP } = await import("./auditor.js");
	const auditResult = await auditRunner({
		ctx, goal: completedGoal, completionSummary: summary,
		model: completedGoal.auditorModel ? parseModelRef(completedGoal.auditorModel) : undefined,
	});
	// Cap history on the goal (mutate a clone, then reassign activeGoal).
	completedGoal = {
		...completedGoal,
		auditHistory: pushCapped(completedGoal.auditHistory, auditResult, AUDIT_HISTORY_CAP),
	};
	goalState.activeGoal = completedGoal;
	persistGoal(goalState.extensionApi as ExtensionAPI, completedGoal);

	// Infrastructure error → never complete; let the agent/user retry.
	if (auditResult.error && !auditResult.disapproved) {
		ctx.ui.notify(`Goal audit failed (infrastructure): ${auditResult.error}`, "warning");
		return { content: [{ type: "text", text: `Audit could not produce a verdict: ${auditResult.error}. Re-verify and call goal_complete again.` }],
			details: { goal, summary } satisfies GoalCompleteDetails };
	}
	// Impossible → the objective can never be satisfied; complete with a note.
	if (auditResult.impossible) {
		ctx.ui.notify(`Goal marked impossible by audit: ${auditResult.impossibleReason ?? "unspecified"}`, "info");
		// fall through to the normal complete transition below.
	}
	// Disapproved → bounded re-loop (D3): stay active, return the finding, terminate:false.
	if (auditResult.disapproved) {
		const attempts = (completedGoal.auditAttempts ?? 0) + 1;
		completedGoal = { ...completedGoal, auditAttempts: attempts };
		goalState.activeGoal = completedGoal;
		persistGoal(goalState.extensionApi as ExtensionAPI, completedGoal);
		if (attempts >= AUDIT_MAX_RETRIES) {
			// Escalate: pause the goal so the user decides.
			goalState.activeGoal = transitionGoal(completedGoal, "paused");
			persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
			updateStatus(ctx, goalState.activeGoal);
			ctx.ui.notify(`Goal audit disapproved ${attempts}× — paused for review. Address the audit findings or /goal resume.`, "warning");
			return { content: [{ type: "text", text: `Audit disapproved ${attempts}× and paused the goal. Findings: ${auditResult.output.slice(0, 500)}` }],
				details: { goal, summary } satisfies GoalCompleteDetails };
		}
		ctx.ui.notify(`Goal audit disapproved (attempt ${attempts}/${AUDIT_MAX_RETRIES}). Address the findings and re-verify.`, "warning");
		return { content: [{ type: "text", text: `Audit DISAPPROVED. Findings:\n${auditResult.output.slice(0, 1000)}\n\nAddress these and call goal_complete again only when genuinely complete.` }],
			details: { goal, summary } satisfies GoalCompleteDetails };  // terminate defaults to false → agent continues in-turn
	}
	// Approved (and shield passed) → fall through to the normal complete transition.
}
```

Add the test seam + helpers near the other module-level singletons in `goal.ts`:

```ts
import { pushCapped } from "./repetition.js"; // already exported by Phase-2 Task 8

type AuditRunner = (args: { ctx: any; goal: ActiveGoal; completionSummary: string; model?: any }) => Promise<import("./shield.js").GoalAuditorResult>;
let auditRunner: AuditRunner = async (args) => {
	const { runGoalCompletionAuditor } = await import("./auditor.js");
	return runGoalCompletionAuditor(args);
};
/** Test seam: override the audit runner (restored by passing undefined). */
export function __setAuditRunnerForTest(fn: AuditRunner | undefined): void {
	auditRunner = fn ?? (async (args) => { const { runGoalCompletionAuditor } = await import("./auditor.js"); return runGoalCompletionAuditor(args); });
}

/** Parse a "provider/id" string into a Model ref (best-effort; used for the --model override). */
function parseModelRef(ref: string): any {
	// The session's modelRegistry resolves provider/id; the auditor passes this as `model`
	// and createAgentSession uses the parent runtime to auth. A bare {provider,id} object
	// is accepted by createAgentSession's model option.
	const [provider, ...rest] = ref.split("/");
	return { provider, id: rest.join("/") } as any;
}
```

- [ ] **Step 4: Wire `startGoal` plumbing** — where `startGoal` calls `createGoal(text, tokenBudget, baselineTokens)`, pass the audit options from the parsed command:

```ts
// In startGoal, replace the createGoal call:
const goal = createGoal(text, tokenBudget, baselineTokens, {
	auditEnabled: parsed.audit,
	auditorModel: parsed.auditorModel,
});
```

And handle the `/goal audit` toggle subcommand (from Task 4): when `parsed.subcommand === "audit"` and there's an active goal, flip `goalState.activeGoal.auditEnabled` and notify. If no active goal, notify "no active goal".

- [ ] **Step 5: Visibility** — the audit run is synchronous within `goal_complete` execute; show a one-line status before awaiting it. Reuse the existing `updateStatus` path with a transient label, OR a simple `ctx.ui.notify("Auditing completion…", "info")` before `auditRunner(...)`. (Pick whichever matches the existing status-widget pattern; a notify is the minimal acceptable.)

- [ ] **Step 6: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/audit-wiring.test.ts )`
Expected: PASS (all 6 wiring tests green via the injected fake auditor).

- [ ] **Step 7: Run full gate + commit**

Run: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`
Expected: full suite green (existing 407 + new shield/auditor/commands/wiring tests); typecheck clean.

```bash
git add bun-apps/pi-agent-ext-task/src/goal/goal.ts bun-apps/pi-agent-ext-task/src/goal/__tests__/audit-wiring.test.ts
git commit -m "feat(core-task/goal): wire opt-in auditor into goal_complete (D3 bounded re-loop)"
```

---

## Self-Review (run before handoff)

1. **Spec coverage** — §3 D1 (`--audit` + `/goal audit` + `--model`) → Task 4 ✓; §3 D2 (shield ported, inert without contract) → Task 1 ✓ (wired only when `verificationContract` present, Task 3 + Task 5); §3 D3 (bounded re-loop, cap 3, impossible→complete, error→no-complete) → Task 5 ✓; §4.1 model-auth (parent runtime, no `as any`) → Task 3 ✓; §5 data model (5 optional fields) → Task 2 ✓; §6 all six safety floors → Task 3 ✓ (one test per floor); §7 wiring between planning-gate and transition → Task 5 ✓; §8 UX flags → Task 4 ✓; §9 visibility → Task 5 Step 5 ✓; §10 testing → each task ships tests ✓; §11 rollout (default off, lazy import) → Task 3 lazy + Task 5 guarded on `auditEnabled` ✓.
2. **Placeholder scan** — Task 4 Step 4 + Task 5 Steps 1/4 reference the existing `CommandResult`/harness shapes by reading them first (not placeholders — they're "read then match"); the audit-flag test in Task 4 explicitly notes field-name adjustment. No TBD/TODO. All code steps show complete code.
3. **Type consistency** — `GoalAuditorResult` defined once in `shield.ts` (Task 1), imported type-only into `format.ts` (Task 2) and auditor.ts (Task 3); `runGoalCompletionAuditor` signature stable across Task 3 (definition) + Task 5 (call via `auditRunner` seam); `createGoal` 4th param `GoalAuditOptions` matches `ActiveGoal` field names; `pushCapped` reused from Phase-2 Task 8 (already exported); `__setAuditRunnerForTest` exported name matches the test import.
4. **Risk note** — Task 5 is the widest diff (the `goal_complete` handler). The non-audited path is preserved verbatim (the `if (completedGoal.auditEnabled)` guard wraps only the new behavior). Task 4's flag parsing must not break existing `/goal "<obj>"` parsing (the test asserts the no-flag case is unchanged).
