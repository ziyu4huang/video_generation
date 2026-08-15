# SpawnSubagentResult: a failure union instead of subprocess vocabulary

**Date:** 2026-08-15
**Package:** `bun-apps/pi-agent-ext-subagent` (+ 4 peer consumers)
**Status:** approved, ready for implementation

## Problem

`SpawnSubagentResult` reports the outcome of an **in-process** subagent run using
**subprocess** vocabulary — `exitCode: number` and `stderr: string`. The names were
chosen deliberately (the type was built to mirror pi-obsidian's child-process
`runSubagentWithRetry` so callers could swap one line), but the runner they now
describe is `WorkflowAgent` → `createAgentSession()`, which has no process, no exit
code, and no standard error stream.

Three concrete costs:

1. **The numeric range is dead information.** The in-process producer emits exactly
   three values — `0` on success, `124` on timeout/turns-exhaustion, `1` otherwise.
   `124` is the GNU `timeout(1)` convention. A monorepo-wide search found **no reader
   of `124`**: it appears only at the producer and in two test fixtures that copy it.
   Every consumer asks the same single question, `exitCode === 0`.

2. **The interface is shallow — callers must correlate five fields.** Answering
   "how did this run go?" requires reading `exitCode`, `stderr`, `timedOut`, `budget`
   and `turns` together, in a specific precedence order. The existence of
   `deriveSubagentStatus(r)` is the evidence: a helper exists solely to do for callers
   what the type should answer directly. That precedence order is duplicated — once in
   `classifyError`'s branch order, once in `deriveSubagentStatus`.

3. **The vocabulary reaches the model.** `formatSubagentResult` renders the literal
   string `Subagent failed (exit 1).` into the text the parent agent reads.

Peer consumers pay for the dishonesty too. Because `stderr` may be empty on a real
failure, every peer carries a fallback that synthesises prose from the meaningless
number:

```ts
const detail = result.stderr?.trim().slice(0, 200) || `runner exited (code ${result.exitCode})`;
```

## Non-problem: the subprocess path is real

