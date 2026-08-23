# subagents per-child mid-flight abort — plan

> Executes `spec.md`. 3 TDD tasks, dependency-ordered: registry+lever (T1) →
> batch tool (T2, depends on T1's `abort` + `aborted` status) → viewer+reconstruct
> (T3, depends on `aborted` status existing in details/slots). Each task is
> RED → GREEN → REFACTOR with explicit verification.

## Pre-flight (once)

- Branch `subagents-parent-live-visibility` off `origin/main @ 9cd9371b`.
- `cd bun-apps && bun install` only if needed (no new deps expected).
- Test single command: `( cd bun-apps/pi-agent-ext-subagent && bun test )`.

---

## Task 1 — in-flight abort lever + singular tool detection

**RED — `tests/subagent-in-flight.test.ts`**
- `registry.abort(id)` calls the entry's `abort` lever; no-op when the id is
  unknown / already `end()`ed (mirrors `update()`). Does **not** remove the
  entry (distinct from `end()`).

**RED — `tests/subagent-tool.test.ts`**
- Inject a fake `spawn` that resolves on a per-child `AbortController`'s abort
  (spawn opts carry `externalSignal`): simulate (a) user abort — abort the
  child controller only; (b) whole-turn — abort the parent `signal`; (c)
  timeout — resolve the spawn with `{exitCode:124,timedOut:true}` without
  touching the controller.
  - (a) → `details.status === "aborted"`, content text `"Subagent aborted by
    user."`, and the in-flight entry's `abort` lever was wired (spy).
  - (b) → `details.status === "timedout"` (unchanged), text contains "timed out".
  - (c) → `details.status === "timedout"` (unchanged).
- `renderSubagentResult` with `status:"aborted"` renders an `aborted` badge;
  a snapshot of the existing done/failed/timedout/budget branches is
  byte-identical before/after.

**GREEN**
- `subagent-in-flight.ts`: `InFlightSubagent.abort?: () => void`;
  `abort(id: string): void { this.runs.get(id)?.abort?.(); }`.
- `subagent-tool.ts`: in `execute`, create `const childAc = new
  AbortController()`; fan-in `signal` (`if (signal.aborted) childAc.abort();
  else signal.addEventListener("abort",()=>childAc.abort(),{once:true})`);
  pass `externalSignal: childAc.signal`; pass `abort: () => childAc.abort()` to
  `inFlight.start`. After spawn: `const userAborted = childAc.signal.aborted &&
  !signal?.aborted`; if so → `status:"aborted"`, `output =
  "Subagent aborted by user."`. Widen `SubagentToolDetails.status` union;
  add `aborted` badge in `renderSubagentResult`.

**REFACTOR / VERIFY**
- `( cd bun-apps/pi-agent-ext-subagent && bun test subagent-in-flight subagent-tool )`
- `bunx tsc --noEmit` (package-local) clean.
- `cd bun-apps && bunx biome check pi-agent-ext-subagent/src` 0 errors.

---

## Task 2 — batch tool per-child abort + fan-in

**RED — `tests/subagents-tool.test.ts`**
- Fake `spawn` per child; abort one child's controller mid-batch, let siblings
  finish. Assertions:
  - aborted slot: `status:"aborted"`, `task`/`model`/`elapsedMs` present,
    output `""` is fine (the batch render shows the abort line).
  - sibling slots: `status:"done"` (unaffected).
  - `renderBatchResult` includes an `aborted` line for the aborted index;
    snapshot the done/failed/budget lines byte-identical.
- Fan-in: aborting the parent `signal` aborts **all** children (new behavior);
  fake spawn observes each child's `externalSignal` firing.

**GREEN**
- `subagents-tool.ts`: `execute` un-renames `_signal → signal`; in
  `dispatchChild`, create per-child `childAc`, fan-in `signal`, pass
  `externalSignal: childAc.signal`, register `abort` on the in-flight entry;
  after spawn detect `userAborted` and map the slot to `status:"aborted"`.
  Widen the `BatchResultSlot` done/timedout union to include `"aborted"`.
  `renderBatchResult` branch for `aborted`.

**REFACTOR / VERIFY**
- `( cd bun-apps/pi-agent-ext-subagent && bun test subagents-tool )`
- tsc + biome clean.

---

## Task 3 — viewer `x`+confirm + onAbort + reconstruct Completed badge

**RED — `tests/subagent-viewer.test.ts`**
- Construct viewer with `getRunning` returning one Running entry + an
  `onAbort` spy; drive `handleInput`:
  - cursor on the Running row + `x` → enters confirm state (a confirm footer
    line renders); `y` → `onAbort` called once with the id, confirm cleared.
  - `x` then `n` (and `x` then Esc) → `onAbort` NOT called, confirm cleared.
  - `x` on a Completed/batchHeader entry → no-op (no confirm).
  - `x` while a filter is active → no-op.
  - while in confirm state, `up`/`down`/`enter`/printable are ignored.
- Completed rendering: a reconstructed run with `status:"aborted"` (singular
  toolResult + a batch child slot) renders an `aborted` badge; singular
  done/failed entries byte-identical (regression pin).

**GREEN**
- `subagent-viewer.ts`: add `onAbort?` to the viewer options; add
  `confirmAbortId?: string` state; in the list branch, before the filter-input
  block, handle `x` (set confirm on a Running entry), and a confirm-resolution
  branch (`y`/`n`/Esc) that gates everything else while set. Render a
  `Abort this subagent? y/N` footer when set. Completed `aborted` badge in
  `renderList`/`renderActivityRow` path.
- `subagents-command.ts`: wire `onAbort: (id) => subagentInFlight.abort(id)`.
- `reconstructSubagentRuns`: carry `aborted` through for both `subagent` and
  `subagents` branches (additive — the singular path must stay byte-identical).

**REFACTOR / VERIFY**
- `( cd bun-apps/pi-agent-ext-subagent && bun test subagent-viewer subagents-command )`
- Full suite: `( cd bun-apps/pi-agent-ext-subagent && bun test )` — 0 failures.
- `cd bun-apps && bunx biome check pi-agent-ext-subagent` 0 errors; `bunx tsc
  --noEmit` clean.

---

## Land

- Commit per task (or one squash), push branch, open PR.
- CI: schema-cost canary + extension tests + biome. If biome flags
  organizeImports (bit me on #1008), fix and re-push.
- `await_pr_merge` (squash), auto-delete branch.
- Update `map.md` status → landed; close the effort.
