## Question

Where does the `/list` queue live, and does it require new status-machine states? Confirm the adaptation point in core-task's persistence + state modules.

## type: research

## blocked by: —

## Resolution (fired in charting session)

**Source read:** `src/goal/persistence.ts` + `src/goal/state.ts` (on main `17facfae`); cross-checked against `../pi-goal-list-loop-audit/docs/DESIGN.md` Decision 7 + `extensions/loops/goal.ts`.

**Finding — the queue fits the existing session-store with a minimal extension; no architectural change:**

1. **Storage:** the session-store entry is `GoalStateEntryData { goal?: ActiveGoal | null }` (`state.ts`). Extend it to carry the queue: `{ goal?: ActiveGoal | null; list?: GoalListItem[] }`. `persistGoal(api, goal)` becomes `persistGoalState(api, goal, list)` — still one `appendEntry(GOAL_STATE_ENTRY_TYPE, …)` call. `loadGoalFromSession` rehydrates both. **One entry holds the whole queue** (matches the reference's single-`State`-with-`list`-field model; queues are small so re-appending on each change is negligible).
2. **Runtime state:** `GoalRuntimeState` (`state.ts`) gains `list: GoalListItem[]` alongside `activeGoal`. `__resetGoalState()` clears it. `GoalListItem` = `{ id, text, tokenBudget?, audit?: GoalAuditOptions }` (a goal-to-be, not yet activated — no usage/timer fields until it becomes the active goal).
3. **No new status states.** The machine stays `active / paused / budget_limited / complete`. A queued item isn't a goal yet — it has no status; it becomes `active` (via `createGoal`) when promoted to `activeGoal`. Completing the active goal archives it + promotes the next list item to `active`. This is exactly the reference's "loops 1+2 share one machine" consolidation — empirically validated.
4. **`/goal` ⇄ `/list` coexistence:** `activeGoal` remains the single source of truth for the live goal. A standalone `/goal "<obj>"` (no list) works exactly as today. When a list is active, `activeGoal` is the list's head; completing it pops the queue.

**Sub-decision deferred to ticket 02/03:** whether promotion on completion is **automatic** or **explicit (`/list next`)** — that's a UX grilling ticket, not a storage question.

**No blocker found.** Adaptation is mechanical (extend two types + two functions), not architectural.

**Closed:** 2026-07-25 (research fired in charting session).
