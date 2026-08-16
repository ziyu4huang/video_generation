# Spec — Loop 2 `/list` queue (core-task)

Effort: `2026-07-25-core-task-list-loop-the-continue-develop-frontie`. All 6 wayfinder tickets (00–05) closed; this spec consolidates their decisions. Built on the post-auditor clean base (PR #818 merged, main `17facfae`): the hardened single-goal machine (#814) + opt-in auditor (#818).

Date: 2026-07-25. Conversation language zh-TW; written artifacts English.

## 1. Goal

Add **Loop 2** — a `/list` goal queue — to `pi-agent-ext-task`. Multiple objectives queue in a **tail**; the active goal is the **head**. Completing the head auto-promotes the next tail item; a stuck/paused head can be manually advanced (`/list next`, lossless park). Reuses the existing state machine + session-store + inline audit with **no new status states** — a queued item is not a goal yet (it has no status; it becomes `active` via `createGoal` on promotion).

A bare `/goal "<obj>"` is just `head + tail=[]` — **UX byte-identical to today** (zero regression, the lightweight-cockpit promise).

## 2. Non-goals (out of scope)

- **Loop 3** (`/loop` metric-driven forever). Fog (map *Not yet specified*); graduates after Loop 2 lands.
- **Drafting** (`/list add` with no objective → clarify→draft). Fog.
- **`/list reorder`** + **agent-drafted `/list plan`** (`propose_task_list`). Deferred follow-up.
- **Mandatory queue / changing the default `/goal` contract.** Bare `/goal` stays tail-less.
- **A second persistence path.** The tail rides the existing `goal-state` session-store entry.

## 3. Decisions (locked — wayfinder tickets 00–05)

- **D1 — scope (t00):** Loop 2 only. Loop 3 + drafting are fog; standing-architecture is a separate map.
- **D2 — storage (t01):** session-store via `GoalStateEntryData { goal, list? }` + `GoalRuntimeState.list`. One entry holds head + tail. **No new status states.**
- **D3 — advance (t02):** hybrid, single behavior (no opt-out knob). Clean complete → auto-promote next; pause/failure → freeze. Creating the list is the opt-in.
  - *Clean* = (i) no audit + `goal_complete`, OR (ii) audit `approved`, OR (iii) audit `impossible` → complete-with-note (T04 D3).
  - *Freeze* triggers: `/goal pause`, audit 3× disapprove (T04 escalation), any `paused`/`budget_limited` transition. The queue does NOT auto-advance; user runs `/list next`.
- **D4 — commands (t03):** superset (`activeGoal`=head, `list`=tail). Minimal 5-command surface: `/list`, `/list add "<obj>"…`, `/list next`, `/list remove <n>`, `/list clear`. `/list next` = **lossless park-at-tail** (never drop).
- **D5 — audit (t04):** per-item. Each `GoalListItem` carries `audit?: GoalAuditOptions`; plumbed into `createGoal` on promotion. Audit mechanism unchanged (T04 #818, inline in `goal_complete`). D3 rules govern advance/freeze.
- **D6 — widget (t05):** dim suffix `· ☰ position/total` (+ `· ⚠N parked`); shown **only when `total ≥ 2`**. Bare `/goal` byte-identical. Narrow terminals drop the queue segment before truncating the status head.

### 3.1 Park semantics (refines D4)

`/list next` parks the current head: `activeGoal → GoalListItem` (text + `tokenBudget` + `audit` preserved; **usage/iteration reset** — a parked goal re-activates fresh via `createGoal`), appended to the tail; then the next tail item promotes to head. To actually discard an item, `/list remove <n>`.

## 4. Architecture

```
src/goal/
  format.ts       EDIT  GoalListItem type + relocate GoalAuditOptions here (pure);
                        formatGoalOverlayLine += optional queue? param (D6).
  state.ts        EDIT  GoalStateEntryData.list?; GoalRuntimeState.list; __resetGoalState
                        clears it. createGoal UNCHANGED (items aren't goals yet).
  list.ts         NEW   pure queue ops: addListItems / removeListItem / promoteNext /
                        goalToListItem (park) / clearList. Zero pi imports (mirror shield.ts).
  persistence.ts  EDIT  persistGoalState(api, goal, list); loadGoalStateFromSession →
                        { goal?, list? } (one entry, head + tail).
  commands.ts     EDIT  parseListCommand for /list, /list add, /list next,
                        /list remove <n>, /list clear.
  goal.ts         EDIT  startGoal list creation; /list command handlers; goal_complete
                        auto-advance + freeze; per-item audit on promote; widget queue slice.
  overlay.ts      EDIT  render() passes the queue slice to formatGoalOverlayLine.
```

`list.ts` is the only new module — pure, pi-import-free, unit-testable in isolation (same invariant as `shield.ts` / `state.ts` / `format.ts`). Everything else edits existing modules.

## 5. Data model

`GoalAuditOptions` **relocates** from `state.ts` to `format.ts` (it is a pure data shape; `GoalListItem` needs to reference it, and `format.ts` cannot import `state.ts` without a cycle). `state.ts` imports it type-only (it already imports `ActiveGoal`/`GoalStatus` from `format.ts`).

```ts
// format.ts
export interface GoalAuditOptions {           // relocated from state.ts
  auditEnabled?: boolean;
  auditorModel?: string;
  verificationContract?: string;
}

export interface GoalListItem {                // NEW — a goal-to-be (tail item)
  id: string;                                  // stable (for /list remove + tracking)
  text: string;                                // the objective
  tokenBudget?: number;
  audit?: GoalAuditOptions;                    // per-item (D5)
}
```

```ts
// state.ts
export interface GoalStateEntryData {
  goal?: ActiveGoal | null;
  list?: GoalListItem[];                        // NEW (D2) — the tail
}

export interface GoalRuntimeState {
  // …existing fields…
  list: GoalListItem[];                         // NEW (D2)
}
```

`createGoal` is **unchanged** — a `GoalListItem` becomes a goal only on promotion: `createGoal(item.text, item.tokenBudget, baselineTokens, item.audit)`.

## 6. Queue operations (`list.ts`, pure)

```ts
export function addListItems(list: GoalListItem[], texts: string[]): GoalListItem[];
export function removeListItem(list: GoalListItem[], index: number): GoalListItem[];   // 1-based index
export function promoteNext(list: GoalListItem[]): { item?: GoalListItem; rest: GoalListItem[] };  // pop head of tail
export function goalToListItem(goal: ActiveGoal): GoalListItem;          // park (D4.1): text+budget+audit, fresh id
export function clearList(): GoalListItem[];                             // → []
```

- `addListItems`: each text → `{ id: randomUUID(), text, tokenBudget: undefined, audit: undefined }`.
- `goalToListItem` (park): `{ id: randomUUID(), text: goal.text, tokenBudget: goal.tokenBudget, audit: auditOptsFromGoal(goal) }` — usage/iteration deliberately dropped (re-activation is fresh).
- `removeListItem`: 1-based index matching `/list`'s display; out-of-range → no-op (returns list unchanged).

## 7. Persistence (`persistence.ts`)

```ts
export function persistGoalState(api, goal: ActiveGoal | null, list: GoalListItem[]): void;
//   → appendEntry(GOAL_STATE_ENTRY_TYPE, { goal: goal ? cloneGoal(goal) : null, list: structuredClone(list) })

export function loadGoalStateFromSession(sm): { goal?: ActiveGoal; list?: GoalListItem[] };
//   rehydrates the most recent goal-state entry's goal (if non-complete) AND its list
```

`persistGoal` (old name) is replaced by `persistGoalState`; the one caller (`goal.ts`) + the recovery path (`session_start`) are updated. Recovery restores head + tail together.

## 8. Wiring (`goal.ts`)

- **startGoal**: when `/list add` runs with no active goal, the first item becomes the head (`createGoal`); the rest fill the tail. With an active goal, `/list add` only appends to the tail.
- **goal_complete** (extends the existing audit hook from #818): after a clean complete (approved / no-audit / impossible→note), if `goalState.list.length > 0`, `promoteNext` → `createGoal(item.text, item.tokenBudget, baselineTokens, item.audit)` → new `activeGoal`; persist head + tail. If the list is empty, the goal completes as today. On freeze (pause/3×/budget), the queue stays put (no auto-advance).
- **`/list next`** (manual): `goalToListItem(activeGoal)` → append to tail; `promoteNext` → new head; persist. (Only meaningful on a non-complete head; on a complete head it is a no-op / notify.)
- **`/list` / `/list remove <n>` / `/list clear`**: pure ops on `goalState.list`, then persist + widget refresh.
- **Per-item audit (D5):** promotion calls `createGoal` with the item's `audit` options → the auditor runs on that goal's `goal_complete` exactly as T04 (#818) ships. No new audit code.

## 9. UX (`commands.ts`)

`parseListCommand(input): ListCommandResult` (parallel to `parseCommand`):

| Input | Result |
|---|---|
| `/list` | `{ kind: "show" }` |
| `/list add "a" "b" …` | `{ kind: "add", texts: ["a","b",…] }` (1+, multi-arg) |
| `/list next` | `{ kind: "next" }` |
| `/list remove 2` | `{ kind: "remove", index: 2 }` (1-based) |
| `/list clear` | `{ kind: "clear" }` |

The `/list` command is registered alongside `/goal`; `goal.ts` dispatches to `parseListCommand` when the input starts with `list`.

## 10. Visibility (widget, D6)

```ts
formatGoalOverlayLine(goal, theme, width, queue?: { position: number; total: number; parked?: number }): string
```

- `queue` absent OR `total < 2` → today's exact line (zero regression).
- Else append a dim suffix ` · ☰ position/total` (+ ` · ⚠N parked` when `parked > 0`).
- Narrow terminal: drop the queue segment before truncating the status head.
- `position` = 1-based index of the head within the full list (head + tail); `total` = head(1) + tail.length; `parked` = count of tail items whose source was a parked goal (tracked via a marker on `GoalListItem` — see plan Task 1).

Full indexed list renders in the `/list` command output (show), not the widget.

## 11. Testing

- **`list.ts`** — pure unit tests: add (single/multi), remove (valid/out-of-range), promoteNext (empty/non-empty), goalToListItem (park preserves text+budget+audit, drops usage), clearList.
- **`persistence.ts`** — round-trip: persist head + tail, recover both; null goal + non-empty tail; complete goal excluded, tail still recovered.
- **`commands.ts`** — `parseListCommand` for all 5 kinds + arg shapes.
- **`goal.ts` wiring** — integration (mirror `hardening-loop.test.ts` harness): `/list add` fills tail; clean complete auto-promotes next; pause freezes (no advance); `/list next` parks + promotes; `/list remove`/`clear`; per-item audit options plumbed on promotion; **bare `/goal` path unchanged** (regression guard).
- **widget** — `formatGoalOverlayLine`: no queue / `total<2` → byte-identical; `total≥2` → suffix present; parked marker; narrow-width drop.

## 12. Rollout

- Default off in effect: a bare `/goal` and a 1-item list render + behave identically to today. The queue only manifests when ≥2 items exist.
- No new status states → all hardening paths (#814) still guard on `activeGoal.status === "active"`.
- No new audit behavior → the auditor (#818) runs per-promoted-goal as shipped.

## 13. Follow-ups (deferred, not in this spec)

- **Loop 3** (`/loop` metric-driven forever) — graduates from fog after Loop 2 lands.
- **Drafting** (`/list add` no-arg → clarify→draft).
- **`/list reorder`** + **agent-drafted `/list plan`** (`propose_task_list` with anti-drift caps + Confirm).
- **Park usage preservation** — currently park resets usage/iteration; a future option could preserve run-state for parked goals.
