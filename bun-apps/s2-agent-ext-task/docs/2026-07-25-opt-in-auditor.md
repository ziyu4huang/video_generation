# Spec — opt-in isolated completion auditor (core-task)

Effort: `2026-07-25-do-as-you-suggesnt-then-continue-develop`, ticket **T04**.
Charted against the post-hardening clean base (PR #814, `goal/` modularized).
Reference mentor: `../pi-goal-list-loop-audit/extensions/goal-loop-{auditor,shield}.ts` (read-only; clean-room port, no runtime coupling).

Date: 2026-07-25. Conversation language zh-TW; written artifacts English.

## 1. Goal

Add an **opt-in** isolated completion auditor to `s2-agent-ext-task`. When a
goal opts into audit, `goal_complete` is no longer a self-report: a fresh pi
agent session (no extensions/skills/prompts/themes, read-only tools) inspects
the repo and returns a three-way verdict (`<approved/>` / `<disapproved/>` /
`<impossible>reason</impossible>`). Completion is gated on the verdict.

This closes the "self-report bamboozle" — the single highest-value capability gap
vs the reference — **without** turning the bundled default-loaded cockpit into a
default-on supervisor.

## 2. Non-goals (out of scope)

- **Mandatory-on** auditing (every `goal_complete`). Ruled out by the
  destination; the auditor is opt-in or nothing.
- **Verification-contract UX** (a way for the user to author a
  `verificationContract`). The shield *code* is ported and wired, but no
  command/flag to *set* a contract ships in this spec — it stays inert until a
  contract exists (future sub-ticket).
- **Full TUI progress overlay** for the audit (the reference's phase/percentage
  widget). core-task gets a one-line status + a final notify only.
- **Runtime interop with `../pi-goal-list-loop-audit/`'s `.pi-gla/` state.**
- **A dedicated auditor model config UI.** An opt-in `--model` override is
  supported; default is the session model.

## 3. Decisions (locked)

- **D1 — opt-in surface: `/goal --audit` flag at creation + `/goal audit` toggle.**
  `goal_complete` for an audit-enabled goal runs the auditor. `/goal audit`
  (with no objective) toggles audit on the currently-active goal. Default off —
  the bundled cockpit's default contract is unchanged. An optional
  `--model provider/id` overrides the auditor model (else the session model).
- **D2 — regression_shield: ported verbatim, inert without a contract.**
  `goal/shield.ts` is a pure, pi-import-free module (`parseAuditorVerdict`,
  `checkRegressionShield`, `contractItems`) transcribed from the reference.
  Evidence enforcement activates only when the goal has a `verificationContract`
  (core-task goals don't by default → zero default-path change). No
  contract-authoring UX in this spec.
- **D3 — on disapprove: bounded auto-re-loop.** The goal stays active; the audit
  finding is returned to the agent as the `goal_complete` tool result AND fed
  into the next continuation prompt, so the agent self-corrects. After
  `AUDIT_MAX_RETRIES` (3) consecutive disapprovals → escalate to the user
  (notify + pause the goal, never a silent force-complete). `<impossible>` →
  complete with a note. Infrastructure errors (no output / no verdict marker /
  stall / exception) → do **not** complete; notify and let the agent/user retry
  (matches the reference's "infra is never a verdict" floor).

## 4. Architecture

Two new modules under `src/goal/`, plus a typed hook in the `goal_complete`
tool. The orchestrator (`goal.ts`) stays cohesive — it only gains the opt-in
plumbing + the result routing.

```
src/goal/
  shield.ts     NEW  pure: parseAuditorVerdict + checkRegressionShield + contractItems
                     (verbatim port; zero non-crypto imports; unit-tested in isolation)
  auditor.ts    NEW  createAgentSession runner: runGoalCompletionAuditor()
                     (LAZY-imported only when an audit runs → default sessions pay
                      zero import cost; keeps core-task lightweight)
  goal.ts       EDIT hook audit into goal_complete execute (between planning-gate
                     and transition-to-complete); add /goal --audit + /goal audit;
                     route the verdict per D3
  state.ts      EDIT extend the active-goal shape with audit fields (§5)
  commands.ts   EDIT parse --audit + --model flags; /goal audit toggle
```

### 4.1 Model-auth (the T03 risk — resolved at execution time)

Verified against pi 0.82.0 SDK (this repo's pin):

- `ExtensionContext.modelRegistry: ModelRegistry` is public (`extensions/types.d.ts:220`) — reachable in tool `execute` and event handlers.
- `CreateAgentSessionOptions.modelRuntime?: ModelRuntime` is accepted (`core/sdk.d.ts:16`).
- `ModelRegistry.runtime` is a **public** field (`core/model-registry.js:7`) — **no `as any` needed** (the reference's defensive cast is obsolete in 0.82.0).

So the auditor reuses the parent's runtime cleanly, which carries
extension-registered providers. An opt-in `--model` override replaces the model;
the runtime is always the parent's.

```ts
const { session } = await createAgentSession({
  cwd: ctx.cwd,
  model: overrideModel ?? ctx.model,
  modelRuntime: ctx.modelRegistry.runtime,   // parent runtime → extension providers auth
  thinkingLevel: "medium",
  resourceLoader: makeAuditorResourceLoader(),  // zero extensions/skills/prompts/themes
  sessionManager: SessionManager.inMemory(ctx.cwd),
  settingsManager: SettingsManager.inMemory({ compaction: { enabled: true } }),
  tools: ["read", "grep", "find", "ls", "bash"],
});
```

## 5. Data model

Extend the active-goal object (the shape in `goalState.activeGoal` /
`GoalStateEntryData.goal`) with **optional** fields — absent = current behavior:

```ts
auditEnabled?: boolean;                // goal opts into completion audit
verificationContract?: string;         // optional; enables regression_shield
auditHistory?: GoalAuditorResult[];    // appended each audit (capped)
auditAttempts?: number;                // consecutive disapprovals (resets on approve)
```

`GoalAuditorResult` shape (ported): `{ approved, disapproved, impossible?,
impossibleReason?, output, model, thinkingLevel?, error?, regressionShieldPassed?,
regressionShieldMissing? }`.

These persist via the existing session-store path (`persistGoal` already clones
the goal); no new persistence machinery.

## 6. The auditor runner (`auditor.ts`)

Clean-room port of `runGoalCompletionAuditor` (reference
`goal-loop-auditor.ts`), adapted to core-task's `Goal` shape. All safety floors
ported verbatim — these are the non-negotiable correctness guarantees:

1. **Must-call-a-read-tool.** An `<approved/>` with zero read/grep/find/ls/bash
   calls is converted to a disapproval (it didn't actually audit).
2. **Silent-failure → error, not verdict.** Empty output, or output with no
   verdict marker, is an infrastructure result (`error && !disapproved`), never
   a disapproval. Stream errors (401/403/429/credits) captured from events +
   `message_end` `stopReason:"error"`.
3. **10-min stall abort → error.** `AUDITOR_STALL_MS` inactivity → `session.abort()`
   → error result (never a verdict, never an unbounded hang). Reuse
   `HEARTBEAT_STALL_MS`-style watchdog; the stall timer is `.unref()`'d.
4. **Three-way verdict.** `<approved/>` / `<disapproved/>` /
   `<impossible>reason</impossible>`. Parsed from the last assistant block
   mentioning a verdict tag.
5. **regression_shield** (when `verificationContract` present): an approval
   without a complete `<evidence>` block addressing every contract item is
   converted to a disapproval, with `regressionShieldMissing` echoed back so the
   next audit addresses the gap (converges instead of repeating).
   **NOTE:** This floor is INERT-by-design in core-task because
   `verificationContract` is never set by any command/flag. Per ticket 06
   (core-task-review), activation via a `/goal --verify` flag is left as a
   separate future decision. See `auditor.ts:263` for the inert-by-design
   annotation.
6. **Exception → error, not verdict.** A thrown runtime error is infrastructure
   (`error && !disapproved`); never routed to the semantic-disapproval branch.

Compaction is **enabled** in the auditor session (closes context-exhaustion
mid-audit; the shield is orchestrator-side so compaction can never cause a false
approval).

## 7. Wiring (`goal.ts` `goal_complete` execute)

Insert the audit between the existing **planning gate** and
**transition-to-complete** (both already in the handler):

```
… planningGateBlocking(ctx) …            (existing)
if (goal.auditEnabled) {                 (NEW)
  const result = await runAudit(ctx, goal, summary);   // lazy import
  goal.auditHistory = pushCapped(goal.auditHistory, result, AUDIT_HISTORY_CAP);
  if (result.error)   → notify + return (do NOT complete; let agent/user retry)
  if (result.impossible) → complete with a note
  if (result.disapproved) {
     goal.auditAttempts = (goal.auditAttempts ?? 0) + 1;
     if (goal.auditAttempts >= AUDIT_MAX_RETRIES) → pause + notify user (escalate)
     else → return the finding as the tool result with terminate:false
            (the agent continues in-turn, reads why it was disapproved,
             and self-corrects); goal stays active, no transition
  }
  // result.approved (and shield passed) → fall through to complete
}
transitionGoal(goal, "complete") …       (existing)
```

- **Re-loop mechanism:** `goal_complete` returns `{ terminate: false, content:
  [finding] }` on disapprove (vs `terminate: true` on the current success path).
  The agent keeps the turn, reads the finding, and re-attempts — no separate
  continuation-prompt injection needed (the goal is still active, so the
  existing agent_end continuation seam already keeps the loop alive).
- `AUDIT_MAX_RETRIES = 3`, `AUDIT_HISTORY_CAP = 8` (constants in `auditor.ts`).

## 8. Opt-in UX (`commands.ts`)

- `/goal --audit "<objective>"` → starts a goal with `auditEnabled: true`.
- `/goal audit` → toggles `auditEnabled` on the active goal (on↔off), with a
  notify confirming the new state.
- `/goal --audit --model provider/id "<objective>"` → sets the per-goal auditor
  model override.
- `parseCommand` (the pure parser extracted in Phase-1 Task 2) gains the flags;
  existing parsing is unchanged when no flag is present.

## 9. Visibility

- During an audit: the status widget shows a one-line state
  (`auditing completion…`) via the existing `updateStatus` path. No phase/percentage
  widget (out of scope).
- On finish: `ctx.ui.notify` with the verdict + a truncated (≤300 char) slice of
  the audit output. Full output retained in `auditHistory`.

## 10. Testing

- **`shield.ts`** — pure unit tests ported from the reference's shield suite:
  `parseAuditorVerdict` (approved/disapproved/impossible/none), `contractItems`
  (prefix stripping, preamble/boundary filtering), `checkRegressionShield`
  (missing evidence, compound-token matching, evidence-block presence).
- **`auditor.ts`** — the runner is tested with a **fake session** (a stub
  `createAgentSession` via module mocking, or an injected session factory): feeds
  canned assistant outputs and asserts each safety floor (must-read-tool,
  silent→error, stall→error, three-way parse, exception→error, shield
  enforcement). No real model calls in unit tests.
- **`goal_complete` wiring** — integration test (mirrors the `hardening-loop.test.ts`
  harness): an audit-enabled goal whose auditor (mocked) disapproves does NOT
  transition to complete and returns the finding; after 3 disapprovals the goal
  pauses; an approval completes normally; `impossible` completes with a note.
- **Opt-in default** — a non-audited goal's `goal_complete` is byte-for-byte the
  current path (regression guard).

## 11. Rollout

- Default off; only opted-in goals pay one extra session per `goal_complete`
  attempt. Non-goal sessions and non-audited goals: zero change (lazy import
  keeps the default bundle cost at zero).
- Behavior change is scoped to `auditEnabled` goals; all hardening paths from PR
  #814 still guard on `activeGoal.status === "active"`.

## 12. Follow-ups (deferred, not in this spec)

- **Verification-contract authoring UX** (a `/goal --verify "…"` flag or a
  generated contract) — unblocks the shield's default value.
- **Auditor progress TUI** (phase/percentage) if lightweight cockpit users ask.
- **T04 map closure** — update `.planning/…/map.md` ticket 04 status to
  closed once the auditor lands.
