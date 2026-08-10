# Simplify recent code — Phase 1 (reduced scope) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the behavior-preserving Phase-1 dedup that survived re-investigation — a `setAndPersistGoal` helper collapsing 20 persist+status pairs in core-task, and a `stripWikiLinkBrackets` helper + tool-allowlist consolidation in knowledge-card — with zero behavior change.

**Architecture:** Two packages, three tasks. core-task gains one module-private `setAndPersistGoal(goal, ctx)` helper in `src/goal/goal.ts` applied to the 20 clean `persistGoal(...)+updateStatus(...)` pairs (the 5 persist-only, 2 conditional, and 1 status-only sites are deliberately left as-is — folding them would change behavior). knowledge-card gains one exported pure `stripWikiLinkBrackets(content)` helper applied to 3 sites in `src/ingest.ts` (with a new unit test), plus a module-private `BASE_OBSIDIAN_TOOLS` base array in `extensions/knowledge-card.ts` that the 6 identical Obsidian allowlists spread from (DISTILL_TOOLS keeps its `"read"` prefix; all 7 exported names are preserved). wayfind and workflow have NO Phase-1 work (investigated — see "Dropped items").

**Tech Stack:** TypeScript (`tsc`), `bun test`; packages `bun-apps/pi-agent-ext-core-task` and `bun-apps/pi-agent-ext-knowledge-card`.

## Global Constraints
- Behavior-preserving: ZERO behavior change; each package's existing test suite is the contract. No snapshot regeneration.
- No public API change: knowledge-card's tool consts (`DISTILL_TOOLS`, `ADD_TOOLS`, …) stay exported under their original names — only their definitions change to spread from a shared base. `stripWikiLinkBrackets` is a newly-EXPORTED pure helper (so it can be unit-tested). `BASE_OBSIDIAN_TOOLS` is module-private.
- Per-task gate (must be green before every commit):
  - knowledge-card: `( cd bun-apps/pi-agent-ext-knowledge-card && bunx tsc --noEmit && bun test )` (no `typecheck` script in this package; run `tsc` directly).
  - core-task: `( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )` (typecheck = `tsc --noEmit`).
- core-task's `setAndPersistGoal` is MODULE-PRIVATE (it calls the private `updateStatus`); place it as a `function` declaration right after `updateStatus` so hoisting lets all earlier call sites resolve.
- `updateStatus(ctx, _goal)`'s 2nd arg is dead (reads `goalState.activeGoal` directly) — do NOT change `updateStatus`'s signature in this effort; the helper passes `goal` for readability parity (orthogonal cleanup, deferred).
- Match each file's existing indentation (tabs in these files).

## Dropped items (investigated, not applicable — do NOT implement)
These `spec.md` Phase-1 items were re-investigated against current code and dropped. Recorded here so the deviation from the approved spec is explicit:
- **wayfind `readWayfindGrill`** — NOT dead: exercised by `tests/grill-seam.test.ts` (7 uses); a publish/read/unpublish seam reading `globalThis` (cross-package). Removing breaks tests.
- **wayfind render error-guards** — 2 distinct guard patterns + unique success logic per fn → a `renderWithErrorCheck` helper adds more complexity than it removes. Low ROI.
- **subagent `pairToolCallsWithResults`** — NO duplication exists: pairing logic is only in `formatSubagentTrace`; `formatSubagentLive` maps through `formatHistoryLine`. Spec premise was wrong.
- **subagent `Text` import** — USED at `subagent-tool.ts:1025,1042` (`new Text(...)`, `as Text`). Not unused.
- **subagent `describeLastActivity`/`formatHistoryLine` merge** — marginal (differs by marker flag + truncate len); not in the chosen reduced scope. Deferred.
- **workflow `progress()` helper** — ALREADY EXISTS at `workflow-manager.ts:499-505`.
- **workflow `loopUntilDry` `maxRounds`** — public `Stdlib` member, defaulted 50, overridden by RCA#8 test (`maxRounds:5`), reachable by user scripts. NOT safe to drop.
- **workflow `defaultAgentLabel` `phase`** — both ternary branches reachable; `assignedPhase` is genuinely `string|undefined`; the `=LIVE` default the spec referenced does not exist. NOT safe to drop.

