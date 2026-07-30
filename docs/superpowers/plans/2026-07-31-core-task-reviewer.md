# core-task Reviewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GLA's Reviewer (post-completion follow-up enqueuer) to `pi-agent-ext-core-task`, scoped to GLA `on` mode — after a clean `/goal` complete, extract findings from the completion summary + disapproved audits, classify by leverage, and cascade (bug/refactor → `/list` no-confirm; architectural → `/goal` proposal Confirm; strategic → notify; clean → regression-scan `/goal` proposal Confirm).

**Architecture:** A new **pure** module `src/goal/reviewer.ts` (zero `@earendil-works/*` imports, ported verbatim from GLA) holds all logic; `runReviewer` is pure + synchronous with side effects injected via `ReviewerDeps`. The async Confirm loop runs in `goal.ts` wiring *after* `runReviewer` returns (keeps the pure function host-free-testable). Finding sources come from `goal_complete`'s `params.summary` + `completedGoal.auditHistory` disapproved entries — both already in scope, no new capture.

**Tech Stack:** TypeScript, Bun test runner, `@earendil-works/pi-coding-agent` 0.83.0 (peer dep — NOT imported by the pure module).

**Spec:** `bun-apps/pi-agent-ext-core-task/docs/2026-07-31-reviewer-spec.md` (read it first; it has the full cascade table, decisions D1–D8, and the exact wiring code).

**GLA source of truth (for the verbatim port):** `/Users/huangziyu/proj/pi-goal-list-loop-audit/extensions/reviewer.ts` — already read into this session; a subagent may `read` it by absolute path.

## Global Constraints

