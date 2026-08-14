# Task 6 Report — Running-header aggregate + `runningUsage` map + `onUpdate` rewrite

**Package:** `bun-apps/pi-agent-ext-subagent`
**Branch:** `feat/improve-subagents-batch-tui`
**Base:** `175ba299` → **Head:** `61fda72c`
**Commit:** `61fda72c feat(subagent): batch-tui running-header aggregate + runningUsage + onUpdate rewrite (T6)`

## What changed

Three edits in `src/subagents-tool.ts` (inside `createSubagentsTool().execute()`), transcribed verbatim from the brief:

### 1. `runningUsage` map declared in `execute()`
Declared next to the other batch state (`acc`, `gateTripped`):

```ts
const acc = { tokens: { total: 0 }, cost: 0 };
// Per-child final usage, captured via the additive onUsage callback
// (fires once at each child's completion). Feeds the running (live)
// header's Σtok/$Σ. NOTE: onUsage is completion-triggered, so the Σ is
// "sum over children completed so far" — not a per-token live ticker.
const runningUsage = new Map<string, AgentUsage>();
```

**🔴 T1 advisory — last-write-wins `set`, NOT accumulate (CONFIRMED CORRECT).**
The wiring below uses `runningUsage.set(childRunId, u)` (overwrite), exactly as the
Task-1 reviewer flagged. `onUsage` may fire MORE THAN ONCE per runId (once per retry
attempt) and each fire delivers the CUMULATIVE `AgentUsage` for that run, so accumulating
across fires (e.g. `get(runId) + add(u)`) would DOUBLE-COUNT on retry. `set` is correct
because each payload is already cumulative. The code does NOT accumulate.

### 2. `onUsage` wired in `dispatchChild`'s `childSpawnOpts`
Added alongside `onModelResolved` / `onModelFallback` / `onHistory`:

```ts
onUsage: (u) => {
  runningUsage.set(childRunId, u);
},
```

Keyed by `childRunId` (`${toolCallId}:${index}`) — the same id used in
`inFlight.start({ id: childRunId, … })`.

### 3. `onHistory` closure's `onUpdate` text rewritten (multi-line)
Replaced the old single-line `latest:` block. The new text is a **header line + live
table (multi-line)**:

```ts
try {
  const group = (options.inFlight?.list() ?? []).filter((e) => e.batchId === toolCallId);
  const running = group.filter((e) => e.status !== "completed").length;
  const total = params.tasks.length;
  const agg = sumUsage(runningUsage.values());
  const aggStr = agg.total > 0 ? ` · ${agg.total} tok · $${agg.cost.toFixed(3)}` : "";
  const header = `subagents · ${running}/${total} running${aggStr}`;
  const table = buildLiveTable(group);
  const text = table ? `${header}\n${table}` : header;
  onUpdate?.({
    content: [{ type: "text" as const, text }],
    details: undefined as never,
  });
} catch {
  // swallowed — onUpdate is diagnostic only (mirrors the singular tool)
}
```

