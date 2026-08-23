# Design — pi-agent-ext-workflow codebase-review fixes

**Date:** 2026-07-20
**Package:** `bun-apps/pi-agent-ext-workflow` (v2.9.0)
**Status:** approved (user delegated to recommended option)
**Git strategy:** feature branch (no worktree)

## Background

A codebase review of `bun-apps/pi-agent-ext-workflow` surfaced one CI-blocking
issue and three low-severity cleanups. This spec defines how to resolve all four
(F1–F4) and the verification bar. Observations O1–O4 from the review are
intentionally **out of scope** (they are honest known-gaps, not defects).

## Findings being resolved

| ID | Severity | Summary |
|----|----------|---------|
| F1 | Medium | `bun run check` fails: 35 biome format + import-sort errors. CI gate `npm test` would fail. All cosmetic, auto-fixable. |
| F2 | Low | `workflow-manager.ts` correlates start↔end agent events by `label`; duplicate user-supplied labels in `parallel()` misattach results. |
| F3 | Low | `_isAbortError` in `workflow-tool.ts` is dead code (`errors.ts` already exports `isAbortError`). |
| F4 | Low | `resolveWorkflowToolDefaults` reads settings from disk even when `options.manager` is supplied. |

## Goal

- `bun run check` is green (F1).
- Live snapshot agent entries always correlate to the correct invocation,
  independent of label uniqueness (F2).
- No dead code, no redundant disk reads (F3, F4).
- All existing tests pass; F2 gains a regression test.
- No behavior change to any public/tool contract beyond the event-shape
  addition in F2 (additive, backward-compatible).

## Non-goals

- Changing the labeling policy (duplicate labels remain legal; they just match
  correctly now).
- Addressing O1–O4 (vm-security footnote, cross-session pack-run redelivery
  gap, the 3 documented quality-pattern todo tests, soft budget semantics).
- Any change to the `workflow`/`subagent`/`workflow_control` tool schemas.

---

## F1 — Restore the biome gate (mechanical)

**Root cause:** commit `d8271917` landed formatting/import-order drift across
15 src/extension files + test files without running the formatter.

**Fix:** one command.

```bash
bunx biome check --write .   # = format + lint --write + organize imports
```

**Scope of change:** pure formatting + import reordering. Zero logic touched.
After it, `bun run check` must exit 0.

**Commit isolation:** F1 is its own commit — a large mechanical diff that is
easy to review only when it is NOT interleaved with logic changes.

---

## F2 — Correlate workflow agent events by `callIndex` (the one design change)

### Problem

`workflow-manager.ts` executes `runWorkflow` with these handlers:

```ts
// onAgentEnd (line ~460) and onAgentHistory (line ~476)
const agent = [...managed.snapshot.agents]
  .reverse()
  .find((a) => a.label === event.label && a.status === "running");
```

If a workflow runs `parallel()` agents that share a `label` (the guidelines
*recommend* unique labels but do not enforce it), the `reverse().find(...)`
attaches each end-event to "the last running entry with that label" — order
dependent and possibly the wrong one.

### Design: thread the deterministic `callIndex` through the events

`callIndex = state.callSeq++` is already computed in `workflow.ts` (`agent()`)
and `call-global.ts` (`call()`). It is:

- **unique** per lexical call within a run,
- **stable across resume** (same lexical call → same `callIndex` → replays the
  same journal entry),
- already the journal key, so it is the natural identity of an agent invocation.

We add `callIndex: number` to the three agent-event types and fire it at every
site; the manager stores it on the snapshot entry and matches by it.

### Changes

**`src/workflow.ts`** — event type definitions (`onAgentStart` / `onAgentEnd`
/ `onAgentHistory` around lines 111–123): add `callIndex: number` to each
event payload. Pass `callIndex` at every fire site in `agent()`:

- cached-replay path: the `onAgentStart` + `onAgentEnd` pair (no-op, 0 tokens).
- live path: `onAgentStart` (inside the limiter), `onAgentEnd` (success), and
  `onAgentEnd` (error/recoverable-exhaustion).

**`src/call-global.ts`** — `AgentStartEventLike` / `AgentEndEventLike` gain
`callIndex: number`. Pass the already-computed `callIndex` at the 4 fire sites
(cached start+end, live start+end). `call()` already computes
`callIndex = deps.state.callSeq++`.