- **Pure-module invariant:** `src/goal/reviewer.ts` and `src/goal/state.ts` MUST have **zero** `@earendil-works/*` imports (existing invariant; `extensionApi`/`latestCtx` stay typed `unknown`). All pi types live in `goal.ts`/`auditor.ts`/`persistence.ts`.
- **`runReviewer` stays pure + synchronous** (verbatim GLA). Do NOT make it async or give it a `ctx`. Side effects flow through the injected `ReviewerDeps`. The Confirm dialog runs in `goal.ts` after `runReviewer` returns.
- **Never block completion:** the Reviewer wiring in `goal.ts` is wrapped in `try/catch`; any throw → `ctx.ui.notify(..., "warning")` and the goal still completes normally.
- **Conversation language zh-TW; written artifacts English** (code, comments, commit messages).
- **Run from repo root:** `( cd bun-apps/pi-agent-ext-core-task && bun test )` and `( cd bun-apps/pi-agent-ext-core-task && bun run typecheck )`. Never top-level `cd`.
- **Cross-package typecheck is the real gate:** after all tasks, run the repo-root `bunx tsc --noEmit` (the CI `test · pi-agent` job does cross-package tsc — a per-package `bun test` does NOT catch cross-extension interface breaks; this bit PR #949).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/goal/reviewer.ts` | **Create** | Pure Reviewer: types, config, finding classification, extraction, report, safety predicates, `runReviewer`. Ported verbatim from GLA. |
| `src/goal/state.ts` | Modify | `ActiveGoal.origin`; `createGoal` 5th param; `goalState.reviewerEnabled`; `__resetGoalState` resets it. |
| `src/goal/format.ts` | Modify | `ActiveGoal` interface gains `origin?`; `/goal status` shows last review (Task 7). |
| `src/goal/persistence.ts` | Modify | `REVIEWER_ENTRY_TYPE`, `appendReviewerEntry`, `loadReviewerEntries`. |
| `src/goal/goal.ts` | Modify | Wire `runReviewer` at clean-complete + Confirm loop; promoteNext passes `origin:"list"`; `/goal review on\|off` handler. |
| `src/goal/commands.ts` | Modify | `CommandResult` gains `review` kind; `parseCommand` handles `/goal review on\|off`. |
| `src/goal/__tests__/reviewer.test.ts` | **Create** | Pure-module tests: classify/extract/cutAtClause/unwrap/dedupe + `runReviewer` cascade matrix + safety predicates. |
| `src/goal/__tests__/persistence.test.ts` | Modify | Reviewer ledger round-trip. |
| `src/goal/__tests__/state.test.ts` | Modify | `origin` + `reviewerEnabled`. |
| `src/goal/__tests__/commands.test.ts` | Modify | `/goal review` parsing. |
| `src/goal/__tests__/hardening-loop.test.ts` | Modify | Reviewer wiring integration (clean-complete cascade, pause/abort skip, refire window, bare-`/goal` regression, try/catch). |

---

### Task 1: Pure `reviewer.ts` — config, types, classification, text helpers

**Files:**
- Create: `src/goal/reviewer.ts` (first half)
- Create: `src/goal/__tests__/reviewer.test.ts`

**Interfaces:**
- Produces: `ReviewerMode`, `ReviewerConfig`, `DEFAULT_REVIEWER_CONFIG`, `resolveReviewerConfig(block?)`, `FindingClass`, `Finding`, `classifyFindingText(line): FindingClass | undefined`, `stripCodeSpans(text)`, `unwrapHardWrappedLines(text)`, `cutAtClauseBoundary(s, max)`, `normalizeObjective(s)`. (Task 2 consumes these.)

- [ ] **Step 1: Write the failing tests**

Create `src/goal/__tests__/reviewer.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
	DEFAULT_REVIEWER_CONFIG,
	resolveReviewerConfig,
	classifyFindingText,
	stripCodeSpans,
	unwrapHardWrappedLines,
	cutAtClauseBoundary,
	normalizeObjective,
} from "../reviewer.js";

describe("reviewer — config", () => {
	it("default mode is on, leverage fix-without-confirm, caps set", () => {
		expect(DEFAULT_REVIEWER_CONFIG.mode).toBe("on");
		expect(DEFAULT_REVIEWER_CONFIG.leverageMode).toBe("fix-without-confirm");
		expect(DEFAULT_REVIEWER_CONFIG.maxFindingsPerReview).toBe(10);
		expect(DEFAULT_REVIEWER_CONFIG.maxReviewsPerDay).toBe(20);
		expect(DEFAULT_REVIEWER_CONFIG.fireOn).toContain("goal-complete");
	});
	it("merges a partial block over defaults", () => {
		const c = resolveReviewerConfig({ maxFindingsPerReview: 3 });
		expect(c.maxFindingsPerReview).toBe(3);
		expect(c.mode).toBe("on"); // untouched
	});
	it("migrates legacy 'default'/'report' modes to 'on'", () => {
		expect(resolveReviewerConfig({ mode: "default" as never }).mode).toBe("on");
		expect(resolveReviewerConfig({ mode: "report" as never }).mode).toBe("on");
	});
});

describe("reviewer — classifyFindingText", () => {
	it("classifies TODO/FIXME/bug/regression/broken as bug", () => {
		for (const t of ["- TODO: fix the leak", "FIXME: race condition", "this is a bug", "regression in parser", "broken on safari"]) {
			expect(classifyFindingText(t)).toBe("bug");
		}
	});
	it("classifies refactor-shaped text as refactor", () => {
		for (const t of ["could be cleaner", "consider refactoring the module", "duplicated logic", "deferred to v2"]) {
			expect(classifyFindingText(t)).toBe("refactor");
		}
	});
	it("classifies rewrite/new dependency/schema change as architectural", () => {
		expect(classifyFindingText("we should rewrite the auth layer")).toBe("architectural");
		expect(classifyFindingText("new dependency: add fastify")).toBe("architectural");
	});
	it("classifies 'should we'/'deprecate' as strategic", () => {
		expect(classifyFindingText("should we ship this?")).toBe("strategic");
		expect(classifyFindingText("deprecate the old API")).toBe("strategic");
	});
	it("returns undefined for code lines, tables, short lines, reviewer vocab", () => {
		expect(classifyFindingText("const x = 1;")).toBeUndefined();
		expect(classifyFindingText("| col | col |")).toBeUndefined();
		expect(classifyFindingText("short")).toBeUndefined();
		expect(classifyFindingText("architectural-class finding")).toBeUndefined();
	});
});

describe("reviewer — text helpers", () => {
	it("stripCodeSpans removes fenced + inline code", () => {
		expect(stripCodeSpans("see `TODO` and\n```js\nTODO\n```")).toBe("see  and\n ");
	});
	it("unwrapHardWrappedLines joins lowercase continuations, leaves standalone items", () => {
		const joined = unwrapHardWrappedLines("Run a scan on the\nhellhunter codebase to");
		expect(joined).toBe("Run a scan on the hellhunter codebase to");
		const standalone = unwrapHardWrappedLines("TODO: fix x\nFIXME: fix y");
		expect(standalone).toBe("TODO: fix x\nFIXME: fix y");
	});
	it("cutAtClauseBoundary cuts at clause, then space, never mid-word", () => {
		expect(cutAtClauseBoundary("short", 200)).toBe("short");
		expect(cutAtClauseBoundary("a. b. c.", 4)).toBe("a.");
		const spaced = cutAtClauseBoundary("abcdefghijklmnopqrstuvwxyz", 10);
		expect(spaced.length).toBeLessThanOrEqual(10);
		expect(spaced).toBe("abcdefghij".slice(0, spaced.length)); // cut at a space or full window
	});
	it("normalizeObjective lowercases, collapses whitespace, masks goal-ids", () => {
		expect(normalizeObjective("Post-completion regression scan after 20260731120000-ab12cd (regression-scan)"))
			.toBe("post-completion regression scan after <id> (regression-scan)");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/reviewer.test.ts )`
Expected: FAIL — cannot resolve `../reviewer.js`.

- [ ] **Step 3: Implement reviewer.ts (first half) — verbatim port from GLA**

Create `src/goal/reviewer.ts`. Port **verbatim** from `/Users/huangziyu/proj/pi-goal-list-loop-audit/extensions/reviewer.ts`, lines 1 through the end of `normalizeObjective` (the config + classification + text-helper section). Keep every exported name identical to the test imports above. Specifically include: the module doc-comment (rewrite the header to say "core-task port of GLA's Reviewer"), `import * as fs from "node:fs"` and `import * as path from "node:path"` (used by `writeReviewReport` in Task 2 — keep them now), `ReviewerMode`, `ReviewerConfig`, `DEFAULT_REVIEWER_CONFIG`, `resolveReviewerConfig` (with the legacy `default`/`report` → `on` migration), `FindingClass`, `Finding`, `CLASS_PATTERNS`, `SKIP_LINE`, `REVIEWER_VOCAB`, `classifyFindingText`, `stripCodeSpans`, `DANGLING_END`, `unwrapHardWrappedLines`, `cutAtClauseBoundary`, `normalizeObjective`.

**Adaptations vs GLA (apply now):** none in this half — port exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/reviewer.test.ts )`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/reviewer.ts bun-apps/pi-agent-ext-core-task/src/goal/__tests__/reviewer.test.ts
git commit -m "feat(core-task/reviewer): pure config + classification + text helpers (port from GLA)"
```

