# Loop 2 `/list` Queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/list` goal queue (Loop 2) to `pi-agent-ext-task` — `activeGoal`=head, `list`=tail; clean complete auto-promotes the next tail item; `/list next` losslessly parks the head at the tail + promotes; minimal 5-command surface; queue renders as a dim widget suffix only when ≥2 items exist.

**Architecture:** One new pure module `src/goal/list.ts` (queue ops, pi-import-free, mirroring `shield.ts`); edits to `format.ts` (types + widget), `state.ts` (runtime list field), `persistence.ts` (head+tail in one session-store entry), `commands.ts` (`parseListCommand`), `goal.ts` (handlers + auto-advance), `overlay.ts` (queue slice). **No new status states** — a queued item becomes `active` via the existing `createGoal` on promotion. Bare `/goal` is byte-identical to today.

**Tech Stack:** TypeScript (Bun runtime), `@earendil-works/pi-coding-agent` 0.82.0, `@earendil-works/pi-tui` (`truncateToWidth`/`visibleWidth`), TypeBox, `bun test`.

**Spec:** `bun-apps/pi-agent-ext-task/docs/2026-07-25-list-loop-spec.md`

## Global Constraints

- **Zero default regression.** A bare `/goal "<obj>"` and a 1-item list render + behave identically to today. The queue manifests only when ≥2 items exist. `formatGoalOverlayLine` with `queue` absent or `total < 2` returns today's exact line.
- **No new status states.** Machine stays `active / paused / budget_limited / complete`. A `GoalListItem` is not a goal (no status); `createGoal` makes it one on promotion.
- **`list.ts` / `format.ts` / `state.ts` / `shield.ts` stay pi-import-free** (the Phase-1 invariant). Only `persistence.ts` (already does), `commands.ts`, `goal.ts`, `overlay.ts` touch pi types.
- **Audit unchanged.** Per-item audit is just `createGoal(text, budget, baseline, item.audit)` on promotion — the auditor (#818) runs as shipped. No new audit code.
- **Conversation zh-TW; written artifacts English.** Gate: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`. Run from repo root.
- **Branch:** `core-task/list-loop` (base = `origin/main` head `17facfae`, the post-#818 clean base).

## File Structure

```
src/goal/
  format.ts       EDIT  relocate GoalAuditOptions here; + GoalListItem type;
                        formatGoalOverlayLine += queue? param (Task 7).
  state.ts        EDIT  GoalStateEntryData.list?; GoalRuntimeState.list + headAdvances;
                        __resetGoalState clears both; import GoalAuditOptions type-only.
  list.ts         NEW   pure: addListItems / removeListItem / promoteNext /
                        goalToListItem / clearList. Zero pi imports.
  persistence.ts  EDIT  + persistGoalState(api,goal,list) + loadGoalStateFromSession
                        (coexist with old fns until Task 5 migrates + removes them).
  commands.ts     EDIT  + parseListCommand + ListCommandResult (5 kinds).
  goal.ts         EDIT  /list dispatch + handlers (Task 5); goal_complete auto-advance
                        + per-item audit promote (Task 6); widget queue slice (Task 7).
  overlay.ts      EDIT  render() passes queue slice to formatGoalOverlayLine (Task 7).
```

---

## Task 1: Data model — `GoalListItem` + runtime `list` field

**Files:**
- Modify: `bun-apps/pi-agent-ext-task/src/goal/format.ts`
- Modify: `bun-apps/pi-agent-ext-task/src/goal/state.ts`
- Test: `bun-apps/pi-agent-ext-task/src/goal/__tests__/state.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GoalAuditOptions` (relocated to format.ts), `GoalListItem` (format.ts), `GoalStateEntryData.list?`, `GoalRuntimeState.list` + `.headAdvances`.

- [ ] **Step 1: Write the failing tests** (append to `state.test.ts`):

```ts
import { goalState, __resetGoalState } from "../state.js";
import type { GoalListItem } from "../format.js";

describe("GoalRuntimeState list fields", () => {
	test("list + headAdvances reset to initial by __resetGoalState", () => {
		goalState.list = [{ id: "x", text: "do thing" }];
		goalState.headAdvances = 7;
		__resetGoalState();
		expect(goalState.list).toEqual([]);
		expect(goalState.headAdvances).toBe(0);
	});
});

describe("GoalListItem shape", () => {
	test("a minimal item has id + text; optional fields default undefined", () => {
		const item: GoalListItem = { id: "a", text: "ship feature X" };
		expect(item.tokenBudget).toBeUndefined();
		expect(item.audit).toBeUndefined();
		expect(item.parked).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/state.test.ts -t "list fields" )`
Expected: FAIL (`goalState.list` / `headAdvances` do not exist; `GoalListItem` not exported).

- [ ] **Step 3: Relocate `GoalAuditOptions` to `format.ts` + add `GoalListItem`.** In `format.ts`, add (and remove the `GoalAuditOptions` definition from `state.ts`):

```ts
// format.ts — relocated from state.ts (pure data shape; GoalListItem needs it,
// and format.ts cannot import state.ts without a cycle).
export interface GoalAuditOptions {
	auditEnabled?: boolean;
	auditorModel?: string;
	verificationContract?: string;
}

/** A goal-to-be — a tail item. Not a goal yet: no status, no usage. Becomes an
 *  ActiveGoal via createGoal(item.text, item.tokenBudget, baseline, item.audit). */
export interface GoalListItem {
	id: string;
	text: string;
	tokenBudget?: number;
	audit?: GoalAuditOptions;
	parked?: boolean;             // true if parked from a paused activeGoal via /list next
}
```

- [ ] **Step 4: Extend `state.ts`.** Add `list?` to `GoalStateEntryData`, `list` + `headAdvances` to `GoalRuntimeState`, initialize both on the `goalState` singleton, clear both in `__resetGoalState`, and import `GoalAuditOptions` type-only from `./format.js`:

```ts
// state.ts — top imports (add GoalAuditOptions to the existing format.js import):
import { cloneGoal, isGoal, type ActiveGoal, type GoalAuditOptions, type GoalListItem, type GoalStateEntryData } from "./format.js";
// (GoalListItem + GoalAuditOptions are exported from format.ts as of Step 3.)

export interface GoalStateEntryData {
	goal?: ActiveGoal | null;
	list?: GoalListItem[];        // NEW (D2) — the tail
}

// remove the old GoalAuditOptions interface block from state.ts (it relocated).

export interface GoalRuntimeState {
	// …all existing fields unchanged…
	list: GoalListItem[];          // NEW (D2)
	headAdvances: number;          // NEW — heads activated so far (widget position)
}

export const goalState: GoalRuntimeState = {
	// …existing initializers…
	list: [],
	headAdvances: 0,
};

export function __resetGoalState(): void {
	// …existing resets…
	goalState.list = [];
	goalState.headAdvances = 0;
}
```

Then grep for any other importer of `GoalAuditOptions` from `state.js` and switch it to `format.js`:

```bash
grep -rn "GoalAuditOptions" bun-apps/pi-agent-ext-task/src
```
(Switch every `from "./state.js"` / `"../state.js"` import of `GoalAuditOptions` to the equivalent `format.js` path. `createGoal`'s signature is unchanged — it still takes `audit?: GoalAuditOptions`, now imported type-only.)

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/state.test.ts )`
Expected: PASS (new list-fields tests + all existing state tests; createGoal audit-options tests still green).

- [ ] **Step 6: Run full gate + commit**

Run: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`
Expected: full suite green; typecheck clean.

```bash
git add bun-apps/pi-agent-ext-task/src/goal/format.ts bun-apps/pi-agent-ext-task/src/goal/state.ts bun-apps/pi-agent-ext-task/src/goal/__tests__/state.test.ts
git commit -m "feat(core-task/goal): add GoalListItem + runtime list/headAdvances fields"
```

---

## Task 2: `list.ts` — pure queue operations

**Files:**
- Create: `bun-apps/pi-agent-ext-task/src/goal/list.ts`
- Test: `bun-apps/pi-agent-ext-task/src/goal/__tests__/list.test.ts`

**Interfaces:**
- Consumes: `ActiveGoal`, `GoalListItem`, `GoalAuditOptions` from `./format.js`.
- Produces: `addListItems`, `removeListItem`, `promoteNext`, `goalToListItem`, `clearList`.

- [ ] **Step 1: Write the failing tests** (`__tests__/list.test.ts`):

```ts
import { describe, expect, test } from "bun:test";
import { addListItems, removeListItem, promoteNext, goalToListItem, clearList } from "../list.js";
import type { ActiveGoal } from "../format.js";

describe("addListItems", () => {
	test("adds one item per text with fresh ids", () => {
		const list = addListItems([], ["a", "b"]);
		expect(list).toHaveLength(2);
		expect(list[0].text).toBe("a");
		expect(list[1].text).toBe("b");
		expect(list[0].id).not.toBe(list[1].id);
		expect(list[0].parked).toBeFalsy();
	});
	test("preserves existing tail (append)", () => {
		const list = addListItems([{ id: "x", text: "old" }], ["new"]);
		expect(list.map((i) => i.text)).toEqual(["old", "new"]);
	});
});

describe("removeListItem", () => {
	test("removes by 1-based index", () => {
		const list = [{ id: "1", text: "a" }, { id: "2", text: "b" }, { id: "3", text: "c" }];
		expect(removeListItem(list, 2).map((i) => i.text)).toEqual(["a", "c"]);
	});
	test("out-of-range index is a no-op", () => {
		const list = [{ id: "1", text: "a" }];
		expect(removeListItem(list, 5)).toEqual(list);
		expect(removeListItem(list, 0)).toEqual(list);
	});
});

describe("promoteNext", () => {
	test("pops the head of the tail, returns the rest", () => {
		const list = [{ id: "1", text: "a" }, { id: "2", text: "b" }];
		const r = promoteNext(list);
		expect(r.item?.text).toBe("a");
		expect(r.rest.map((i) => i.text)).toEqual(["b"]);
	});
	test("empty tail → item undefined, rest empty", () => {
		const r = promoteNext([]);
		expect(r.item).toBeUndefined();
		expect(r.rest).toEqual([]);
	});
});

describe("goalToListItem (park)", () => {
	test("preserves text + tokenBudget + audit; drops usage; fresh id; parked=true", () => {
		const goal: ActiveGoal = {
			id: "g1", text: "ship X", status: "active", startedAt: 0, updatedAt: 0,
			iteration: 5, tokensUsed: 999, timeUsedSeconds: 600, baselineTokens: 10,
			tokenBudget: 2000, auditEnabled: true, auditorModel: "anthropic/claude-sonnet-4",
			verificationContract: "tests green",
		};
		const item = goalToListItem(goal);
		expect(item.text).toBe("ship X");
		expect(item.tokenBudget).toBe(2000);
		expect(item.audit).toEqual({ auditEnabled: true, auditorModel: "anthropic/claude-sonnet-4", verificationContract: "tests green" });
		expect(item.parked).toBe(true);
		expect(item.id).not.toBe("g1");            // fresh id
	});
});

describe("clearList", () => {
	test("returns an empty array", () => {
		expect(clearList()).toEqual([]);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/list.test.ts )`
Expected: FAIL (module `../list.js` not found).

- [ ] **Step 3: Create `list.ts`** — pure, pi-import-free (only `crypto` for ids + the local `./format.js`):

```ts
/**
 * Pure queue operations for the /list tail. Zero pi imports (mirror shield.ts) —
 * unit-testable under plain node. All functions are non-mutating: they return
 * NEW arrays; callers assign back to goalState.list.
 */

import { randomUUID } from "crypto";
import type { ActiveGoal, GoalAuditOptions, GoalListItem } from "./format.js";

/** Append one fresh item per objective text to the tail. */
export function addListItems(list: GoalListItem[], texts: string[]): GoalListItem[] {
	const added: GoalListItem[] = texts
		.map((t) => t.trim())
		.filter((t) => t.length > 0)
		.map((t) => ({ id: randomUUID(), text: t }));
	return [...list, ...added];
}

/** Remove by 1-based index (matches /list display). Out-of-range → no-op. */
export function removeListItem(list: GoalListItem[], index: number): GoalListItem[] {
	if (!Number.isInteger(index) || index < 1 || index > list.length) return list;
	return list.filter((_, i) => i !== index - 1);
}

/** Pop the head of the tail. Empty tail → item undefined. */
export function promoteNext(list: GoalListItem[]): { item?: GoalListItem; rest: GoalListItem[] } {
	if (list.length === 0) return { item: undefined, rest: [] };
	const [item, ...rest] = list;
	return { item, rest };
}

/** Park an activeGoal at the tail: text + tokenBudget + audit preserved, usage
 *  dropped, fresh id, parked=true. Re-activation starts fresh via createGoal. */
export function goalToListItem(goal: ActiveGoal): GoalListItem {
	const audit: GoalAuditOptions | undefined = goal.auditEnabled
		? { auditEnabled: true, auditorModel: goal.auditorModel, verificationContract: goal.verificationContract }
		: undefined;
	return {
		id: randomUUID(),
		text: goal.text,
		tokenBudget: goal.tokenBudget,
		audit,
		parked: true,
	};
}

/** Wipe the tail. */
export function clearList(): GoalListItem[] {
	return [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/list.test.ts )`
Expected: PASS (all queue-op tests green).

- [ ] **Step 5: Run full gate + commit**

Run: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`
Expected: full suite green; typecheck clean (`list.ts` is pure + not yet imported).

```bash
git add bun-apps/pi-agent-ext-task/src/goal/list.ts bun-apps/pi-agent-ext-task/src/goal/__tests__/list.test.ts
git commit -m "feat(core-task/goal): add pure /list queue operations (add/remove/promote/park/clear)"
```

---

## Task 3: Persistence — head + tail in one session-store entry

**Files:**
- Modify: `bun-apps/pi-agent-ext-task/src/goal/persistence.ts`
- Test: `bun-apps/pi-agent-ext-task/src/goal/__tests__/persistence.test.ts` (extend existing)

**Interfaces:**
- Consumes: `ActiveGoal`, `GoalListItem` from `./format.js`; `cloneGoal` from `./state.js`.
- Produces: `persistGoalState(api, goal, list)`, `loadGoalStateFromSession(sm): { goal?, list? }`. (Old `persistGoal` / `loadGoalFromSession` remain untouched for now — Task 5 migrates callers + removes them.)

- [ ] **Step 1: Write the failing tests** (append to `persistence.test.ts`):

```ts
import { persistGoalState, loadGoalStateFromSession } from "../persistence.js";
import type { ActiveGoal, GoalListItem } from "../format.js";

function fakeSm(entries: any[]) {
	return { getBranch: () => entries, getEntries: () => entries };
}

describe("persistGoalState", () => {
	test("appends an entry carrying goal + list", () => {
		const logged: any[] = [];
		const api = { appendEntry: (t: string, d: unknown) => logged.push({ type: "custom", customType: t, data: d }) };
		const goal: ActiveGoal = { id: "g1", text: "head", status: "active", startedAt: 0, updatedAt: 0,
			iteration: 0, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: 0 };
		const list: GoalListItem[] = [{ id: "t1", text: "next" }];
		persistGoalState(api as any, goal, list);
		expect(logged).toHaveLength(1);
		expect(logged[0].data.goal.text).toBe("head");
		expect(logged[0].data.list).toEqual(list);
	});
	test("null goal still persists the list", () => {
		const logged: any[] = [];
		const api = { appendEntry: (_t: string, d: unknown) => logged.push({ data: d }) };
		persistGoalState(api as any, null, [{ id: "t1", text: "x" }]);
		expect(logged[0].data.goal).toBeNull();
		expect(logged[0].data.list).toHaveLength(1);
	});
});

describe("loadGoalStateFromSession", () => {
	test("recovers a non-complete goal + its list", () => {
		const goal: ActiveGoal = { id: "g1", text: "head", status: "active", startedAt: 0, updatedAt: 0,
			iteration: 0, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: 0 };
		const list: GoalListItem[] = [{ id: "t1", text: "next" }];
		const sm = fakeSm([{ type: "custom", customType: "goal-state", data: { goal, list } }]);
		const r = loadGoalStateFromSession(sm);
		expect(r.goal?.id).toBe("g1");
		expect(r.list).toEqual(list);
	});
	test("complete goal excluded, but list still recovered", () => {
		const goal: ActiveGoal = { id: "g1", text: "head", status: "complete", startedAt: 0, updatedAt: 0,
			iteration: 0, tokensUsed: 0, timeUsedSeconds: 0, baselineTokens: 0 };
		const sm = fakeSm([{ type: "custom", customType: "goal-state", data: { goal, list: [{ id: "t1", text: "next" }] } }]);
		const r = loadGoalStateFromSession(sm);
		expect(r.goal).toBeUndefined();
		expect(r.list?.[0].text).toBe("next");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/persistence.test.ts -t "persistGoalState|loadGoalStateFromSession" )`
Expected: FAIL (`persistGoalState` / `loadGoalStateFromSession` not exported).

- [ ] **Step 3: Add the new functions to `persistence.ts`** (keep the old `persistGoal` / `loadGoalFromSession` for now):

```ts
import type { GoalListItem } from "./format.js";

/** Persist head + tail in one session-store entry (D2). */
export function persistGoalState(
	api: GoalPersistenceApi | undefined,
	goal: ActiveGoal | null,
	list: GoalListItem[],
): void {
	api?.appendEntry(GOAL_STATE_ENTRY_TYPE, {
		goal: goal ? cloneGoal(goal) : null,
		list: list.map((item) => ({ ...item })),   // shallow clone each item
	});
}

/** Rehydrate the most recent non-complete goal AND its list from the session store. */
export function loadGoalStateFromSession(sessionManager: unknown): {
	goal?: ActiveGoal;
	list?: GoalListItem[];
} {
	const sm = sessionManager as
		| { getBranch?: () => Array<{ type?: string; customType?: string; data?: unknown }>; getEntries?: () => Array<{ type?: string; customType?: string; data?: unknown }> }
		| undefined;
	const entries = sm?.getBranch?.() ?? sm?.getEntries?.() ?? [];
	const entry = entries
		.filter((e) => e.type === "custom" && e.customType === GOAL_STATE_ENTRY_TYPE)
		.pop();
	const data = entry?.data as { goal?: ActiveGoal; list?: GoalListItem[] } | undefined;
	const goal = isGoal(data?.goal) && data!.goal!.status !== "complete" ? cloneGoal(data!.goal!) : undefined;
	return { goal, list: data?.list?.map((item) => ({ ...item })) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/persistence.test.ts )`
Expected: PASS (new + existing persistence tests).

- [ ] **Step 5: Run full gate + commit**

Run: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`
Expected: full suite green; typecheck clean.

```bash
git add bun-apps/pi-agent-ext-task/src/goal/persistence.ts bun-apps/pi-agent-ext-task/src/goal/__tests__/persistence.test.ts
git commit -m "feat(core-task/goal): persist head+tail in one session-store entry"
```

---

## Task 4: `commands.ts` — `parseListCommand` (5 kinds)

**Files:**
- Modify: `bun-apps/pi-agent-ext-task/src/goal/commands.ts`
- Test: `bun-apps/pi-agent-ext-task/src/goal/__tests__/commands.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ListCommandResult` + `parseListCommand(input)`.

- [ ] **Step 1: Write the failing tests** (append to `commands.test.ts`):

```ts
import { parseListCommand } from "../commands.js";

describe("parseListCommand", () => {
	test("bare /list → show", () => {
		expect(parseListCommand("list")).toEqual({ kind: "show" });
		expect(parseListCommand("list ")).toEqual({ kind: "show" });
	});
	test("/list add with one objective", () => {
		expect(parseListCommand('list add "ship feature X"')).toEqual({ kind: "add", texts: ["ship feature X"] });
	});
	test("/list add with multiple objectives", () => {
		expect(parseListCommand('list add "a" "b" "c"')).toEqual({ kind: "add", texts: ["a", "b", "c"] });
	});
	test("/list next", () => {
		expect(parseListCommand("list next")).toEqual({ kind: "next" });
	});
	test("/list remove <n>", () => {
		expect(parseListCommand("list remove 2")).toEqual({ kind: "remove", index: 2 });
	});
	test("/list clear", () => {
		expect(parseListCommand("list clear")).toEqual({ kind: "clear" });
	});
	test("non-list input → null (not a list command)", () => {
		expect(parseListCommand('goal "something"')).toBeNull();
		expect(parseListCommand("audit")).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/commands.test.ts -t "parseListCommand" )`
Expected: FAIL (`parseListCommand` not exported).

- [ ] **Step 3: Add `parseListCommand` to `commands.ts`** — a quoted-arg tokenizer (reuse the file's existing quote-aware `tokenize` if present; otherwise a minimal one). It returns `null` for any input that is not a `list …` command:

```ts
export type ListCommandResult =
	| { kind: "show" }
	| { kind: "add"; texts: string[] }
	| { kind: "next" }
	| { kind: "remove"; index: number }
	| { kind: "clear" };

/** Parse a `/list …` command. Returns null if input is not a list command. */
export function parseListCommand(input: string): ListCommandResult | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("list")) return null;
	const rest = trimmed.slice(4).trim();          // after "list"
	if (rest === "") return { kind: "show" };
	const sub = rest.split(/\s+/)[0]?.toLowerCase();
	const argText = rest.slice(sub!.length).trim();
	if (sub === "add") {
		const texts = tokenizeQuoted(argText).filter((t) => t.length > 0);
		return { kind: "add", texts };
	}
	if (sub === "next") return { kind: "next" };
	if (sub === "clear") return { kind: "clear" };
	if (sub === "remove") {
		const index = Number.parseInt(argText, 10);
		return { kind: "remove", index: Number.isFinite(index) ? index : -1 };
	}
	// Unknown /list subcommand → treat as show (forgiving).
	return { kind: "show" };
}

/** Minimal quote-aware tokenizer for /list add args. Reuse the file's existing
 *  tokenizer if one exists; otherwise this standalone impl. */
function tokenizeQuoted(s: string): string[] {
	const out: string[] = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
	return out;
}
```

> **Note:** if `commands.ts` already exports a quote-aware `tokenize`, call it instead of the local `tokenizeQuoted` (DRY). The intent — split `/list add` args respecting quotes — is what matters.

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/commands.test.ts )`
Expected: PASS (new parseListCommand tests + existing command tests).

- [ ] **Step 5: Run full gate + commit**

Run: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`
Expected: full suite green; typecheck clean.

```bash
git add bun-apps/pi-agent-ext-task/src/goal/commands.ts bun-apps/pi-agent-ext-task/src/goal/__tests__/commands.test.ts
git commit -m "feat(core-task/goal): parse /list commands (show/add/next/remove/clear)"
```

---

## Task 5: `goal.ts` — `/list` handlers + startGoal list + migrate persistence

**Files:**
- Modify: `bun-apps/pi-agent-ext-task/src/goal/goal.ts`
- Test: `bun-apps/pi-agent-ext-task/src/goal/__tests__/list-wiring.test.ts` (new)

**Interfaces:**
- Consumes: `addListItems`/`removeListItem`/`promoteNext`/`goalToListItem`/`clearList` (Task 2); `persistGoalState`/`loadGoalStateFromSession` (Task 3); `parseListCommand` (Task 4); `goalState.list`/`headAdvances` (Task 1).
- Produces: the `/list` command handler dispatch in goal.ts; `startGoal` list creation; persistence migration (old `persistGoal`/`loadGoalFromSession` removed once callers move over).

- [ ] **Step 1: Read the existing `/goal` command registration + `startGoal` + the `persistGoal`/`loadGoalFromSession` call sites** to see exactly where to hook in:

```bash
grep -n "registerCommand\|parseCommand\|startGoal\|persistGoal\b\|loadGoalFromSession\|sendUserMessage\|session_start" bun-apps/pi-agent-ext-task/src/goal/goal.ts
```

- [ ] **Step 2: Write the failing integration tests** (`__tests__/list-wiring.test.ts`) — mirror the fake-pi/ctx harness pattern from `hardening-loop.test.ts` + `goal.test.ts` (find + copy their `mock` helper; do NOT invent a new harness):

```ts
import { describe, expect, test } from "bun:test";
// Build the fake pi/ctx + sendUserMessage harness exactly as hardening-loop.test.ts does.

describe("/list wiring", () => {
	test("/list add with no active goal → first item becomes head, rest fill tail", async () => {
		// sendUserMessage('list add "a" "b" "c"')
		// assert goalState.activeGoal.text === "a" && goalState.list.map(i=>i.text) === ["b","c"]
	});
	test("/list add with an active goal → appends to tail only", async () => {
		// start a goal, then 'list add "x"', assert activeGoal unchanged + list === ["x"]
	});
	test("/list next → parks head (parked=true) + promotes next", async () => {
		// list add a,b,c (a=head, [b,c]); 'list next' → head=b, tail=[c, a(parked)]
	});
	test("/list remove <n> + /list clear", async () => {
		// list add a,b,c; 'list remove 2' → [a,c]; 'list clear' → []
	});
	test("/list (show) → notify lists head + indexed tail", async () => {
		// assert a notify/print contains the indexed items
	});
});
```

> **Note:** the harness details (how `mock` registers the `/list` command + drives it + asserts `goalState`) come from reading `goal.test.ts`'s `/goal` tests. Mirror them exactly.

- [ ] **Step 3: Register the `/list` command + dispatch.** In `goal.ts`'s extension setup (next to the existing `/goal` `registerCommand`), register `/list` and dispatch to `parseListCommand`. Implement each kind against `goalState.list` + `goalState.activeGoal`, then `persistGoalState(api, activeGoal, list)` + `updateStatus`:

```ts
import { parseListCommand } from "./commands.js";
import { addListItems, removeListItem, promoteNext, goalToListItem, clearList } from "./list.js";
import { persistGoalState, loadGoalStateFromSession } from "./persistence.js";
import { createGoal, transitionGoal } from "./state.js";

// Inside the extension, register a /list command (mirror the /goal registration):
pi.registerCommand?.("list", async (input: string, ctx) => {
	const cmd = parseListCommand(input);
	if (!cmd) return;
	const api = goalState.extensionApi as ExtensionAPI;
	const active = goalState.activeGoal;
	switch (cmd.kind) {
		case "show": {
			const lines = active
				? [`1. ${active.text}  (active)`]
				: ["(no active goal)"];
			for (const [i, item] of goalState.list.entries())
				lines.push(`${i + 2}. ${item.text}${item.parked ? "  ⚠parked" : ""}`);
			ctx.ui.print(lines.join("\n"));
			return;
		}
		case "add": {
			if (cmd.texts.length === 0) { ctx.ui.notify("Nothing to add.", "info"); return; }
			if (!active) {
				// First item becomes the head; the rest fill the tail.
				const [head, ...rest] = cmd.texts;
				goalState.activeGoal = createGoal(head, undefined /*tokenBudget*/, currentBaselineTokens());
				goalState.list = addListItems([], rest);
				goalState.headAdvances = 0;
			} else {
				goalState.list = addListItems(goalState.list, cmd.texts);
			}
			persistGoalState(api, goalState.activeGoal ?? null, goalState.list);
			ctx.ui.notify(`List: ${goalState.list.length + (goalState.activeGoal ? 1 : 0)} goal(s).`, "info");
			updateStatus(ctx, goalState.activeGoal);
			return;
		}
		case "next": {
			if (!active) { ctx.ui.notify("No active goal to advance from.", "info"); return; }
			if (active.status === "complete") { ctx.ui.notify("Active goal already complete.", "info"); return; }
			const { item, rest } = promoteNext([...goalState.list, goalToListItem(active)]);
			if (!item) { ctx.ui.notify("Queue empty — nothing to advance to.", "info"); return; }
			goalState.list = rest;
			goalState.activeGoal = createGoal(item.text, item.tokenBudget, currentBaselineTokens(), item.audit);
			goalState.headAdvances += 1;
			persistGoalState(api, goalState.activeGoal, goalState.list);
			ctx.ui.notify(`Advanced to: ${item.text}`, "info");
			updateStatus(ctx, goalState.activeGoal);
			return;
		}
		case "remove": {
			goalState.list = removeListItem(goalState.list, cmd.index);
			persistGoalState(api, goalState.activeGoal ?? null, goalState.list);
			ctx.ui.notify(`Removed item ${cmd.index}.`, "info");
			updateStatus(ctx, goalState.activeGoal);
			return;
		}
		case "clear": {
			goalState.list = clearList();
			persistGoalState(api, goalState.activeGoal ?? null, goalState.list);
			ctx.ui.notify("Queue cleared (active goal untouched).", "info");
			return;
		}
	}
});
```

Add a tiny helper to read the current baseline token count (mirror whatever `startGoal` already uses for `baselineTokens`):

```ts
function currentBaselineTokens(): number {
	// Reuse the same baselineTokens source startGoal uses (e.g. ctx token usage at goal start).
	return /* existing expression from startGoal */ 0;
}
```
(Fill the body by copying the exact `baselineTokens` expression `startGoal` passes to `createGoal` — find it via the grep in Step 1.)

- [ ] **Step 4: Migrate persistence callers + remove the old fns.** Replace every `persistGoal(api, goal)` call site in `goal.ts` with `persistGoalState(api, goal, goalState.list)`, and replace the `loadGoalFromSession(sm)` recovery call (in `session_start`) with `loadGoalStateFromSession(sm)` — restoring both `goalState.activeGoal = r.goal` and `goalState.list = r.list ?? []`. Then delete the old `persistGoal` + `loadGoalFromSession` from `persistence.ts` (and any leftover imports).

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/list-wiring.test.ts )`
Expected: PASS (all 5 wiring tests green).

- [ ] **Step 6: Run full gate + commit**

Run: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`
Expected: full suite green; typecheck clean. Bare `/goal` tests unaffected (no list ⇒ `goalState.list` stays `[]`, persistence round-trips an empty list).

```bash
git add bun-apps/pi-agent-ext-task/src/goal/goal.ts bun-apps/pi-agent-ext-task/src/goal/persistence.ts bun-apps/pi-agent-ext-task/src/goal/__tests__/list-wiring.test.ts
git commit -m "feat(core-task/goal): /list command handlers + startGoal list + migrate persistence"
```

---

## Task 6: `goal.ts` — `goal_complete` auto-advance + freeze + per-item audit promote

**Files:**
- Modify: `bun-apps/pi-agent-ext-task/src/goal/goal.ts`
- Test: `bun-apps/pi-agent-ext-task/src/goal/__tests__/list-advance.test.ts` (new)

**Interfaces:**
- Consumes: `promoteNext` (Task 2); `persistGoalState` (Task 3); `goalState.list`/`headAdvances` (Task 1); the existing audit hook (#818).
- Produces: the auto-advance-on-clean-complete branch in `goal_complete` execute.

- [ ] **Step 1: Write the failing integration tests** (`__tests__/list-advance.test.ts`) — mirror the `audit-wiring.test.ts` harness:

```ts
describe("goal_complete auto-advance", () => {
	test("clean complete with a non-empty tail → promotes next, head advances", async () => {
		// list add "a" "b" (a=head, [b]); drive goal_complete (no audit) →
		// assert goalState.activeGoal.text === "b" && goalState.list === [] && headAdvances === 1
	});
	test("clean complete with empty tail → completes as today (no active goal)", async () => {
		// start a bare goal (tail=[]); goal_complete → activeGoal undefined / status complete
	});
	test("paused goal does NOT auto-advance (freeze)", async () => {
		// list add a,b; /goal pause → goalState.list still ["b"], activeGoal paused
	});
	test("per-item audit options plumb on promotion", async () => {
		// list add --audit "a" "b" (or set audit on the item) → promote → goal_complete runs
		// the auditor on the promoted goal exactly as T04 (#818) — assert audit wiring unchanged
	});
});
```

> **Note:** the audit-options-on-items path depends on how Task 5 seeds `item.audit` — if `/list add` accepts `--audit` (optional extension to Task 4), seed it there; otherwise set `audit` on a `GoalListItem` directly in the test. The KEY assertion is that a promoted audited goal triggers the existing audit hook unchanged.

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/list-advance.test.ts )`
Expected: FAIL (no auto-advance; completing a head with a tail leaves no active goal).

- [ ] **Step 3: Add the auto-advance branch.** In `goalCompleteTool.execute`, in the **success path** — after the existing audit hook (when approved / no-audit / impossible-note) falls through to `transitionGoal(completedGoal, "complete")` — insert the advance BEFORE the goal is cleared from `goalState.activeGoal`. The completed goal is archived (transitioned to complete), then the next tail item promotes:

```ts
// (existing) transitionGoal(completedGoal, "complete") …
//   ↓ the completed goal is now "complete"; archive it, then try to advance the queue:
const api = goalState.extensionApi as ExtensionAPI;
const { item, rest } = promoteNext(goalState.list);
if (item) {
	goalState.activeGoal = createGoal(item.text, item.tokenBudget, currentBaselineTokens(), item.audit);
	goalState.list = rest;
	goalState.headAdvances += 1;
	persistGoalState(api, goalState.activeGoal, goalState.list);
	ctx.ui.notify(`Goal complete. Advanced to: ${item.text}`, "success");
	updateStatus(ctx, goalState.activeGoal);
	// Keep the turn going on the new goal — return terminate:false so the loop continues,
	// OR terminate:true if the convention is to let the user re-prompt. Mirror whatever the
	// existing clean-complete path returns; the queue advance is a state change, not a turn change.
} else {
	// Empty tail → complete as today: clear the active goal.
	goalState.activeGoal = undefined;
	goalState.list = [];
	goalState.headAdvances = 0;
	persistGoalState(api, null, []);
}
```

> **Note:** locate the exact success-path insertion point via `grep -n "transitionGoal.*complete\|goalState.activeGoal = undefined" goal.ts`. The freeze cases (pause / 3× audit / budget) already leave `goalState.activeGoal` in a non-complete state and never reach this branch — so the queue stays put with no extra code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/list-advance.test.ts )`
Expected: PASS (advance / no-tail / freeze / audit-plumb tests green).

- [ ] **Step 5: Run full gate + commit**

Run: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`
Expected: full suite green; typecheck clean. Bare `/goal` completion path unchanged when tail is empty.

```bash
git add bun-apps/pi-agent-ext-task/src/goal/goal.ts bun-apps/pi-agent-ext-task/src/goal/__tests__/list-advance.test.ts
git commit -m "feat(core-task/goal): auto-advance queue on clean complete (freeze on pause)"
```

---

## Task 7: Widget — dim `☰ position/total` suffix

**Files:**
- Modify: `bun-apps/pi-agent-ext-task/src/goal/format.ts`
- Modify: `bun-apps/pi-agent-ext-task/src/goal/overlay.ts`
- Modify: `bun-apps/pi-agent-ext-task/src/goal/goal.ts` (compute + pass the queue slice)
- Test: `bun-apps/pi-agent-ext-task/src/goal/__tests__/format.test.ts` (extend)

**Interfaces:**
- Consumes: `goalState.list` + `goalState.headAdvances` (Task 1); `formatGoalOverlayLine` (existing).
- Produces: `formatGoalOverlayLine(…, queue?: { position; total; parked? })`.

- [ ] **Step 1: Write the failing tests** (append to `format.test.ts`) using a plain (no-color) theme stub:

```ts
import { formatGoalOverlayLine } from "../format.js";
const theme = {
	fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s,
	bold: (s: string) => s, italic: (s: string) => s, underline: (s: string) => s,
	inverse: (s: string) => s, strikethrough: (s: string) => s,
} as any;
const goal = { id: "g", text: "refactor parser", status: "active", startedAt: 0, updatedAt: 0,
	iteration: 3, tokensUsed: 0, timeUsedSeconds: 83, baselineTokens: 0 } as any;

describe("formatGoalOverlayLine queue suffix", () => {
	test("no queue → byte-identical to today (no ☰ segment)", () => {
		const line = formatGoalOverlayLine(goal, theme, 100);
		expect(line).not.toContain("☰");
	});
	test("total < 2 → no ☰ segment", () => {
		const line = formatGoalOverlayLine(goal, theme, 100, { position: 1, total: 1 });
		expect(line).not.toContain("☰");
	});
	test("total >= 2 → shows ☰ position/total at the end", () => {
		const line = formatGoalOverlayLine(goal, theme, 100, { position: 2, total: 5 });
		expect(line).toContain("☰ 2/5");
	});
	test("parked > 0 → shows ⚠N parked", () => {
		const line = formatGoalOverlayLine(goal, theme, 100, { position: 2, total: 5, parked: 1 });
		expect(line).toContain("⚠1 parked");
	});
	test("narrow terminal → drops the ☰ segment before truncating the head", () => {
		const line = formatGoalOverlayLine(goal, theme, 30, { position: 2, total: 5 });
		expect(line).not.toContain("☰");        // head survived, queue dropped
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/format.test.ts -t "queue suffix" )`
Expected: FAIL (`formatGoalOverlayLine` does not accept a 4th param).

- [ ] **Step 3: Extend `formatGoalOverlayLine` in `format.ts`** with the optional `queue?` param. Render the suffix only when `queue && queue.total >= 2` AND there is room; otherwise drop it:

```ts
export interface GoalOverlayQueue {
	position: number;
	total: number;
	parked?: number;
}

export function formatGoalOverlayLine(
	goal: ActiveGoal,
	theme: Theme,
	width: number,
	queue?: GoalOverlayQueue,
): string {
	const color = goalStatusColor(goal.status);
	const icon = goal.status === "complete" ? "✓" : "🎯";
	const statusWord = formatStatus(goal) ?? goal.status;
	const metric = formatGoalMetric(goal);
	const sep = ` ${theme.fg("dim", "·")} `;

	const queueSegment =
		queue && queue.total >= 2
			? `${sep}${theme.fg("dim", `☰ ${queue.position}/${queue.total}`)}${
					queue.parked && queue.parked > 0 ? `${sep}${theme.fg("warning", `⚠${queue.parked} parked`)}` : ""
			  }`
			: "";

	// Build the head, then see if the objective + queue fit. On narrow terminals,
	// drop the objective first, then the queue — never the status head.
	const headParts = [
		`${theme.fg(color, icon)} ${theme.fg(color, statusWord)}`,
		...(metric ? [theme.fg("dim", metric)] : []),
		theme.fg("dim", `iter ${goal.iteration}`),
	];
	const head = headParts.join(sep);

	const gutter = 2;
	const remaining = width - visibleWidth(head) - gutter;

	// If even the head + queue won't leave room for >6 chars of objective, drop the queue.
	const queueWidth = visibleWidth(queueSegment);
	const showQueue = queueSegment && remaining - queueWidth > 6;

	if (remaining <= 6) return truncateToWidth(head, width, theme.fg("dim", "…"));
	const objective = truncateToWidth(goal.text, showQueue ? remaining - queueWidth : remaining, theme.fg("dim", "…"));
	const line = `${head}${" ".repeat(gutter)}${theme.fg("dim", objective)}`;
	return showQueue ? `${line}${queueSegment}` : line;
}
```

- [ ] **Step 4: Pass the queue slice from the overlay.** In `overlay.ts`, `GoalOverlay.render` computes the queue from its (new) `list`/`headAdvances` fields and passes it; `goal.ts`'s `updateStatus` sets them on the overlay when it sets the goal. Extend `GoalOverlayLike` + `GoalOverlay` with `list: GoalListItem[]` + `headAdvances: number` fields; in `render`:

```ts
render(theme, width) {
	if (this.completionFlash) return [formatGoalCompletionLine(this.completionFlash, theme, width)];
	if (!this.current) return [];
	const total = 1 + this.list.length;
	const queue = total >= 2
		? { position: this.headAdvances + 1, total, parked: this.list.filter((i) => i.parked).length }
		: undefined;
	return [formatGoalOverlayLine(this.current, theme, width, queue)];
}
```
And in `goal.ts`'s `updateStatus` (wherever it sets `goalOverlay.current = goal`), also set `goalOverlay.list = goalState.list` + `goalOverlay.headAdvances = goalState.headAdvances`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-task && bun test src/goal/__tests__/format.test.ts )`
Expected: PASS (queue-suffix tests + existing format tests; no-queue case byte-identical).

- [ ] **Step 6: Run full gate + commit**

Run: `( cd bun-apps/pi-agent-ext-task && bun test && bun run typecheck )`
Expected: full suite green; typecheck clean.

```bash
git add bun-apps/pi-agent-ext-task/src/goal/format.ts bun-apps/pi-agent-ext-task/src/goal/overlay.ts bun-apps/pi-agent-ext-task/src/goal/goal.ts bun-apps/pi-agent-ext-task/src/goal/__tests__/format.test.ts
git commit -m "feat(core-task/goal): widget dim ☰ position/total suffix (total>=2 only)"
```

---

## Self-Review (run before handoff)

1. **Spec coverage** — §3 D1 (Loop 2 scope) → whole plan ✓; D2 (session-store, no new states) → Task 1 + 3 ✓; D3 (hybrid advance, freeze) → Task 6 ✓ (auto-advance on clean complete; freeze = non-complete states never reach the advance branch); D4 (superset, 5 cmds, lossless park) → Task 4 (parse) + 5 (handlers, park via `goalToListItem`) ✓; D4.1 (park resets usage) → Task 2 `goalToListItem` ✓; D5 (per-item audit) → Task 6 promotion `createGoal(…, item.audit)` + Task 5 seeds `item.audit` ✓; D6 (widget suffix, total<2 hidden, narrow drop) → Task 7 ✓; §11 testing → each task ships tests ✓; §12 rollout (zero default regression) → Task 7 no-queue byte-identical + empty-tail completion unchanged (Task 6) ✓.
2. **Placeholder scan** — Tasks 5 + 6 reference existing harness/insertion points by grepping first (not placeholders — "read then match" like the auditor plan); `currentBaselineTokens()` is filled by copying the existing expression from `startGoal`. No TBD/TODO. All code steps show complete code.
3. **Type consistency** — `GoalListItem` defined once in `format.ts` (Task 1), consumed by `state.ts` (Task 1), `list.ts` (Task 2), `persistence.ts` (Task 3), `goal.ts` (Tasks 5–6), `overlay.ts` (Task 7); `GoalAuditOptions` relocated once (Task 1), all importers updated via grep; `persistGoalState` / `loadGoalStateFromSession` defined in Task 3, called in Tasks 5–6; `parseListCommand` `kind` union matches the switch in Task 5; `formatGoalOverlayLine`'s `GoalOverlayQueue` matches `overlay.ts`'s call.
4. **Risk note** — Task 6 is the subtlest (the `goal_complete` success-path insertion). The non-queue path is preserved when `promoteNext` returns no item (empty tail → clear as today). The freeze cases never reach the advance branch because they transition to `paused`/`budget_limited` or return early in the audit hook (#818) — verify via the "paused does not advance" test.