**Running header confirmed:** `subagents · ${running}/${total} running${aggStr}` where
`aggStr = " · Σtok · $Σ"` — tokens FIRST (`${agg.total} tok · $${agg.cost.toFixed(3)}`),
omitted when zero. This is the **`Σtok · $Σ` order** for the RUNNING header (decision #6),
which DIFFERS from the done header's `$Σ · Σtok`. The order was transcribed exactly from
the brief and not swapped. Single-space ` · ` separators (consistent with T3/T4/T5).

The body is `buildLiveTable(group)` (Task 5); when the table is empty the header is
emitted alone. The whole block stays **try/caught** (diagnostic only) — verified by an
explicit throwing-`list()` test. The existing `renderSubagentsResult` `isPartial` branch
(`text.split("\n")[0]` collapsed vs full expanded) is unchanged and still handles both
the header-only and header+table forms.

No regressions: the done-collapsed (T3) and done-expanded (T4) render paths are
untouched. `summarizeLatestAction`, `truncateToWidth`, `taskPreview` remain used
elsewhere (buildLiveTable / dispatchChild / renderSubagentsCall) — no unused-import fallout.

## Tests (`tests/subagents-tool.test.ts`)

**Existing test UPDATED (not deleted/weakened).** The old
`"onUpdate emits a single-line 'k/N running · latest' as children progress"` was
replaced by `"onUpdate emits a multi-line header + live table: \`subagents · k/N
running · Σtok · $Σ\` then one row per child"`. The new contract asserts:
- header matches `/^subagents · \d+\/2 running/`,
- header carries the Σ aggregate with tokens FIRST (`/500 tok · \$0\.050/`),
- the old `latest:` label is GONE from the header,
- the multi-line body includes the `[0]` live-table row.

**Two new tests added:**
1. `"runningUsage map is fed by onUsage and drives the live-header Σ across children"`
   — asserts `/3000 tok · \$0\.300/` aggregates across both children's `onUsage`.
2. `"onUpdate is try/caught: a throwing buildLiveTable path never fails the child"`
   — sabotages `inFlight.list` to throw; asserts the child still completes `done`.

### ⚠ Brief defect fixed (faithful, non-weakening) in test #1 above
As transcribed verbatim, that test's `spawn` had type `{ task; onUsage? }` and **never
fired `onHistory`**. Since `onUpdate` only emits from inside the `onHistory` closure,
`headers` stayed empty → the assertion failed with `actual: ""` (verified: 60 pass / 1
fail). The live header can only be observed via an `onHistory→onUpdate` tick. The
minimal faithful fix was to add `onHistory?: (h: { kind: string }[]) => void` to that
spawn's type and fire one tick (`read` toolCall) after `onUsage`, so the header
actually emits. The test's real assertion (`/3000 tok · \$0\.300/` Σ across both
children via the live header) is unchanged — this only wires the observation path the
brief intended. Documented here per the "fix only transcription errors" rule; no
implementation changed.

## Verification

| Step | Command | Result |
| --- | --- | --- |
| Run-to-fail (post-impl, pre test-fix) | `bun test tests/subagents-tool.test.ts` | 60 pass / **1 fail** (empty-header, brief test-harness gap — see above) |
| Test pass | `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )` | **61 pass / 0 fail** |
| Format | `bun run format` | Fixed 1 file (test file reflow) |
| Gate — check | `bun run check` (biome check .) | **clean** |
| Gate — build | `bun run build` (bunx tsc) | **clean** |
| Gate — full tests | `bun test` | **505 pass / 0 fail** (31 files, 144 expect() calls) |

## Commit discipline
- Staged ONLY the two source files explicitly
  (`git add bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts`);
  no `git add -A`.
- `.planning/` NOT committed (left untracked).

## Commit SHAs
- Base: `175ba299` (chore(sdd): batch-tui T5 audit trail)
- Head: `61fda72c` (feat(subagent): batch-tui running-header aggregate + runningUsage + onUpdate rewrite (T6))

## Self-review against the load-bearing invariants
- ✅ `runningUsage` declared in `execute()`, keyed by `childRunId`.
- ✅ `onUsage` uses **last-write-wins `set`** (not accumulate) — T1 retry-fanout advisory satisfied.
- ✅ Running header order is **`Σtok · $Σ`** (tokens first), transcribed exactly, not swapped.
- ✅ `onUpdate` rewrite is multi-line: header + `buildLiveTable` rows; empty table → header-only.
- ✅ Existing single-line `onUpdate` test UPDATED to the multi-line contract (not deleted/weakened).
- ✅ Σ aggregates over `runningUsage.values()` via `sumUsage`.
- ✅ Single-space ` · ` separators; try/caught preserved (throwing-list test passes).
- ✅ Done-collapsed (T3) + done-expanded (T4) paths untouched — all their tests green.