---

### Task 2: Pure `reviewer.ts` — extraction, report, safety, `runReviewer`

**Files:**
- Modify: `src/goal/reviewer.ts` (append second half)
- Modify: `src/goal/__tests__/reviewer.test.ts` (append suites)

**Interfaces:**
- Consumes: Task 1 helpers.
- Produces: `extractFindings(sources, max, completedObjective?)`, `ReviewReport`, `formatReviewReport(r)`, `writeReviewReport(cwd, r)`, `reviewerFiredRecently(entries, windowMs, nowMs)`, `reviewsToday(entries, nowMs)`, `REVIEWER_REFIRE_WINDOW_MS`, `ReviewerDeps`, `ReviewerOutcome`, `runReviewer(config, source, deps)`.

- [ ] **Step 1: Write the failing tests**

Append to `src/goal/__tests__/reviewer.test.ts`:

```ts
import {
	extractFindings,
	formatReviewReport,
	reviewerFiredRecently,
	reviewsToday,
	runReviewer,
	DEFAULT_REVIEWER_CONFIG,
	REVIEWER_REFIRE_WINDOW_MS,
} from "../reviewer.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("reviewer — extractFindings", () => {
	it("extracts + dedupes findings across sources, caps at max", () => {
		const out = extractFindings(
			[
				{ name: "summary", text: "- TODO: fix leak\n- TODO: fix leak\n- consider refactoring X" },
				{ name: "audit", text: "broken on safari" },
			],
			10,
		);
		expect(out.map((f) => f.class).sort()).toEqual(["bug", "bug", "refactor"]);
		expect(new Set(out.map((f) => f.text)).size).toBe(out.length); // deduped
	});
	it("drops dangling-connector fragments + objective restatements", () => {
		const out = extractFindings(
			[{ name: "s", text: "Run a scan on the codebase to" }],
			10,
			"Run a scan on the codebase to find bugs",
		);
		expect(out).toEqual([]);
	});
});

describe("reviewer — report + safety", () => {
	it("formatReviewReport renders sections per class", () => {
		const r = formatReviewReport({
			goalId: "g1", kind: "goal", objective: "ship it",
			findings: [{ text: "TODO: x", source: "summary", class: "bug" }],
			cascadeStep: "convert-findings-to-list", mode: "on", at: "2026-07-31T00:00:00.000Z",
		});
		expect(r).toContain("Bug-class");
		expect(r).toContain("TODO: x");
	});
	it("writeReviewReport writes a file under <cwd>/.pi/core-task/reviews/", () => {
		const dir = mkdtempSync(join(tmpdir(), "rev-"));
		try {
			const p = runWriteReport(dir);
			expect(readFileSync(p, "utf8")).toContain("Review — g1");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	it("reviewerFiredRecently + reviewsToday read ledger entries", () => {
		const now = Date.parse("2026-07-31T12:00:00.000Z");
		const entries = [{ type: "reviewer_fired", at: "2026-07-31T11:58:00.000Z" }];
		expect(reviewerFiredRecently(entries, REVIEWER_REFIRE_WINDOW_MS, now)).toBe(true);
		expect(reviewerFiredRecently(entries, REVIEWER_REFIRE_WINDOW_MS, now + 10 * 60_000)).toBe(false);
		expect(reviewsToday(entries, now)).toBe(1);
	});
});

// helper for the writeReport test (writeReportReport path differs from GLA's .pi-gla path — see adaptation below)
function runWriteReport(cwd: string): string {
	const { writeReviewReport } = require("../reviewer.js");
	return writeReviewReport(cwd, {
		goalId: "g1", kind: "goal", objective: "o",
		findings: [], cascadeStep: "notify-and-idle", mode: "on", at: "2026-07-31T00:00:00.000Z",
	});
}

describe("reviewer — runReviewer cascade (on mode)", () => {
	const baseSource = { kind: "goal" as const, goalId: "g1", objective: "ship feature X", terminal: "goal-complete" };
	function depsFor(sourcesText: string) {
		const enqueued: string[] = [];
		const proposed: Array<{ objective: string; reason: string }> = [];
		const notified: Array<{ m: string; lvl: string }> = [];
		const ledger: Array<{ type: string; value: Record<string, unknown> }> = [];
		const cwd = mkdtempSync(join(tmpdir(), "rev-"));
		return {
			deps: {
				cwd, nowMs: Date.parse("2026-07-31T12:00:00.000Z"), ledgerEntries: [],
				sources: [{ name: "summary", text: sourcesText }],
				enqueueListItems: (o: string[]) => { enqueued.push(...o); },
				proposeGoal: (objective: string, reason: string) => { proposed.push({ objective, reason }); return true; },
				notify: (m: string, lvl: "info" | "warning") => { notified.push({ m, lvl }); },
				ledger: (type: string, value: Record<string, unknown>) => { ledger.push({ type, value }); },
			} as const,
			cleanup: () => rmSync(cwd, { recursive: true, force: true }),
			assert: { enqueued, proposed, notified, ledger },
		};
	}

	it("bug/refactor findings -> enqueueListItems (no proposeGoal)", () => {
		const h = depsFor("- TODO: fix leak\n- consider refactoring Y");
		try {
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, baseSource, h.deps);
			expect(out.fired).toBe(true);
			expect(h.assert.enqueued).toHaveLength(2);
			expect(h.assert.proposed).toHaveLength(0);
			expect(out.cascadeStep).toBe("convert-findings-to-list");
		} finally { h.cleanup(); }
	});

	it("architectural finding -> proposeGoal (Confirm-gated by wiring, not here)", () => {
		const h = depsFor("- we should rewrite the auth layer");
		try {
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, baseSource, h.deps);
			expect(h.assert.proposed).toHaveLength(1);
			expect(h.assert.proposed[0].objective).toContain("rewrite the auth layer");
			expect(out.cascadeStep).toBe("propose-goal");
		} finally { h.cleanup(); }
	});

	it("clean completion -> regression-scan proposeGoal", () => {
		const h = depsFor("all done, nothing left");
		try {
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, baseSource, h.deps);
			expect(h.assert.proposed).toHaveLength(1);
			expect(h.assert.proposed[0].objective).toContain("regression scan");
			expect(out.cascadeStep).toBe("fire-audit-on-clean");
		} finally { h.cleanup(); }
	});

	it("duplicate-scan: a scan objective completing does NOT re-propose the same scan", () => {
		const scanSource = { ...baseSource, objective: "Post-completion regression scan after g1 (regression-scan)" };
		const h = depsFor("nothing left");
		try {
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, scanSource, h.deps);
			expect(out.cascadeStep).toBe("duplicate-suppressed");
			expect(h.assert.proposed).toHaveLength(0);
		} finally { h.cleanup(); }
	});

	it("suppressed when disabled", () => {
		const h = depsFor("- TODO: x");
		try {
			const out = runReviewer({ ...DEFAULT_REVIEWER_CONFIG, enabled: false }, baseSource, h.deps);
			expect(out.fired).toBe(false);
			expect(out.suppressedReason).toMatch(/disabled|off/);
		} finally { h.cleanup(); }
	});

	it("suppressed within the refire window", () => {
		const cwd = mkdtempSync(join(tmpdir(), "rev-"));
		try {
			const now = Date.parse("2026-07-31T12:00:00.000Z");
			const deps = {
				cwd, nowMs: now, ledgerEntries: [{ type: "reviewer_fired", at: "2026-07-31T11:58:00.000Z" }],
				sources: [{ name: "s", text: "- TODO: x" }],
				enqueueListItems: () => {}, proposeGoal: () => true, notify: () => {}, ledger: () => {},
			};
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, baseSource, deps);
			expect(out.fired).toBe(false);
			expect(out.suppressedReason).toMatch(/5 minutes|runaway/);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});

	it("wrong terminal (paused) never fires", () => {
		const h = depsFor("- TODO: x");
		try {
			const out = runReviewer(DEFAULT_REVIEWER_CONFIG, { ...baseSource, terminal: "goal-paused" }, h.deps);
			expect(out.fired).toBe(false);
		} finally { h.cleanup(); }
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/reviewer.test.ts )`
Expected: FAIL — `extractFindings`/`runReviewer` not exported.