**`src/workflow-manager.ts`** —
- on `onAgentStart`: store `callIndex: event.callIndex` on the pushed snapshot
  entry.
- on `onAgentEnd` (line ~460) and `onAgentHistory` (line ~476): match by
  `a.callIndex === event.callIndex && a.status === "running"` instead of label.

**`src/display.ts`** — add `callIndex?: number` to `WorkflowAgentSnapshot`
(the snapshot entry type) so the new field is typed.

**Backward compatibility:** `workflow-pack.ts`'s `onAgentEnd`
(line 418, CLI streaming) is a separate callback that does **not** do label
matching — the extra `callIndex` field is simply ignored. No consumer breaks.

### Test plan (F2)

1. **Update existing assertions** that construct/inspect agent events or
   snapshot entries to include `callIndex` where relevant
   (`workflow-manager.test.ts`, and any test doubling the event shapes).
2. **New regression test** in `tests/workflow-manager.test.ts` (or a dedicated
   `regression-duplicate-label.test.ts`): run a workflow whose `parallel()`
   thunks all pass the **same** `label`; assert each end-event attaches its
   result to the entry that its start-event created (results ↔ entries paired
   by callIndex, not jumbled). Use a stub agent runner returning a per-call
   distinct value so mis-matching is detectable.

### Why not the alternatives

- **New runtime-unique `agentId`** (Approach B): adds a concept that exists
  only for correlation; `callIndex` already does the job. YAGNI violation.
- **Start-returns-token handshake** (Approach C): most invasive, hardest to
  test, fights the fire-and-forget event model.

---

## F3 — Remove dead code

Delete `_isAbortError` at `src/workflow-tool.ts:~746` (defined, never called;
`errors.ts` exports the canonical `isAbortError`). Trivial; folded into the
F3+F4 cleanup commit.

## F4 — Skip the redundant settings disk read

In `createWorkflowTool` (`src/workflow-tool.ts:358–359`):

```ts
const defaults = resolveWorkflowToolDefaults(options, cwd);          // always reads disk
const manager = options.manager ?? new WorkflowManager({ /* uses defaults */ });
```

When the extension supplies `options.manager` (the normal path), `defaults` is
computed but never used. Guard it:

```ts
const manager =
  options.manager ??
  (() => {
    const defaults = resolveWorkflowToolDefaults(options, cwd);
    return new WorkflowManager({ /* uses defaults */ });
  })();
```

(Lazy compute only on the fallback branch.) Behavior unchanged; one disk read
removed per tool construction on the hot path.

---

## Commit plan

1. **`style(pi-agent-ext-workflow): biome format + import sort`** — F1 only.
   `bunx biome check --write .`, no logic. Verify `bun run check` exits 0.
2. **`refactor(pi-agent-ext-workflow): correlate workflow agents by callIndex`**
   — F2: the four-file change (`workflow.ts`, `call-global.ts`,
   `workflow-manager.ts`, `display.ts`) + updated assertions + the new
   duplicate-label regression test. Verify `bun run build` + `bun run test:unit`.
3. **`chore(pi-agent-ext-workflow): drop dead code, skip redundant settings read`**
   — F3 + F4. Verify full `bun run test`.

Each commit independently passes `bun run check && bun run build && bun run test:unit`.

## Verification bar (definition of done)

- `bun run check` → exit 0 (was: 35 errors).
- `bun run build` (tsc) → exit 0 (already green; must stay green).
- `bun run test:unit` → all pass (was: 1137 pass / 0 fail / 3 todo); the 3 todo
  tests are unrelated and stay todo.
- New F2 regression test passes and fails on the pre-fix code (proves it guards
  the regression).
- `git diff` for commits 2 and 3 contains no formatting noise (F1 absorbed it
  all in commit 1).

## Risk

- **Low.** F1 is mechanical. F3/F4 are trivial. F2 is additive on event
  shapes (extra field) with exactly two matching sites to update, both covered
  by existing + new tests.
- The only contract surface that changes is an **internal** event shape
  (`WorkflowRunOptions.onAgent*`), consumed only within this package.
