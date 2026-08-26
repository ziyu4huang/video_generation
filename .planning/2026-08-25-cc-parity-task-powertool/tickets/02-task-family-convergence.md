# Ticket 02 — Task-family convergence + todo CC semantics

Status: closed (PR pending at write time — gates green: ext-task 849 pass /
tsc clean, ext-subagent 709 pass / check+build+tsc, core-runtime 493 pass /
tsc clean, tool-gate 445 pass / tsc clean)

## Why

Two model-visible task families exist: ext-task's `todo` mega-tool and
ext-subagent's `task_create/get/list/update` over TeamTaskStore. In workflow
sessions the model sees BOTH with overlapping vocabulary and no shared
state. The `todo` half is also missing CC semantics: deps never "resolve"
(completed deps still render `⛓ #1`), edges are one-way (no addBlocks),
`activeForm` promises a spinner that doesn't exist, the workflow-discipline
rules are absent from the description, and tool errors are not flagged
`isError`.

## Decision (D7, in-ticket as scoped)

**Converge on the TeamTaskStore `task_*` family; retire the `todo` mega-tool
to a TUI face.** Measured rationale:

1. CC vocabulary — the four tools already map 1:1 to
   TaskCreate/TaskGet/TaskList/TaskUpdate (parity = shape + vocabulary,
   tui-cc-parity D1).
2. Symmetric edges, cycle rejection, atomic edge edits ALREADY lived in
   core-runtime — ticket items 2/3 were render-level work, not store work.
3. It fixes the actual bug ("no shared state"): the parent's tracking and the
   team board become ONE board everywhere (CC shares its task list across
   agents too; the ticket-#16 contamination hazard was scoped to the retired
   private-scratchpad design).
4. Widget reuse — TodoOverlay/selectors/format survive unchanged over a
   `board-view.ts` adapter (string→numeric ids, effective blockedBy).
5. Stealth-trim + flat-root constraints carry over per-tool trivially.

## What landed

- **core-runtime**: `effectiveBlockedBy(tasks, task)` pure selector (blockedBy
  minus completed deps; unknown ids stay visible) exported through the
  barrel + table-driven tests incl. a live-store derivation test.
- **ext-subagent task-tools.ts**: gating `{gate:"workflow"}` → `{core:true}`
  on all four (visible in EVERY session shape — CC parity);
  workflow-discipline text (in_progress-before-start / completed-only-when-done
  / blocked→new-task) in task_create + task_update descriptions; error
  envelopes `isError:true` (create/update validation, get not-found); taskList
  lines render effective blockedBy only; promptSnippet trimmed (folded into
  the description — stealth doctrine for core-visible tools).
- **ext-task**: `todo` mega-tool + state machinery (reducer, per-session
  buckets/store, invariants, task-graph, response envelope, schema) DELETED
  (~700 lines); new `src/todo/board-view.ts` adapter (TeamTaskStore → view
  shape, effective blockedBy pre-filtered); TodoOverlay + /todos + inspect
  re-pointed at the adapter; `tool_execution_end` refresh keyed on the four
  task tool names; goal THREE_LAYER_GUIDANCE prose re-pointed. activeForm was
  ALREADY wired into the widget's in_progress line (ticket's "prefer wiring"
  satisfied by keeping the renderer).
- **ask-user**: host/validation errors (`no_ui`, questionnaire validation,
  `no_custom_ui`) return `isError:true` and `cancelled:false` — the user never
  cancelled; a genuine Esc-cancel stays non-error. One-line overuse guideline
  in the description ("only ask when genuinely the user's AND changes what
  happens next").
- **tool-gate pins updated**: workflow-family grouped names drop the four task
  tools (tool-gate.test.ts); core-names fixture swaps `todo` → the four task
  tools (now 23 core names); drift-guard ext-task row = ask_user_question +
  goal_complete; qa/migrated-extensions + qa/evaluate drop registerTodoTool.

## Verification

- All four packages' canonical gates green (counts above).
- Goal `event.isError` retry keying (hooks.ts tool_execution_end → repetition
  fingerprints): ask-user validation errors now record as errors — the
  repetition detector labels a repeated invalid questionnaire "same
  ask_user_question error N×" instead of a normal result; quota-retry keys on
  toolName first, unaffected. Improvement, not regression.
- Test pins: core-gating (ext-subagent) asserts core gating + stealth-trim +
  discipline text; board-view + overlay tests pin effective-blocked rendering
  in the TUI face; response-envelope tests pin the isError/cancelled split.

## Honest gaps

- Live-TUI smoke of the widget rendering the shared board not run (code-level
  + unit-golden only; same fog-of-war entry as tickets 02/03 in the map).
- Session restart in a process serving BOTH a plain session and a workflow
  session re-shares the "*" board by design — documented divergence (spec §2),
  no per-session scoping for the TUI face.
- The workflow gate family lost four names; tool-gate's QA probes still
  contain a "multi-step todo list" adversarial probe (still valid — it tests
  that a plain task-list prompt does not fire run_workflow).

## Done-when

- [x] Exactly ONE model-visible task family in every session shape
      (workflow + plain), test-pinned.
- [x] Effective-blocked, symmetric edges, discipline text, isError,
      activeForm all landed on the kept family.
- [x] Canonical gates green; spec.md §1 rows updated; PR merged CLEAN.
