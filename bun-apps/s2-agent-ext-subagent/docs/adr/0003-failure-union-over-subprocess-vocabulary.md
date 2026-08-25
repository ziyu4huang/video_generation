**ID:** `ADR-subagent-0003` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# 0003 — `SpawnSubagentResult` reports a failure union, not a subprocess exit

**Status:** accepted
**Date:** 2026-08-15
**Supersedes nothing. Amends the result contract introduced with `spawnSubagent`.**

## Context

`spawnSubagent` was introduced as a drop-in replacement for pi-obsidian's
child-process `runSubagentWithRetry`, and it deliberately copied that function's
return shape — `{ output, exitCode, stderr, timedOut }` — so callers could migrate
by changing one line. That was the right call at the time.

The runner it describes, however, is `WorkflowAgent` → `createAgentSession()`.
There is no process, no exit code, and no standard error stream. Three costs had
accumulated:

1. **The numeric range was dead information.** The producer emitted exactly three
   values: `0`, `124` (the GNU `timeout(1)` convention) and `1`. A monorepo-wide
   search found no reader of `124` — only the producer and two test fixtures that
   copied it. Every consumer tested `exitCode === 0` and nothing else. Worse, a
   budget abort was written as `exitCode: 1`, indistinguishable by code alone from
   a plain failure, while its `status` said `budget`.

2. **Callers had to correlate five fields.** Answering "how did this run go?"
   meant reading `exitCode`, `stderr`, `timedOut`, `budget` and `turns` together
   in a specific precedence order. `deriveSubagentStatus` existed solely to do
   that for callers, and its precedence chain duplicated `classifyError`'s branch
   order — two places to keep aligned by hand.

3. **The vocabulary reached the model.** `formatSubagentResult` rendered the
   literal string `Subagent failed (exit 1).` into the parent agent's tool result.

Peers paid for it too: because `stderr` could be empty on a real failure, each
one carried a fallback synthesising prose from the meaningless number
(`` `runner exited (code ${result.exitCode})` ``).

## Decision

`SpawnSubagentResult` becomes `{ output, failure?, usage?, budgetWarning? }`,
where `failure` is a discriminated union:

```ts
type SubagentFailure =
  | { kind: "failed";   message: string }
  | { kind: "timedout"; message: string }
  | { kind: "turns";    message: string; turns:  TurnExhaustion }
  | { kind: "budget";   message: string; budget: BudgetExhaustion };
```

Absent `failure` means the run succeeded. `failure.kind` **is** the status, so
`deriveSubagentStatus` is deleted and its three call sites read
`result.failure?.kind ?? "done"`. The precedence rule now lives only in
`classifyError`'s branch order, pinned case-by-case in
`tests/failure-union.test.ts`.

Every variant carries `message`, so a caller that only wants to report the
failure never switches on `kind` — which is what removes the peers' fallbacks.

`aborted` is deliberately not a variant: a user abort is knowledge the parent
turn holds, not the spawn, and is derived in `child-dispatch.ts`.

### The subprocess adapter

`spawnSubagentSubprocess` genuinely spawns `pi -p --mode json` and returns the
same type. Two adapters satisfying one interface makes this a real seam, so the
interface has to be honest for both: the real process exit code folds into
`failure.message` (`pi exited with code 3: …`) rather than widening the shared
interface. Nothing read it — `isTransientError`'s only use of the number was
`exitCode === 0`, which `!failure` already encodes — so no information a consumer
reads is lost. `isTransientError` correspondingly drops its second parameter.

### The serialized surfaces

`SubagentRunRecord` and `SubagentToolDetails` already carried a `status`
discriminant, next to which `exitCode` and `timedOut` were derivable duplicates.
Both are dropped; `stderr` (which carried real information) becomes `error`.

A read-time shim in `subagent-run-persistence.ts` maps a legacy record's `stderr`
to `error` so the ~200 records already on disk keep rendering unchanged in
`/subagents`. The dropped keys need no handling — an extra key on a parsed object
is inert.

## Consequences

- Eight result fields become four; the tool-result text the model reads no longer
  claims an exit code that never existed.
- A latent bug surfaced and was fixed: `retry-loop-detector.ts`'s `failureClass`
  took a structural `{ status: string; stderr?: string }`. Renaming the record
  field would have passed `tsc` while silently collapsing every failure into one
  bucket (`"failed:"`), tripping the circuit breaker on tasks that never looped.
  The parameter now reads `error` and a test pins the field name.
- ~340 lines of four-field fixture literals collapse into `tests/_spawn-result.ts`
  builders, so the next shape change is cheap.
- Old on-disk records keep working; new ones no longer carry the dead keys.

## Alternatives considered

- **Flat `ok: boolean` + `error: string`.** Honest and mechanical, but leaves
  `timedOut`/`budget`/`turns` scattered and keeps `deriveSubagentStatus` alive —
  it buys naming, not depth.
- **Rename only (`exitCode` → `status: number`).** Preserves the dead numeric
  range and the five-field correlation: the full migration cost with none of the
  benefit.
- **Separate result types per adapter.** Most literally honest, but it breaks the
  property that a caller can swap `spawnSubagent` ↔ `spawnSubagentSubprocess`,
  which obsidian and tool-gate rely on.