---

### Task 1: knowledge-card — add `stripWikiLinkBrackets` helper + unit test, apply to 3 sites

**Files:**
- Modify: `bun-apps/pi-agent-ext-knowledge-card/src/ingest.ts` (add exported `stripWikiLinkBrackets` at module scope; replace the inline regex at ~336-344, ~536-542, ~649-655)
- Test: `bun-apps/pi-agent-ext-knowledge-card/__tests__/ingest.test.ts` (add a `stripWikiLinkBrackets` block; match the file's existing import style)

**Interfaces:**
- Produces: `export function stripWikiLinkBrackets(content: string): string` — replaces `[[target|alias]]` / `[[target#anchor]]` / `[[target]]` with display text (alias > target > raw inner). Pure.

- [ ] **Step 1: Write the failing unit test (TDD).**
Add to `__tests__/ingest.test.ts` (match its existing `describe`/`it`/`expect` import style):
```ts
describe("stripWikiLinkBrackets", () => {
	it("unwraps a plain target", () => {
		expect(stripWikiLinkBrackets("[[foo]]")).toBe("foo");
	});
	it("prefers an alias over the target", () => {
		expect(stripWikiLinkBrackets("[[foo|bar]]")).toBe("bar");
	});
	it("strips a heading anchor, keeps the target", () => {
		expect(stripWikiLinkBrackets("[[foo#section]]")).toBe("foo");
	});
	it("alias wins even when an anchor is present", () => {
		expect(stripWikiLinkBrackets("[[foo#section|bar]]")).toBe("bar");
	});
	it("leaves non-wiki-link text untouched", () => {
		expect(stripWikiLinkBrackets("plain text")).toBe("plain text");
	});
	it("handles multiple links in one string", () => {
		expect(stripWikiLinkBrackets("see [[a]] and [[b|bb]]")).toBe("see a and bb");
	});
});
```
Import `stripWikiLinkBrackets` from the same place that file already imports ingest's exports (adjust the path to match — likely `../src/ingest`).

- [ ] **Step 2: Run the test, verify it FAILS.**
Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/ingest.test.ts )`
Expected: FAIL — `stripWikiLinkBrackets` is not exported.

- [ ] **Step 3: Add the helper to `src/ingest.ts` and apply it to the 3 sites.**
Add at module scope (e.g. after the imports, near other module helpers):
```ts
/**
 * Replace Obsidian wiki-links (`[[target|alias]]`, `[[target#anchor]]`,
 * `[[target]]`) with their display text: alias wins, else the target (anchor
 * stripped), else the raw inner text. Shared by the three markdown adapters.
 */
export function stripWikiLinkBrackets(content: string): string {
	return content.replace(/\[\[([^\]]+)\]\]/g, (_full, inner: string) => {
		const parts = String(inner).split("|");
		const target = parts[0]!.split("#")[0]!.trim();
		const alias = parts[1]?.trim();
		return alias || target || String(inner);
	});
}
```
Then replace the 3 inline blocks. Read each site first to confirm it matches, then replace:

Site A (~336-344, in `adaptAutoMemoryMarkdown`) — replace the whole `const detailBody = body ? body.replace(...) : body;` block with:
```ts
	const detailBody = body ? stripWikiLinkBrackets(body) : body;
```
Site B (~536-542, in `adaptHermesMarkdown`) — replace the `const detail = bodyNoTs.replace(/\[\[...\]\]/g, ...);` block with:
```ts
		const detail = stripWikiLinkBrackets(bodyNoTs);
```
Site C (~649-655, in `adaptGenericMarkdown`) — replace the whole `const detail = body ? body.replace(...) : body;` block with:
```ts
	const detail = body ? stripWikiLinkBrackets(body) : body;
```

- [ ] **Step 4: Run the test, verify PASS.**
Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bun test __tests__/ingest.test.ts )`
Expected: PASS (all stripWikiLinkBrackets cases + existing ingest tests).