- [ ] **Step 3: Implement reviewer.ts (second half) — verbatim port from GLA**

Append to `src/goal/reviewer.ts`. Port verbatim from GLA `reviewer.ts` the remainder: `extractFindings`, `reviewerFiredRecently`, `reviewsToday`, `ReviewReport`, `formatReviewReport`, `writeReviewReport`, `ReviewerDeps`, `ReviewerOutcome`, `REVIEWER_REFIRE_WINDOW_MS`, `runReviewer`. 

**Adaptation vs GLA (apply now):**
1. **Report path.** GLA's `writeReviewReport` writes to `path.join(cwd, ".pi-glla", "reviews", ...)`. core-task writes to `path.join(cwd, ".pi", "core-task", "reviews", ...)` instead (spec D7). Change ONLY the directory constant; the filename shape (`${goalId}-${ts}.md`) stays.
2. **Drop `reviewerMenuOptions`** (baseline has no settings menu — spec §2 non-goal). Do not port it.
3. Everything else (`runReviewer` cascade logic, suppression gates, duplicate-scan dedupe, `proposeGoal: () => boolean` contract) ports **exactly**.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/reviewer.test.ts )`
Expected: PASS (all suites green).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/reviewer.ts bun-apps/pi-agent-ext-core-task/src/goal/__tests__/reviewer.test.ts
git commit -m "feat(core-task/reviewer): extractFindings + runReviewer cascade + safety (port from GLA)"
```

---

### Task 3: `state.ts` + `format.ts` — `origin` field + `reviewerEnabled`

**Files:**
- Modify: `src/goal/format.ts` (`ActiveGoal` interface)
- Modify: `src/goal/state.ts` (`createGoal`, `goalState`, `__resetGoalState`)
- Modify: `src/goal/goal.ts` (the `promoteNext` call site passes `origin: "list"`)
- Modify: `src/goal/__tests__/state.test.ts`