`src/spawn-subagent-subprocess.ts` genuinely spawns `pi -p --mode json` via
`node:child_process` for callers that need process isolation (obsidian's Zettelkasten
distill/garden, tool-gate's L2 A/B). It returns the **same** `SpawnSubagentResult`.
There, `exitCode` and `stderr` are literally true.

So this is not "replace subprocess vocabulary with in-process vocabulary" — that would
merely move the lie to the other adapter. Two adapters satisfy one interface, which
makes this a real seam. The interface must be the honest common shape; adapter-specific
detail either becomes diagnostic-optional or folds into the message.

## Design

### The result type

```ts
/** Absent = the run succeeded. Every variant carries `message`, so a caller that
 *  only wants "what went wrong" never has to switch on `kind`. */
export type SubagentFailure =
  | { kind: "failed";   message: string }
  | { kind: "timedout"; message: string }
  | { kind: "turns";    message: string; turns:  TurnExhaustion }
  | { kind: "budget";   message: string; budget: BudgetExhaustion };

export interface SpawnSubagentResult {
  output: string;
  failure?: SubagentFailure;
  usage?: AgentUsage;
  /** Completed-run 80% advisory. Stays top-level — it is NOT a failure. */
  budgetWarning?: BudgetWarning;
}
```

Removed: `exitCode`, `stderr`, `timedOut`, `budget`, `turns`. Eight fields become four.

`"aborted"` is deliberately **not** a variant. It is derived in `child-dispatch.ts`
from `userAborted`, which is knowledge the spawn result does not and should not have.
The union has four kinds; `SubagentRunStatus` keeps its six (`done` + the four +
`aborted`).

The `turns` and `budget` variants require their detail object to be present. This
preserves current behaviour exactly: `classifyError` may classify a
`TOKEN_BUDGET_EXHAUSTED` error with `details` undefined, and today
`deriveSubagentStatus` returns `"failed"` for that case because `r.budget` is unset.
Presence of the detail is what selects the kind, before and after.

### `deriveSubagentStatus` is deleted

```ts
// before — four lines correlating four fields under an implicit precedence
if (r.budget) return "budget";
if (r.turns)  return "turns";
if (r.exitCode === 0) return "done";
return r.timedOut ? "timedout" : "failed";

// after
r.failure?.kind ?? "done"
```

The precedence (budget > turns > timedout > failed) now lives in exactly one place:
`classifyError`'s branch order. **This is the only behavioural risk in the change**
and gets a dedicated test that walks every `WorkflowErrorCode` and asserts the
resulting `failure.kind`.

### The real subprocess exit code

Folded into the message: `pi exited with code 3: <stderr tail>`. It does not enter the
interface. The monorepo's only reader was `isTransientError(stderr, exitCode)`, whose
use of the number is `if (exitCode === 0) return false` — a test the union already
encodes as `!failure`. No information a consumer reads is lost.

### The two serialized surfaces

Both `SubagentRunRecord` (200 JSON files under `~/.pi/subagents/runs/`) and
`SubagentToolDetails` (persisted into session history) already carry a proper
`status` discriminant. Alongside it, `exitCode` and `timedOut` are **derivable
duplicates**.

```
- exitCode: number      // derivable from status — dropped
- timedOut: boolean     // derivable from status — dropped
- stderr?: string       // carries real information — renamed
+ error?: string
  status                // already present, unchanged
```

A read-time shim at the two `JSON.parse` sites in `subagent-run-persistence.ts` keeps
the 200 existing records rendering unchanged in `/subagents`:

```ts
function migrateLegacyRecord(raw: unknown): SubagentRunRecord {
  const r = raw as Record<string, unknown>;
  if (r.error === undefined && typeof r.stderr === "string") r.error = r.stderr;
  return r as unknown as SubagentRunRecord;
}
```

The shim is pinned by a test using a real pre-migration record as a fixture.

### Test fixtures

Roughly 340 of the 442 touched lines are fixture literals of the form
`{ output: "x", exitCode: 0, stderr: "", timedOut: false }`, concentrated in
`subagent-tool.test.ts` (189) and `subagents-tool.test.ts` (75). These are replaced
with two helpers — `okResult(output?)` and `failResult(kind, message, detail?)` —
rather than hand-converted one by one. This makes the next shape change nearly free
and removes the largest source of copy-paste drift in the package.

## Blast radius

442 lines across 27 files in 6 packages (excluding `dist/`).

| Area | Files | Lines |
|---|---|---|
| `pi-agent-ext-subagent` src | 8 | ~55 |
| `pi-agent-ext-subagent` tests | 8 | ~275 |
| `pi-agent-ext-hermes-memory` | 8 | ~35 |
| `pi-agent-ext-knowledge-card` | 1 | 20 |
| `pi-agent-ext-obsidian` | 1 | 3 |
| `pi-agent-ext-file2md` | 2 | ~6 |

**Single PR.** Staging was considered and rejected: the producer change and the
consumer changes are type-incompatible, so any split leaves `main` red between PRs.
The mitigation for the large diff is procedural, per the lesson recorded from PR #1340
— stage rebase conflict resolutions by explicit path only, never `git add -A`, and run
a file-by-file branch-vs-main audit before merging.

## Verification

- TDD throughout: every new invariant observed RED before GREEN.
- A test walking every `WorkflowErrorCode` → asserted `failure.kind`, replacing the
  precedence order that `deriveSubagentStatus` used to hold.
- A legacy-record fixture proving the read shim populates `error` from `stderr`.
- A test proving `budgetWarning` on a completed run does not produce a `failure`.
- `regression-subagent-contract.test.ts` is the existing contract test and is expected
  to be the primary RED source.
- Per-package canonical `bun run test` for all six packages, then `ci-local.sh`
  (`--gates` and the matrix) before merge.
- New `ADR-subagent-0003` recording the interface change and the decision to drop
  `exitCode` from the on-disk format.

## Out of scope

- The `subagent`/`subagents` tool parameter schemas (input side) are untouched.
- `pi-agent-ext-obsidian`'s own `runSubagentWithRetry` (`src/lib/subagent.ts`) keeps
  its subprocess shape; only its call into `spawnSubagent` is adapted.