- [ ] **Step 5: Full gate.**
Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bunx tsc --noEmit && bun test )`
Expected: tsc clean; all package tests pass. No behavior change (the regex callback is byte-identical to the 3 inlined ones).

- [ ] **Step 6: Commit.**
```bash
git add bun-apps/pi-agent-ext-knowledge-card/src/ingest.ts bun-apps/pi-agent-ext-knowledge-card/__tests__/ingest.test.ts
git commit -m "refactor(knowledge-card): extract stripWikiLinkBrackets helper (3 sites)"
```

---

### Task 2: knowledge-card — consolidate the 6 identical Obsidian tool allowlists

**Files:**
- Modify: `bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts` (the 7 consts at ~120-126)

- [ ] **Step 1: Replace the 7 consts.**
Current (verify by reading ~120-126):
```ts
export const DISTILL_TOOLS = ["read", "obsidian", "obsidian_help"];
export const ADD_TOOLS = ["obsidian", "obsidian_help"];
export const FIND_TOOLS = ["obsidian", "obsidian_help"];
export const UPDATE_TOOLS = ["obsidian", "obsidian_help"];
export const REMOVE_TOOLS = ["obsidian", "obsidian_help"];
export const CHECK_TOOLS = ["obsidian", "obsidian_help"];
export const RAG_TOOLS = ["obsidian", "obsidian_help"];
```
Replace with (leave `RAG_TOOLS_THREE_WAY` at ~134 untouched — different value):
```ts
/** Shared Obsidian-backed allowlist; each tool spreads a fresh copy so they stay independently mutable. */
const BASE_OBSIDIAN_TOOLS = ["obsidian", "obsidian_help"];

export const DISTILL_TOOLS = ["read", ...BASE_OBSIDIAN_TOOLS];
export const ADD_TOOLS = [...BASE_OBSIDIAN_TOOLS];
export const FIND_TOOLS = [...BASE_OBSIDIAN_TOOLS];
export const UPDATE_TOOLS = [...BASE_OBSIDIAN_TOOLS];
export const REMOVE_TOOLS = [...BASE_OBSIDIAN_TOOLS];
export const CHECK_TOOLS = [...BASE_OBSIDIAN_TOOLS];
export const RAG_TOOLS = [...BASE_OBSIDIAN_TOOLS];
```
(Each spread makes an independent mutable `string[]`; values byte-identical to the originals. `DISTILL_TOOLS` keeps its `"read"` prefix — it was never identical to the others.)

- [ ] **Step 2: Full gate.**
Run: `( cd bun-apps/pi-agent-ext-knowledge-card && bunx tsc --noEmit && bun test )`
Expected: tsc clean; all tests pass (values unchanged).

- [ ] **Step 3: Commit.**
```bash
git add bun-apps/pi-agent-ext-knowledge-card/extensions/knowledge-card.ts
git commit -m "refactor(knowledge-card): consolidate identical Obsidian tool allowlists via BASE_OBSIDIAN_TOOLS"
```

---

### Task 3: core-task — add `setAndPersistGoal` helper, apply to 20 persist+status pairs

**Files:**
- Modify: `bun-apps/pi-agent-ext-core-task/src/goal/goal.ts` (add helper after `updateStatus` ~1324; replace 20 pairs — edit HIGHEST line number first so earlier anchors stay valid)
- Test: existing `src/goal/__tests__/goal.test.ts` is the contract (behavior-preserving; no new test).

**Interfaces:**
- Produces: `function setAndPersistGoal(goal: ActiveGoal, ctx: StatusContext): void` (module-private), body:
```ts
function setAndPersistGoal(goal: ActiveGoal, ctx: StatusContext): void {
	persistGoal(goalState.extensionApi as ExtensionAPI, goal);
	updateStatus(ctx, goal);
}
```
(`persistGoal` is imported; `updateStatus` is module-private; `ActiveGoal`/`StatusContext` are in scope. Place it immediately after the `updateStatus` definition.)

- [ ] **Step 1: Add the helper.**
Read the `updateStatus` definition (~1324) to confirm signature + placement, then add `setAndPersistGoal` right after it (function declarations hoist, so all earlier call sites resolve).

- [ ] **Step 2: Replace the 20 clean PAIR sites (edit highest-line first).**
Each clean pair is exactly:
```ts
	persistGoal(<API>, <G>);
	updateStatus(ctx, <G>);
