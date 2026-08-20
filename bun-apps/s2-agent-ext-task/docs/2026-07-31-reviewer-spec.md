# Spec — Reviewer (post-completion follow-up enqueuer) for core-task

Effort: `2026-07-31-core-task-reviewer`. Faithful baseline port of the GLA
(`pi-goal-list-loop-audit`) Reviewer (v0.26 → v0.28 hardened design), scoped to
GLA `on` mode. Built on the post-Loop-3 base already in core-task: the hardened
single-goal machine + opt-in auditor (#818) + `/list` queue (#826) + `/loop`
(#844).

Date: 2026-07-31. Conversation language zh-TW; written artifacts English.

## 1. Goal

Add a **Reviewer** to `s2-agent-ext-task`: after a `/goal` completes
cleanly (or a `/list` queue drains), extract **findings** from the completion
summary + any disapproved audit reports, classify them by **leverage**, and
cascade per GLA `on` mode:

| Finding class | Action | Confirm? |
|---|---|---|
| Bug (`TODO`, `FIXME`, `bug`, `regression`, `broken`) | `/list` items | No — fix-without-confirm (the leverage principle: you'd never say no to a bug) |
| Refactor (`duplicated`, `could be cleaner`, `left out`, `deferred`) | `/list` items | No |
| Architectural (`rewrite`, `new dependency`, `schema change`) | `/goal` proposal | Yes |
| Strategic (`should we…`, `deprecate`) | notify only | — |
| Clean completion (no findings) | regression-scan `/goal` proposal | Yes |

The Reviewer makes **no tool calls itself** — it is a pure analytical function
with all side effects injected, mirroring the `shield.ts` / `list.ts` invariant.
A bare `/goal` with no findings in its summary gains one Confirm dialog (the
regression-scan proposal); everything else stays byte-identical to today.

## 2. Non-goals (out of scope for this baseline)

- **`auto` / `aggressive` modes** (GLA's no-Confirm / relaunch cascades). Defer.
- **Full `/glla postaudit` config menu** (mode / triggers / cascade / caps UI).
  Baseline ships hardcoded `DEFAULT_REVIEWER_CONFIG` (`mode = "on"`) + a minimal
  `/goal review on|off` session toggle.
- **`/review <id>`** manual re-run (bypasses trigger gates). Quick follow-up.
- **failed-send phantom-proposal tracking** beyond the `proposeGoal: () => boolean`
  contract (already covered by returning a bool).
- **Adapting findings to the plan-coordinator / wayfind layer** (the "C strategy"
  fork). Separate effort once real findings are observed.
- **A disk archive of goals.** core-task persists via session-store; the Reviewer
  sources only from data already in scope at completion (see §5).

## 3. Decisions (locked)

- **D1 — strategy**: faithful baseline port of GLA's pure `reviewer.ts` logic,
  wired to core-task's existing `addListItems` / `createGoal` / `ctx.ui.notify` /
  `appendEntry`. Decided 2026-07-31 (brainstorm: direction = Reviewer, strategy =
  faithful baseline, loudness = GLA `on` mode).
- **D2 — finding sources (the adaptation gap, solved)**: the `goal_complete`
  tool **already requires `params.summary`** (the agent's completion narrative —
  the highest-signal finding source, where "TODO/FIXME/deferred/left out" leak).
  Disapproved audit outputs are the second source. **No new capture mechanism.**
  Source set passed to `extractFindings`:
  - `{ name: "completion-summary", text: summary }`
  - `{ name: "audit-disapproved", text: auditHistory.filter(r => r.disapproved).map(r => r.output).join("\n\n") }`
  - the goal `objective` is passed separately for restatement-dedup.
- **D3 — trigger point**: inside the `goal_complete` handler, at the
  clean-complete terminal path (after `promoteNext` returns no item, immediately
  before `clearActiveGoal`), **synchronous**. Rationale: `summary` is in scope,
  `ctx.ui.confirm` is an awaitable UI method (not a tool — already used at
  `goal.ts:811`), and this is the simplest faithful hook. Pause / abort /
  infra-error paths all early-return **before** the hook, so they never fire the
  Reviewer.
- **D4 — Confirm vehicle**: `ctx.ui.confirm`, but OUTSIDE the pure function.
  `runReviewer` stays **verbatim GLA — pure and synchronous** (its design pillar;
  this is what keeps the cascade-matrix unit tests trivially sync + host-free).
  Its `proposeGoal` dep is therefore **sync** and only RECORDS the proposal
  (pushes onto a collector array, returns `true` = delivered). The actual Confirm
  runs in the **async `goal.ts` wiring, AFTER `runReviewer` returns**: for each
  recorded proposal, `await ctx.ui.confirm(...)`; on accept → `createGoal(...)` +
  `terminate:false` to continue in-turn on it; all declined (or no proposal) →
  normal `terminate:true`. (Not `ask_user_question`: that is a *tool* and cannot
  be invoked from inside a tool handler. `ctx.ui.confirm` is the package's
  existing Confirm path, already used at `goal.ts:811`.)
- **D5 — safety subset**: 5-minute refire window (runaway prevention),
  `maxReviewsPerDay = 20`, `maxFindingsPerReview = 10`, duplicate-scan dedupe
  (a regression-scan goal completing must not propose an identical scan). Defer
  the full trigger/cascade/caps config menu.
- **D6 — persistence**: a new session-store entry type `goal-reviewer` carries
  `{ at, goalId, kind, cascadeStep, findings, enqueued, proposed }` so
  `reviewerFiredRecently` / `reviewsToday` survive compaction. One entry per fire
  (and one per suppression — recorded with a `reason`).
- **D7 — reports on disk**: review reports are human-readable documents →
  written to `<cwd>/.pi/core-task/reviews/<goalId>-<ts>.md` (core-task otherwise
  uses session-store, not disk dirs; reports are the documented exception).
- **D8 — config**: `DEFAULT_REVIEWER_CONFIG` hardcoded (`mode: "on"`).
  `/goal review on|off` toggles a session flag (`goalState.reviewerEnabled`,
  default `true`). Full menu deferred.

## 4. Architecture

```
src/goal/
  reviewer.ts        NEW   pure module, ZERO pi imports (mirrors shield.ts/list.ts).
                             Port from GLA: ReviewerConfig, resolveReviewerConfig,
                             classifyFindingText, FindingClass, extractFindings,
                             stripCodeSpans, unwrapHardWrappedLines, cutAtClauseBoundary,
                             runReviewer, formatReviewReport, reviewerFiredRecently,
                             reviewsToday, normalizeObjective, DEFAULT_REVIEWER_CONFIG.
                             All side effects via the injected ReviewerDeps interface.
  goal.ts            EDIT  at the clean-complete terminal path: build sources,
                             read the reviewer ledger from session-store, bind deps,
                             call runReviewer, wrap in try/catch (never blocks
                             completion). Also: the /goal review on|off subcommand
                             toggles goalState.reviewerEnabled.
  persistence.ts     EDIT  appendReviewerEntry(api, record) + loadReviewerEntries(sm)
                             for the goal-reviewer entry type (recently-fired /
                             per-day-cap queries).
  format.ts          EDIT  /goal status shows the last review's cascade step +
                             report path (small addition).
  state.ts           EDIT  goalState.reviewerEnabled: boolean (default true);
                             ActiveGoal gains origin: "list" | "bare" (set by
                             createGoal: "list" when promoted from a /list item,
                             "bare" otherwise) — drives the Reviewer `kind`.
```

`reviewer.ts` is the only new module — pure, pi-import-free, unit-testable in
isolation. Everything else edits existing modules.

## 5. Finding extraction & cascade (pure — ported from GLA verbatim)

Pipeline (unchanged from GLA, already battle-hardened through v0.26–v0.28):

1. **Strip code**: remove fenced blocks + inline code spans (findings live in
   prose; quoted code is how vocabulary leaks in).
2. **Unwrap hard-wrapped lines**: join a line onto the previous when it starts
   lowercase and the previous lacks terminal punctuation (findings are
   sentence-shaped, not visual-line-shaped).
3. **Classify** each line via ordered `CLASS_PATTERNS` (strategic > architectural
   > bug > refactor), skipping code lines / markdown tables / the Reviewer's own
   report vocabulary (self-match guard), and lines < 8 chars.
4. **Cut at clause boundary** (200-char cap; never mid-word — the finding text IS
   the user-facing `/list` item name).
5. **Dedupe** + drop dangling-connector fragments (`…codebase to`) + drop
   findings that restate the just-completed objective (prefix/paraphrase match).

Cascade (`runReviewer`, `on` mode only for this baseline):

- bugs+refactors → `enqueueListItems(texts)` (no Confirm).
- architectural → `proposeGoal(joined, reason)`; the dep Confirm-gates via
  `ctx.ui.confirm`; returns whether the message was delivered/accepted.
- strategic → `notify` only (warning level).
- zero findings → `proposeGoal("Post-completion regression scan after <id> (regression-scan)", …)`,
  with **duplicate-scan dedupe**: if the completing objective normalizes equal
  to that audit objective, suppress the proposal (still write the report + ledger
  `duplicate-suppressed`).

Suppression gates (before any extraction): `reviewerEnabled === false` → off;
terminal ≠ clean-complete → skip; refire within 5 min → skip; day-cap hit → skip.

## 6. Wiring (`goal.ts`)

At the clean-complete terminal path (the branch where `promoteNext` yields no
`item`), before `clearActiveGoal(ctx)`:

```ts
try {
  const entries = loadReviewerEntries(ctx.sessionManager);
  const sources = [
    { name: "completion-summary", text: summary },
    { name: "audit-disapproved", text: (completedGoal.auditHistory ?? [])
        .filter(r => r.disapproved).map(r => r.output).join("\n\n") },
  ];
  // proposeGoal is SYNC (runReviewer is pure+sync, verbatim GLA): it only
  // RECORDS the proposal; the Confirm runs after runReviewer returns.
  const recordedProposals: Array<{ objective: string; reason: string }> = [];
  const outcome = runReviewer(
    resolveReviewerConfig({ enabled: goalState.reviewerEnabled }),
    { kind: completedGoal.origin === "list" ? "list" : "goal", goalId: completedGoal.id, objective: completedGoal.text, terminal: "goal-complete" },
    {
      cwd: ctx.cwd,
      nowMs: Date.now(),
      ledgerEntries: entries,
      sources,
      enqueueListItems: (objs) => { goalState.list = addListItems(goalState.list, objs); persistGoal(goalState.extensionApi, goalState.activeGoal); },
      proposeGoal: (objective, reason) => { recordedProposals.push({ objective, reason }); return true; },
      notify: (m, lvl) => ctx.ui.notify(m, lvl),
      ledger: (type, value) => appendReviewerEntry(goalState.extensionApi, { type, ...value, at: new Date().toISOString() }),
    },
  );
  appendReviewerEntry(goalState.extensionApi, { type: outcome.fired ? "reviewer_fired" : "reviewer_suppressed", goalId: completedGoal.id, cascadeStep: outcome.cascadeStep, enqueued: outcome.enqueued, proposed: outcome.proposed, at: new Date().toISOString() });
  // Confirm loop (async wiring, OUTSIDE the pure function). First accept wins;
  // at most one active /goal, so stop after the first accepted proposal.
  let acceptedObjective: string | undefined;
  for (const p of recordedProposals) {
    const ok = await ctx.ui.confirm(`Reviewer: ${p.reason}\n\nPropose new /goal:\n"${p.objective}"?`);
    if (ok) { acceptedObjective = p.objective; break; }
  }
  if (acceptedObjective) {
    goalState.activeGoal = createGoal(acceptedObjective, undefined, currentTokenTotal(ctx), undefined);
    persistGoal(goalState.extensionApi, goalState.activeGoal);
    updateStatus(ctx, goalState.activeGoal);
    return { content: [{type:"text", text:`Goal complete: ${summary}. Reviewer proposed a follow-up /goal, now active: ${acceptedObjective}`}], details: {goal, summary}, terminate: false };
  }
} catch (reviewerError) {
  ctx.ui.notify(`Reviewer skipped (non-fatal): ${String(reviewerError)}`, "warning");
}
// fall through to clearActiveGoal + terminate:true as today
```

`completedGoal.origin` (the new `"list" | "bare"` field on `ActiveGoal`) drives
the `kind`. When `kind === "list"` **and** the queue is now empty, the event is
effectively the list-drain review; the 5-min refire window naturally collapses a
multi-item drain into the final review.

`/goal review on|off`: new subcommand parsed in `commands.ts`; toggles
`goalState.reviewerEnabled` and notifies. No persistence beyond the session
(baseline).

## 7. Persistence (`persistence.ts`)

```ts
export const REVIEWER_ENTRY_TYPE = "goal-reviewer";

export function appendReviewerEntry(api: GoalPersistenceApi | undefined, record: ReviewerLedgerRecord): void;
//   → api?.appendEntry(REVIEWER_ENTRY_TYPE, record)

export function loadReviewerEntries(sessionManager: unknown): ReviewerLedgerRecord[];
//   → filter session-store entries by customType === REVIEWER_ENTRY_TYPE
```

`ReviewerLedgerRecord = { type: "reviewer_fired" | "reviewer_suppressed"; at: string; goalId: string; cascadeStep?: string; enqueued?: number; proposed?: number; reason?: string }`.
`reviewerFiredRecently` reads `at` from `reviewer_fired` entries;
`reviewsToday` counts same-day `reviewer_fired` entries.

## 8. UX delta & rollout

- **Bare `/goal` (no findings)**: gains ONE `ctx.ui.confirm` (the regression-scan
  proposal). Dismissible. `/goal review off` silences the Reviewer for the
  session. This is the only user-visible behavior change vs today.
- **Bare `/goal` (with findings)**: bug/refactor items silently enqueue to `/list`
  (no dialog); architectural pops a Confirm; the completion message still
  terminates the turn unless a `/goal` was proposed+accepted.
- **`/list` drain**: the final item's clean-complete fires the Reviewer; the 5-min
  refire window suppresses intermediate per-item fires during a rapid drain.
- `/loop` completions **never** trigger the Reviewer (the metric is the verdict).

## 9. Testing (TDD — test-first)

- **`reviewer.ts`** (pure, the bulk): port GLA's full suite —
  `classifyFindingText` per class + skip cases (code/table/vocab/short);
  `stripCodeSpans`; `unwrapHardWrappedLines` (lowercase-continuation join,
  standalone-item no-merge); `cutAtClauseBoundary` (clause cut, space cut, short
  pass-through); `extractFindings` (dedupe, dangling-end drop, objective-restatement
  drop, max cap); `runReviewer` cascade matrix (bugs→list, architectural→propose,
  strategic→notify, clean→audit-propose, duplicate-scan suppress); safety
  predicates (`reviewerFiredRecently`, `reviewsToday`); suppression gates
  (disabled / wrong-terminal / refire-window / day-cap).
- **`persistence.ts`**: `appendReviewerEntry` → `loadReviewerEntries` round-trip;
  filtering by entry type; multiple entries ordered.
- **`goal.ts` wiring** (mirror `hardening-loop.test.ts` mock-ctx harness):
  inject fake `ctx.ui.confirm` / `ctx.ui.notify` / session-store; drive a clean
  complete with a seeded `summary` containing a bug-shaped line → assert
  `/list` gained the item, no Confirm fired; seed an architectural line → assert
  a proposal was recorded, the post-`runReviewer` `ctx.ui.confirm` loop fired,
  and on accept `createGoal` ran + `terminate:false` (on decline, `terminate:true`);
  seed a clean summary → assert regression-scan proposal; assert pause/abort
  paths never invoke the Reviewer; assert the 5-min refire window suppresses a
  second immediate fire; assert **bare `/goal` regression** (today's completion
  message text unchanged when Reviewer finds nothing and the scan is declined);
  assert try/catch: a throwing dep does not block completion.
- **`commands.ts`**: `parseCommand` handles `/goal review on|off`.

## 10. Follow-ups (deferred, not in this spec)

- `auto` / `aggressive` modes + the `/glla postaudit`-equivalent config menu
  (mode / triggers / cascade / caps).
- `/review <id>` manual re-run (bypasses gates).
- Persisting `reviewerEnabled` across sessions (currently session-only).
- Routing architectural findings to the **wayfind** DECIDE stage / plan
  coordinator (the "C strategy" adaptation).
- A cross-session review-history browser (`/goal reviews`).

### 10.1 Post-implementation follow-ups (from the SDD final review, 2026-07-31)

The baseline shipped merge-ready (9 commits, 577/0, tsc clean per-package +
cross-package). These are non-blocking items the final review surfaced:

- **(high) Data-loss edge on throwing `ctx.ui.confirm`** — `goal.ts` catch
  block calls `clearActiveGoal(ctx)` without `preserveList`, so if `confirm`
  throws AFTER bug/refactor items were already enqueued, those `/list` items
  are erased. Fix: hoist `reviewerEnqueued` outside the `try` so the catch can
  pass `preserveList: reviewerEnqueued > 0`; add a `confirmThrows-after-enqueue`
  test. (Narrow: `ctx.ui.confirm` throwing is an artificial scenario.)
- **(medium) `/glla postaudit` strings are currently dead code** —
  `reviewer.ts` suppression-reason strings reference `/glla postaudit` (a GLA
  command that does not exist in core-task). Today the wiring calls
  `runReviewer(...)` as a statement and discards `outcome.suppressedReason`,
  so they are invisible. **Any change that surfaces `suppressedReason` to a
  notify/status MUST first rewrite these 5 strings** to core-task's actual
  toggle (`/goal review on|off`) — refire-window/day-cap reasons have no
  core-task user action to point at yet.
- **(low) Coverage** — no test completes an `origin: "list"` goal through the
  wiring (the `kind: "list"` label path); the Task 7 `cutAtClauseBoundary`
  no-space-fallback + Task 2 `extractFindings` dangling-connector assertions
  are weak (brief-verbatim).
- **(low / tuning) `duplicate-suppressed` returns `fired: true`** and writes a
  `reviewer_fired` ledger entry (verbatim GLA), which arms the 5-min refire
  window — a clean scan completing then a real goal completing within 5 min
  is silently refire-suppressed. Narrow (5-min window); evaluate whether
  `duplicate-suppressed` should return `fired: false` (deviates from verbatim).
- **(process) Per-task implementers reported "typecheck clean" after running
  only `bun test`** (bun's transpiler skips tsc); two type errors slipped to
  the verify gate. Going forward, every implementer must show `bunx tsc
  --noEmit` real exit, not just `bun test`.
