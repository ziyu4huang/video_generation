> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Spec — core-task quota-retry (faithful verbatim baseline)

- **Date:** 2026-07-31
- **Status:** Done (shipped #969)
- **Effort dir:** `.planning/2026-07-31-core-task-quota-retry/`
- **Origin:** wayfinder "go next" → 3rd GLA→core-task port (after Reviewer #962, length-continue #966)
- **Precedent:** mirrors the faithful-verbatim-baseline decision + pure-module invariant (reviewer.ts, length-continue.ts)

## 1. Goal

Port GLA's `quota-retry` into `pi-agent-ext-core-task` to **stop an infinite token-burning loop** when the goal-completion auditor fails with a 429/quota error. Instead of telling the agent to immediately retry (which re-runs the auditor against a quota window that only resets in ~1h), pause the goal and schedule a one-shot auto-resume at the upstream's own Retry-After hint (default 60m).

## 2. Background / why (the bug, verified)

core-task's `goal_complete` handler audits the completed goal via `runGoalCompletionAuditor`. The auditor-error branch (`src/goal/goal.ts:271-278`):

```typescript
if (auditResult.error && !auditResult.disapproved) {
    ctx.ui.notify(`Goal audit failed (infrastructure): ${auditResult.error}`, "warning");
    return {
        content: [{ type: "text", text: `Audit could not produce a verdict: ${auditResult.error}. Re-verify and call goal_complete again.` }],
        // terminate defaults to false → agent continues in-turn
    };
}
```

This fires for **any** auditor error with no verdict — including 429/quota. `terminate:false` means the agent continues in-turn → immediately re-attempts `goal_complete` → auditor re-runs → 429 again → **loops forever, burning tokens**. (The `disapproved` path is bounded by `AUDIT_MAX_RETRIES=3`; the `error` path is NOT bounded.)

GLA fixed this at `extensions/quota-retry.ts` (102 lines): detect the quota subclass of auditor errors, parse Retry-After, pause + schedule a one-shot resume. core-task has `goalRecovery`/`pauseGoalAfterAgentEnd` for AGENT-turn errors (stopReason aborted/error) but **no quota-aware auditor-error path** and **no Retry-After parsing**. Confirmed gaps: zero `isQuotaError`/`429`/`quota` references in core-task `src/`; no `pauseResumeAt` field.

## 3. Non-goals

- Subagent-quota **wiring** (detecting an `Agent`-tool quota failure in `tool_execution_end`). The pure `isSubagentQuotaResult` function ships in the module (verbatim); its wiring is deferred to a follow-up (D1).
- A settings menu / `quotaRetryMinutes` configurability (core-task has no settings menu). The default is a constant (D3).
- The `pauseResumeAt` goal field (GLA sets it for display). core-task's notify + `/goal status` cover the user-facing signal; the field is display polish, deferred (D5).
- 5-consecutive-errors brake / other GLA `scheduleQuotaRetry` `label` generalizations beyond the auditor case.
- Persisting the scheduled-retry across session restart (a scheduled `setTimeout` is process-local; a restart drops it — the user `/goal resume`s manually, same as GLA).

## 4. The pure module — `src/goal/quota-retry.ts` (verbatim + 1 adaptation)

Verbatim port of GLA's `extensions/quota-retry.ts`. **Zero `@earendil-works/*` imports** (the one adaptation below keeps it pure — even type-only). Exports:

- `QuotaError` — `{ raw: string; retryAfterSec: number; fromUpstream: boolean }`.
- `isQuotaError(error: string | undefined): boolean` — regex: `429|quota|rate.?limit|temporarily|credits?|key limit exceeded|insufficient.?balance|too many requests`.
- `parseQuotaError(error: string, defaultRetryAfterSec = DEFAULT_QUOTA_RETRY_SEC): QuotaError` — parses `Retry-After: N`, `retry after/in N (s|m|h)` prose, else default.
- `DEFAULT_QUOTA_RETRY_SEC = 3600` (60m; GLA's default — replaces the absent `quotaRetryMinutes` setting).
- `isSubagentQuotaResult(toolName, isError, payload): boolean` — pure (shipped verbatim; wiring deferred per D1).
- Timer singleton (module-scoped `quotaRetryTimer`): `isQuotaRetryPending()`, `cancelQuotaRetry()`, `scheduleQuotaRetry(ctx, retryAfterSec, reason, fire, label?)`.

### Adaptation (the only deviation from verbatim — keeps the module pure)
GLA's `import type { ExtensionContext }` → a **local interface** so the module has zero `@earendil-works/*` imports (even type-only), matching the `reviewer.ts`/`length-continue.ts` invariant:

```typescript
/** The ctx shape quota-retry needs (local — keeps the module free of @earendil imports). */
export interface QuotaRetryCtx {
	readonly ui: { notify(message: string, level?: string): void };
}
```

`scheduleQuotaRetry`'s `ctx` param is typed `QuotaRetryCtx`; the goal.ts wiring passes the real `ctx` (which satisfies it structurally). The `setTimeout` + the module singleton are side-effect state local to the module (no @earendil runtime coupling) — consistent with `length-continue.ts`'s tracker singleton.

`scheduleQuotaRetry` ports verbatim otherwise: `cancelQuotaRetry()` first, `Math.max(1_000, sec*1000)` ms, `unref?.()`, try/catch the `fire`, notify `${label} in ${round(sec/60)}m (${reason.slice(0,80)}). /goal resume retries now.`

## 5. Wiring — `src/goal/goal.ts:271` (the auditor-error branch)

Insert a quota sub-check as the **first** thing inside the existing `if (auditResult.error && !auditResult.disapproved)` block, before the current notify+return:

```typescript
if (auditResult.error && !auditResult.disapproved) {
    // quota-retry (GLA faithful baseline): a 429/quota auditor error must NOT
    // loop (the default "re-verify" return re-fires goal_complete → auditor →
    // 429 → burn). Pause + schedule a one-shot resume at Retry-After instead.
    if (isQuotaError(auditResult.error)) {
        const quota = parseQuotaError(auditResult.error);
        cancelContinuationPending(); // no concurrent heartbeat/continuation
        goalState.activeGoal = transitionGoal(completedGoal, "paused");
        persistGoal(goalState.extensionApi as ExtensionAPI, goalState.activeGoal);
        updateStatus(ctx, goalState.activeGoal);
        scheduleQuotaRetry(ctx, quota.retryAfterSec, auditResult.error, () => resumeGoal(pi, ctx));
        return {
            content: [{ type: "text", text: `Goal audit hit a quota/rate limit — paused, auto-retry in ${Math.max(1, Math.round(quota.retryAfterSec / 60))}m (${quota.fromUpstream ? "upstream hint" : "default"}). /goal resume retries now.` }],
            terminate: true, // stop the agent; the scheduled resume re-triggers
        };
    }
    // existing non-quota error path (unchanged)
    ctx.ui.notify(`Goal audit failed (infrastructure): ${auditResult.error}`, "warning");
    return {
        content: [{ type: "text", text: `Audit could not produce a verdict: ${auditResult.error}. Re-verify and call goal_complete again.` }],
    };
}
```

> **Implementer notes:**
> - `completedGoal` (the handler's local, `goal.ts:193`) === `goalState.activeGoal` at this point — both carry the pushed `auditHistory` (lines 262-266 reassign `completedGoal` and sync it back to `goalState.activeGoal`). Pause `completedGoal` to **mirror the disapproved path's idiom** at `goal.ts:292` (`goalState.activeGoal = transitionGoal(completedGoal, "paused")`).
> - `terminate: true` is load-bearing: it stops the in-turn loop so the agent doesn't immediately re-call `goal_complete`. The scheduled `resumeGoal` re-triggers the agent → it re-attempts `goal_complete` → auditor re-runs (quota hopefully reset by then).
> - `resumeGoal(pi, ctx)` (defined at `goal.ts:867`) is the auto-resume target. Passing it as a closure to `scheduleQuotaRetry`'s `fire` is fine (deferred call). `cancelContinuationPending` already exists in goal.ts.

## 6. cancelQuotaRetry hooks

- **`resumeGoal` (goal.ts:867):** call `cancelQuotaRetry()` at the top — a manual `/goal resume` during the quota window must cancel the scheduled auto-resume (GLA contract item 10/12: don't stomp a user action).
- **`session_start` handler (goal.ts:534):** call `cancelQuotaRetry()` alongside the other resets — a scheduled timer is process-local; a fresh session drops it (defensive clear, same as `resetLengthContinue()`).

## 7. Guards (verbatim from the module + the wiring)
- `scheduleQuotaRetry` always `cancelQuotaRetry()`s first → at most one pending quota retry.
- `Math.max(1_000, sec*1000)` → never a sub-second fire.
- `unref?.()` → the timer never keeps the process alive.
- try/catch `fire` → a resume failure after restart doesn't crash (the session may be gone).
- The quota check is `isQuotaError(auditResult.error)` INSIDE `auditResult.error && !auditResult.disapproved` → a quota error that is ALSO a disapproval is NOT paused (the disapproval path owns it).

## 8. Compose with PR #962 (Reviewer) + #966 (length-continue)
- quota-retry edits the `goal_complete` auditor-error branch (goal.ts:271). Reviewer edits the `goal_complete` clean-complete terminal (~goal.ts:316-342). **Same handler, different branch** → the edits don't overlap as long as each branches off the latest main. length-continue edits `agent_end` (different handler). All three compose; recommend quota-retry branches off the post-#966 main (or off `video_generation__file2md`) so it doesn't rebase-conflict with #966's goal.ts edits. If both touch goal.ts near each other, the merge is a trivial context resolve.

## 9. Testing

### 9.1 Pure-module unit tests — `src/goal/__tests__/quota-retry.test.ts`
Translate GLA's tests:
- `isQuotaError`: positive on "429", "rate limit exceeded", "insufficient balance", "too many requests"; negative on `undefined`, "", "network error", "connection reset".
- `parseQuotaError`: `Retry-After: 5` → 5s, fromUpstream; `retry in 2m` → 120s; `retry after 30 seconds` → 30s; no hint → default 3600, !fromUpstream.
- `isSubagentQuotaResult`: Agent tool + isError + quota payload → true; non-Agent tool → false; !isError → false; non-quota payload → false.
- Timer: `scheduleQuotaRetry` calls notify; `isQuotaRetryPending()` true after schedule, false after `cancelQuotaRetry()`; the `fire` callback runs on the timer (use fake timers / a 0-delay test). `cancelQuotaRetry` before a new schedule (only one pending).

### 9.2 Wiring tests — add to `hardening-loop.test.ts` (reuse harness), or a new `quota-retry-wiring.test.ts`
- **quota path:** drive `goal_complete` with an auditor mock that returns `{ error: "429 Too Many Requests — retry after 60s", disapproved: false }` → assert the goal is **paused** (`goalState.activeGoal.status === "paused"`), `scheduleQuotaRetry` was called (or `isQuotaRetryPending()` true), and the return is `terminate: true`. Assert NO immediate re-loop (the agent is told to stop).
- **non-quota error path:** auditor returns `{ error: "stream interrupted", disapproved: false }` → existing "re-verify" return, `terminate` falsy, goal NOT paused, no scheduled retry.
- **disapproved+quota:** auditor returns `{ error: "429 ...", disapproved: true }` → the disapproval path owns it (NOT the quota pause) — assert the quota branch did not fire.
- **resume cancels:** after a scheduled quota retry, call the `resume` command → `isQuotaRetryPending()` false.
- **session_start cancels:** fire `session_start` → pending quota retry cleared.

> The wiring test needs the `goal_complete` tool drivable in the harness (the mock-ctx harness used by hardening-loop.test.ts drives agent_end; goal_complete is a tool, so the test invokes the registered tool's execute). Mirror how `audit-wiring.test.ts` drives the audit (it already exists — read it for the goal_complete tool-invocation pattern).

## 10. Acceptance criteria
1. `src/goal/quota-retry.ts` exists, is pure (zero `@earendil-works/*` imports, even type — uses local `QuotaRetryCtx`), and exports the §4 API.
2. A quota auditor error (`isQuotaError`) pauses the goal + schedules a one-shot resume + returns `terminate:true` (no immediate re-loop). A non-quota error keeps the existing "re-verify" path.
3. At most one pending quota retry (`scheduleQuotaRetry` cancels first); `resumeGoal` + `session_start` cancel a pending retry.
4. The give-up/notify text references no `/glla`.
5. core-task suite green (existing + new); `bunx tsc --noEmit` exit 0 (per-package AND cross-package `pi-agent`).
6. Composes with #962 + #966 (branch off latest main).

## 11. Decisions
- **D1 — Scope: auditor-quota path + pure `isSubagentQuotaResult`; defer subagent wiring.** Rationale: the auditor-error loop is the active token-burn bug; the subagent case is a secondary detection. Shipping the pure function keeps the module faithful; wiring it is a focused follow-up.
- **D2 — ctx type: local `QuotaRetryCtx` interface** (not `import type ExtensionContext`). Rationale: truly pure module (zero @earendil imports, even type), matching reviewer.ts/length-continue.ts. The goal.ts wiring passes the real ctx (structural satisfaction).
- **D3 — Default: `DEFAULT_QUOTA_RETRY_SEC = 3600` constant.** Rationale: core-task has no settings menu; the GLA default (60m) is a constant. Configurability deferred with the settings menu.
- **D4 — cancelQuotaRetry hooks: `resumeGoal` + `session_start`.** Rationale: a manual resume must cancel the scheduled auto-resume (GLA contract 10/12); a fresh session drops the process-local timer.
- **D5 — Skip `pauseResumeAt` field.** Rationale: display-only; the notify + `/goal status` cover the user signal. Adding the field is minor polish, deferred.
- **D6 — Faithful verbatim baseline** (the established strategy). The module's LOGIC ports verbatim; the ctx type is localized (D2); the wiring maps GLA's `pauseResumeAt`/ledger/`ExtensionContext` to core-task's `transitionGoal("paused")`/`persistGoal`/`QuotaRetryCtx`. Same faithful-baseline mapping as reviewer.ts + length-continue.ts.

## 12. Follow-ups (deferred)
- Wire `isSubagentQuotaResult` into `tool_execution_end` (detect an `Agent`-tool quota failure → surface/notify).
- `pauseResumeAt` goal field + `/goal status` "auto-resume in Nm" display.
- `quotaRetryMinutes` configurability (with the settings-menu port).
- A 5-consecutive-quota-errors brake (GLA's `scheduleQuotaRetry` `label`
  generalization) if quota loops become a pattern.

### 12.1 Post-implementation follow-up (from the SDD final review, 2026-07-31)

The baseline shipped merge-ready (2 commits, 550/0, tsc clean per-package +
cross-package). One non-blocking item:

- **(optional hardening, NOT merge-blocking) `session_shutdown` does not call `cancelQuotaRetry()`** — the scheduled timer is `unref()`d (won't keep the process alive), the `fire` callback is try/catch-wrapped, and `resumeGoal`'s own status guard blocks a double-resume, so it is NOT a correctness defect. The only uncovered window: a shutdown where the process keeps running and no new `session_start` follows — the timer could fire `resumeGoal` on a stale `ctx` (caught harmlessly). Optional symmetry fix: add `cancelQuotaRetry()` to `session_shutdown` alongside the existing `clearContinuationTracking()`/`clearGoalRecovery()` cleanup. Surfaced by the SDD final review.