**Interfaces:**
- Produces: `ActiveGoal.origin?: "list" | "bare"`; `createGoal(text, tokenBudget, baselineTokens, audit?, origin?)`; `goalState.reviewerEnabled: boolean` (default `true`).

- [ ] **Step 1: Write the failing tests**

Append to `src/goal/__tests__/state.test.ts`:

```ts
import { createGoal, goalState, __resetGoalState } from "../state.js";

describe("reviewer wiring — state", () => {
	it("createGoal defaults origin to 'bare'", () => {
		__resetGoalState();
		const g = createGoal("x", undefined, 0);
		expect(g.origin).toBe("bare");
	});
	it("createGoal accepts origin: 'list'", () => {
		const g = createGoal("y", undefined, 0, undefined, "list");
		expect(g.origin).toBe("list");
	});
	it("goalState.reviewerEnabled defaults true and resets on __resetGoalState", () => {
		__resetGoalState();
		expect(goalState.reviewerEnabled).toBe(true);
		goalState.reviewerEnabled = false;
		__resetGoalState();
		expect(goalState.reviewerEnabled).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/state.test.ts )`
Expected: FAIL — `origin` undefined / `reviewerEnabled` missing.

- [ ] **Step 3: Implement**

(a) In `src/goal/format.ts`, add to the `ActiveGoal` interface:
```ts
	/** Origin: "list" = promoted from a /list item, "bare" = a plain /goal. Drives the Reviewer `kind`. */
	origin?: "list" | "bare";
```

(b) In `src/goal/state.ts` `createGoal`, add the param + set it:
```ts
export function createGoal(
	text: string,
	tokenBudget: number | undefined,
	baselineTokens: number,
	audit?: GoalAuditOptions,
	origin: "list" | "bare" = "bare",
): ActiveGoal {
	const now = Date.now();
	return {
		id: randomUUID(),
		text,
		origin,
		status: "active",
		// …rest unchanged…
```

(c) In `src/goal/state.ts` `GoalRuntimeState` interface add `reviewerEnabled: boolean;`; in the `goalState` initializer add `reviewerEnabled: true,`; in `__resetGoalState` add `goalState.reviewerEnabled = true;`.

(d) In `src/goal/goal.ts`, at the promoteNext call site (~line 327), pass `"list"`:
```ts
			goalState.activeGoal = createGoal(item.text, item.tokenBudget, currentTokenTotal(ctx), item.audit, "list");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/state.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/format.ts bun-apps/pi-agent-ext-core-task/src/goal/state.ts bun-apps/pi-agent-ext-core-task/src/goal/goal.ts bun-apps/pi-agent-ext-core-task/src/goal/__tests__/state.test.ts
git commit -m "feat(core-task/goal): ActiveGoal.origin + goalState.reviewerEnabled for the Reviewer"
```

---

### Task 4: `persistence.ts` — reviewer ledger entry

**Files:**
- Modify: `src/goal/persistence.ts`
- Modify: `src/goal/__tests__/persistence.test.ts`

**Interfaces:**
- Produces: `REVIEWER_ENTRY_TYPE = "goal-reviewer"`, `ReviewerLedgerRecord`, `appendReviewerEntry(api, record)`, `loadReviewerEntries(sessionManager): ReviewerLedgerRecord[]`.

- [ ] **Step 1: Write the failing tests**

Append to `src/goal/__tests__/persistence.test.ts` (mirror the existing session-store fake used by the goal-state round-trip tests in that file):

```ts
import { appendReviewerEntry, loadReviewerEntries, REVIEWER_ENTRY_TYPE } from "../persistence.js";

describe("reviewer ledger persistence", () => {
	it("appendReviewerEntry -> loadReviewerEntries round-trips by entry type", () => {
		const store: Array<{ type: string; customType?: string; data: unknown }> = [];
		const fakeApi = { appendEntry: (customType: string, data: unknown) => { store.push({ type: "custom", customType, data }); } };
		const fakeSm = { getEntries: () => store };

		appendReviewerEntry(fakeApi as never, { type: "reviewer_fired", at: "2026-07-31T12:00:00.000Z", goalId: "g1", cascadeStep: "convert-findings-to-list", enqueued: 2, proposed: 0 });
		appendReviewerEntry(fakeApi as never, { type: "reviewer_suppressed", at: "2026-07-31T12:01:00.000Z", goalId: "g2", reason: "refire-window" });

		const entries = loadReviewerEntries(fakeSm as never);
		expect(entries).toHaveLength(2);
		expect(entries[0].type).toBe("reviewer_fired");
		expect(entries[1].reason).toBe("refire-window");
	});
	it("REVIEWER_ENTRY_TYPE is 'goal-reviewer'", () => {
		expect(REVIEWER_ENTRY_TYPE).toBe("goal-reviewer");
	});
});
```

**Note:** read the existing `src/goal/__tests__/persistence.test.ts` first — it already constructs a session-store fake. Reuse that exact fake shape so the test matches how `loadGoalStateFromSession` reads entries (filter `entry.type === "custom" && entry.customType === ...`). If the real fake differs from the sketch above, adapt the test to the real fake; the assertion intent stays the same.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/persistence.test.ts )`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

In `src/goal/persistence.ts`, add (mirroring the existing `persistGoalState`/`loadGoalStateFromSession` patterns):

```ts
export const REVIEWER_ENTRY_TYPE = "goal-reviewer";