```
→
```ts
	setAndPersistGoal(<G>, ctx);
```
where `<API>` is `goalState.extensionApi as ExtensionAPI` (or its alias `api` in the `/list` handler). The 20 sites, with their `<G>` expression:

| # | ~Lines | `<G>` | Notes |
|---|--------|-------|-------|
| 1 | 215-217 | `completedGoal` | |
| 2 | 233-235 | `completedGoal` | |
| 3 | 281-283 | `goalState.activeGoal` | |
| 4 | 311-313 | `goalState.activeGoal` | |
| 5 | 347-348 | `goalState.activeGoal` | |
| 6 | 448-449 | `goalState.activeGoal` | |
| 7 | 589-590 | `active` | uses `api` alias |
| 8 | 635-636 | `goalState.activeGoal` | uses `api` alias |
| 9 | 709-711 | `goalState.activeGoal` | keep the preceding `updateGoalUsage`+`cancelContinuationPending` lines (707-708); replace only the persist+status pair |
| 10 | 723-725 | `goalState.activeGoal` | keep preceding `updateGoalUsage` |
| 11 | 834-836 | `goalState.activeGoal` | keep preceding `cancelContinuationPending` |
| 12 | 849-850 | `goalState.activeGoal` | keep preceding `transitionGoal` reassignment |
| 13 | 855-856 | `goalState.activeGoal` | |
| 14 | 986-988 | `goalState.activeGoal` | keep preceding `createGoal` reassignment |
| 15 | 1004-1006 | `goalState.activeGoal` | keep preceding spread-mutate |
| 16 | 1022-1024 | `goalState.activeGoal` | keep preceding `transitionGoal` |
| 17 | 1040-1042 | `goalState.activeGoal` | |
| 18 | 1097-1099 | `goalState.activeGoal` | keep preceding `updateGoalUsage`+`normalizeGoalForBudget` |
| 19 | 1113-1115 | `goalState.activeGoal` | keep preceding `updateGoalUsage` |
| 20 | 1142-1143 | `goalState.activeGoal` | keep preceding `transitionGoal` |

**DO NOT touch** these (folding them would change behavior):
- Persist-only (no `updateStatus`): ~269-270, ~306-308, ~330-332, ~409, ~695.
- Conditional (`if (active) persistGoal(...); updateStatus(...)` — the status runs unconditionally): ~655-656, ~664-665.
- Status-only (no `persistGoal`): ~690.

For each site, READ the current lines first to confirm it is a clean pair matching the pattern above (same `<G>` on both lines, no intervening code between the persist and status lines), then replace. If a site does not match (intervening code, different `<G>` on the two lines, etc.), leave it inline and note it in your report — do not force it.

- [ ] **Step 3: Full gate.**
Run: `( cd bun-apps/pi-agent-ext-core-task && bun run typecheck && bun test )`
Expected: typecheck clean; all tests pass. The helper emits the identical `appendEntry("goal-state", …)` + overlay poke as the inlined pairs did → `goal.test.ts` (which asserts on those observable effects) stays green.

- [ ] **Step 4: Commit.**
```bash
git add bun-apps/pi-agent-ext-core-task/src/goal/goal.ts
git commit -m "refactor(core-task): extract setAndPersistGoal helper (20 persist+status pairs)"
```

---

## Self-Review (run after writing, before execution)
- **Spec coverage:** Phase-1 reduced scope = knowledge-card (strip helper + const consolidation) + core-task (setAndPersistGoal). All covered by Tasks 1-3. Dropped items documented above. ✓
- **Placeholder scan:** every step has concrete code / commands. No "TBD". ✓
- **Type consistency:** `setAndPersistGoal(goal: ActiveGoal, ctx: StatusContext)` matches `updateStatus(ctx, _goal: ActiveGoal|undefined)` and `persistGoal(api, goal: ActiveGoal)`. `stripWikiLinkBrackets(content: string): string`. ✓
- **Risk gates:** knowledge-card has no `typecheck` script → use `bunx tsc --noEmit` directly. core-task uses `bun run typecheck`. Each task commits only after its gate is green. ✓