export interface ReviewerLedgerRecord {
	type: "reviewer_fired" | "reviewer_suppressed";
	at: string;
	goalId: string;
	cascadeStep?: string;
	enqueued?: number;
	proposed?: number;
	reason?: string;
}

export function appendReviewerEntry(api: GoalPersistenceApi | undefined, record: ReviewerLedgerRecord): void {
	api?.appendEntry(REVIEWER_ENTRY_TYPE, record);
}

export function loadReviewerEntries(sessionManager: unknown): ReviewerLedgerRecord[] {
	const sm = sessionManager as { getEntries?: () => Array<{ type: string; customType?: string; data: unknown }> };
	const entries = sm.getEntries?.() ?? [];
	return entries
		.filter((e) => e.type === "custom" && e.customType === REVIEWER_ENTRY_TYPE)
		.map((e) => e.data as ReviewerLedgerRecord);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/persistence.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/persistence.ts bun-apps/pi-agent-ext-core-task/src/goal/__tests__/persistence.test.ts
git commit -m "feat(core-task/goal): reviewer ledger session-store entry (append/load)"
```

---

### Task 5: `goal.ts` — wire `runReviewer` at clean-complete + Confirm loop

**Files:**
- Modify: `src/goal/goal.ts` (the clean-complete terminal path, ~line 323, before `clearActiveGoal`)
- Modify: `src/goal/__tests__/hardening-loop.test.ts` (append a reviewer-wiring suite)

**Interfaces:**
- Consumes: Task 1–2 `runReviewer`/`resolveReviewerConfig`; Task 3 `origin`/`reviewerEnabled`; Task 4 `loadReviewerEntries`/`appendReviewerEntry`.
- Produces: the live Reviewer cascade at every clean complete.

- [ ] **Step 1: Write the failing tests**

Read `src/goal/__tests__/hardening-loop.test.ts` first to learn its mock-ctx harness (how it fakes `ctx.ui.confirm`/`ctx.ui.notify`/`ctx.sessionManager` and drives `goal_complete`). Append a suite that reuses that harness:

```ts
describe("reviewer wiring on clean complete", () => {
	// helpers from the existing file: makeCtx(), driveComplete(summary), resetGoal()

	it("bug-shaped summary enqueues a /list item, no Confirm", async () => {
		const ctx = makeCtx({ confirmReturns: true });
		await driveComplete(ctx, "Done. - TODO: still leaks on big inputs");
		expect(goalState.list.map((i) => i.text)).toContain("TODO: still leaks on big inputs");
		expect(ctx.confirms).toHaveLength(0); // bug -> no confirm
	});

	it("architectural summary records a proposal; accept -> createGoal + terminate:false", async () => {
		const ctx = makeCtx({ confirmReturns: true });
		const res = await driveComplete(ctx, "Done. - we should rewrite the auth layer");
		expect(ctx.confirms.length).toBeGreaterThanOrEqual(1);
		expect(goalState.activeGoal?.text).toContain("rewrite the auth layer");
		expect(res.terminate).toBe(false);
	});

	it("architectural summary declined -> terminate:true, goal cleared", async () => {
		const ctx = makeCtx({ confirmReturns: false });
		const res = await driveComplete(ctx, "Done. - we should rewrite the auth layer");
		expect(res.terminate).toBe(true);
		expect(goalState.activeGoal).toBeUndefined();
	});

	it("clean summary -> regression-scan proposal Confirm", async () => {
		const ctx = makeCtx({ confirmReturns: true });
		await driveComplete(ctx, "Everything is done and verified. Nothing left.");
		expect(goalState.activeGoal?.text).toContain("regression scan");
	});

	it("paused goal never fires the reviewer", async () => {
		const ctx = makeCtx({ confirmReturns: true });
		await driveToPause(ctx); // existing helper or a 3x-disapprove path
		expect(ctx.confirms).toHaveLength(0);
	});

	it("refire window: a second clean complete within 5 min is suppressed", async () => {
		const ctx = makeCtx({ confirmReturns: true });
		await driveComplete(ctx, "Done. - TODO: a");
		const firstConfirms = ctx.confirms.length;
		await driveComplete(ctx, "Done. - TODO: b"); // would normally re-fire
		expect(ctx.confirms.length).toBe(firstConfirms); // suppressed
	});

	it("bare /goal with clean summary + decline -> byte-identical completion (regression)", async () => {
		const ctx = makeCtx({ confirmReturns: false });
		const res = await driveComplete(ctx, "All done, verified, nothing left.");
		expect(res.terminate).toBe(true);
		// the user-facing completion text must still terminate cleanly:
		expect(res.content[0].text).toContain("Goal complete");
	});

	it("a throwing dep does not block completion (try/catch)", async () => {
		const ctx = makeCtx({ confirmThrows: true });
		const res = await driveComplete(ctx, "Done. - we should rewrite everything");
		expect(res.terminate).toBe(true); // still completes
		expect(ctx.notifies.some((n) => /Reviewer skipped/i.test(n.m))).toBe(true);
	});
});
```

(Adapt the helper names/signatures to the real harness in the file — the assertion *intent* is what matters. If `driveToPause`/`confirmThrows` don't exist, add minimal fakes.)

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/hardening-loop.test.ts )`
Expected: FAIL — no Reviewer wiring yet; `goalState.list` stays empty, no confirms.

- [ ] **Step 3: Implement the wiring**

In `src/goal/goal.ts`, at the clean-complete terminal path — immediately **after** `const { item, rest } = promoteNext(goalState.list);` and the `if (item) { … return; }` block, i.e. right before `clearActiveGoal(ctx);` — insert the Reviewer block from spec §6 (read the spec for the exact code; reproduce it verbatim). Key points the code must honor:

- `runReviewer(resolveReviewerConfig({ enabled: goalState.reviewerEnabled }), { kind: completedGoal.origin === "list" ? "list" : "goal", goalId: completedGoal.id, objective: completedGoal.text, terminal: "goal-complete" }, deps)` — `proposeGoal` is **sync**, pushes onto a local `recordedProposals` array, returns `true`.
- After `runReviewer`, `appendReviewerEntry(...)` records the fire/suppression.
- Then the async Confirm loop: `for (const p of recordedProposals) { const ok = await ctx.ui.confirm(...); if (ok) { acceptedObjective = p.objective; break; } }`.
- If `acceptedObjective`: `createGoal(acceptedObjective, undefined, currentTokenTotal(ctx), undefined)` + persist + `updateStatus` + `return { …, terminate: false }`.
- The whole block is wrapped in `try { … } catch (reviewerError) { ctx.ui.notify(\`Reviewer skipped (non-fatal): ${String(reviewerError)}\`, "warning"); }`.
- Add the imports at the top of `goal.ts`: `import { runReviewer, resolveReviewerConfig } from "./reviewer.js";` and `import { appendReviewerEntry, loadReviewerEntries } from "./persistence.js";` and `import { addListItems } from "./list.js";` (if not already imported).

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/hardening-loop.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/goal.ts bun-apps/pi-agent-ext-core-task/src/goal/__tests__/hardening-loop.test.ts
git commit -m "feat(core-task/goal): wire Reviewer at clean-complete with Confirm loop (GLA on-mode baseline)"
```

---

### Task 6: `commands.ts` + `goal.ts` — `/goal review on|off`

**Files:**
- Modify: `src/goal/commands.ts` (`CommandResult`, `parseCommand`, `GOAL_ARGUMENT_COMPLETIONS`)
- Modify: `src/goal/goal.ts` (dispatch the `review` kind)
- Modify: `src/goal/__tests__/commands.test.ts`

**Interfaces:**
- Produces: `CommandResult` variant `{ kind: "review"; enabled: boolean }`; `parseCommand` routes `/goal review on|off`.

- [ ] **Step 1: Write the failing tests**

Append to `src/goal/__tests__/commands.test.ts`:

```ts
import { parseCommand } from "../commands.js";

describe("/goal review parsing", () => {
	it("review on -> { kind: review, enabled: true }", () => {
		expect(parseCommand("review on")).toEqual({ kind: "review", enabled: true });
	});
	it("review off -> { kind: review, enabled: false }", () => {
		expect(parseCommand("review off")).toEqual({ kind: "review", enabled: false });
	});
	it("review with no/bad arg -> usage error string", () => {
		expect(typeof parseCommand("review")).toBe("string");
		expect(typeof parseCommand("review maybe")).toBe("string");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/commands.test.ts )`
Expected: FAIL — `/goal review` falls through to `parseObjective` → `{ kind: "start", objective: "review on" }`.

- [ ] **Step 3: Implement**

(a) In `src/goal/commands.ts`, extend the `CommandResult` union:
```ts
export interface CommandResult {
	kind: "show" | "start" | "pause" | "resume" | "clear" | "edit" | "audit" | "review";
	objective?: string;
	tokenBudget?: number;
	audit?: boolean;
	auditorModel?: string;
	enabled?: boolean; // for kind: "review"
}
```
Add to `parseCommand`, before `return parseObjective("start", tokens);`:
```ts
	if (first === "review") {
		const arg = rest[0]?.toLowerCase();
		if (arg === "on") return { kind: "review", enabled: true };
		if (arg === "off") return { kind: "review", enabled: false };
		return "Usage: /goal review on|off";
	}
```
Add an arg-completion entry to `GOAL_ARGUMENT_COMPLETIONS`:
```ts
	{ value: "review ", label: "review", description: "Toggle the post-completion Reviewer (on|off)" },
```

(b) In `src/goal/goal.ts`, in the `/goal` command handler's dispatch (where `pause`/`resume`/`clear` etc. are handled), add:
```ts
			if (cmd.kind === "review") {
				goalState.reviewerEnabled = cmd.enabled;
				ctx.ui.notify(`Reviewer ${cmd.enabled ? "enabled" : "disabled"} for this session.`, "info");
				return;
			}
```
(Place it alongside the other single-line `cmd.kind` branches; match the surrounding control-flow shape exactly.)

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/commands.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/commands.ts bun-apps/pi-agent-ext-core-task/src/goal/goal.ts bun-apps/pi-agent-ext-core-task/src/goal/__tests__/commands.test.ts
git commit -m "feat(core-task/goal): /goal review on|off session toggle for the Reviewer"
```

---

### Task 7: `format.ts` — `/goal status` shows the last review

**Files:**
- Modify: `src/goal/format.ts` (the status-rendering function)
- Modify: `src/goal/__tests__/format.test.ts`

**Interfaces:**
- Consumes: Task 4 `loadReviewerEntries`.

- [ ] **Step 1: Write the failing test**

Append to `src/goal/__tests__/format.test.ts`:

```ts
it("status line includes the last review cascade step when present", () => {
	const line = renderGoalStatusLine({
		/* …existing status input fixture… */,
		lastReview: { cascadeStep: "convert-findings-to-list", enqueued: 2, at: "2026-07-31T12:00:00.000Z" },
	});
	expect(line).toContain("review:");
});
```

(Adapt the fixture name to the real `renderGoalStatusLine`/equivalent in `format.ts` — read it first. The assertion: when a `lastReview` summary is passed, the rendered status mentions "review:" + the cascade step.)

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/format.test.ts )`
Expected: FAIL — `lastReview` not rendered.

- [ ] **Step 3: Implement**

Read `src/goal/format.ts` to find the function that renders `/goal status`. Add an optional `lastReview?: { cascadeStep: string; enqueued?: number; proposed?: number; reportPath?: string }` param; when present, append a dim line like ` · review: <cascadeStep> (<enqueued> enqueued, <proposed> proposed)`. The caller in `goal.ts` (the `status` command branch) reads `loadReviewerEntries(ctx.sessionManager)` and passes the last entry's summary. Keep it minimal and narrow-terminal-safe (drop the review segment before truncating the status head, per the list-loop-spec widget convention).

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-core-task && bun test src/goal/__tests__/format.test.ts )`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/format.ts bun-apps/pi-agent-ext-core-task/src/goal/__tests__/format.test.ts bun-apps/pi-agent-ext-core-task/src/goal/goal.ts
git commit -m "feat(core-task/goal): /goal status shows the last Reviewer cascade step"
```

---

### Task 8: Verify — full suite + cross-package typecheck

**Files:** none (verification only).

- [ ] **Step 1: Per-package suite + typecheck**

Run:
```bash
( cd bun-apps/pi-agent-ext-core-task && bun test )
( cd bun-apps/pi-agent-ext-core-task && bun run typecheck )
```
Expected: all tests green; `tsc --noEmit` 0 errors.

- [ ] **Step 2: Cross-package typecheck (the real CI gate)**

Run from repo root:
```bash
bunx tsc --noEmit -p bun-apps/pi-agent-ext-core-task/tsconfig.json
```
(If that project ref pulls siblings, great; otherwise run the repo-root `bunx tsc --noEmit` that CI's `test · pi-agent` job runs — read `.github/workflows/*.yml` to confirm the exact command.) Expected: 0 errors. This is where PR #949's ResourceLoader break slipped through — do not skip it.

- [ ] **Step 3: Naming/grep guard (from core-task conventions)**

Run:
```bash
grep -rn "oracle\|sisyphus\|squad\|forge\|pi-gla-" bun-apps/pi-agent-ext-core-task/src bun-apps/pi-agent-ext-core-task/extensions | grep -v node_modules || echo "clean"
```
Expected: `clean` (no banned vocab leaked from the GLA port).

- [ ] **Step 4: Final commit (if any fixups)**

If Steps 1–3 needed fixups, commit them. Otherwise no commit.

---

## Self-Review (completed by plan author)

**Spec coverage:** §3 D1 (faithful port) → Tasks 1–2. D2 (sources = summary + disapproved audits) → Task 5 wiring sources. D3 (trigger at clean-complete terminal) → Task 5. D4 (Confirm outside pure fn) → Tasks 2 (sync proposeGoal) + 5 (Confirm loop). D5 (safety subset) → Task 2 (refire/day-cap/dup-scan in runReviewer) + Task 5 tests. D6 (persistence) → Task 4. D7 (report path `.pi/core-task/reviews`) → Task 2 adaptation. D8 (config + `/goal review` toggle) → Task 6. §4 architecture (new reviewer.ts + edits) → file structure table. §5 cascade → Task 2 tests pin every branch. §6 wiring → Task 5. §7 persistence → Task 4. §8 UX delta (bare-/goal Confirm regression) → Task 5 regression test. §9 testing → distributed across tasks. **No spec gap.**

**Type consistency:** `createGoal` 5th param `origin` (Task 3) consumed in goal.ts promoteNext (Task 3d) + read as `completedGoal.origin` (Task 5). `reviewerEnabled` (Task 3) toggled by Task 6, read by Task 5. `appendReviewerEntry`/`loadReviewerEntries` (Task 4) consumed by Task 5. `runReviewer` `proposeGoal` returns `boolean` sync (Task 2) — Task 5's dep matches. `CommandResult` `review`/`enabled` (Task 6) consistent throughout.

**Placeholder scan:** Tasks that port from GLA cite the absolute source path + enumerate exact adaptations (not placeholders — the file is readable). All core-task-specific code is inlined. Test helper sketches note where the implementer must match the existing harness fixture (honest; the harness exists in-file).

**Scope:** single implementation plan; baseline only; non-goals (auto/aggressive, config menu, `/review <id>`, plan/wayfind adaptation) explicitly deferred.
