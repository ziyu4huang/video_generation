# Task 1 Report — Expose `onUsage` on `SpawnSubagentOptions` + forward to runner

**Effort:** improve-subagents-batch-tui · **Task:** 1 of 6 (label `zk-spawn`)
**Branch:** `feat/improve-subagents-batch-tui`

## What changed

### `bun-apps/pi-agent-ext-subagent/src/spawn-subagent.ts`

1. **Interface field (additive, optional, non-breaking).** Added `onUsage?: (u: AgentUsage) => void` to `SpawnSubagentOptions`, placed immediately after the existing `onHistory?` field (callback-field grouping preserved). `AgentUsage` was already imported from `@repo/pi-agent-ext-core-runtime` — no new import needed in the source. JSDoc notes it fires exactly once at run completion and that the internal `result.usage` capture is unchanged (both the live callback and the final result carry usage).

2. **Composed `onUsage` closure in `tryOnce`.** The existing internal closure (`onUsage: (u) => { usage = u; }`) was extended — NOT replaced — so a single callback is forwarded to `runner.run()` that both updates the internal `usage` capture AND invokes the caller's `opts.onUsage?.(u)`:

   ```ts
   onUsage: (u) => {
     usage = u;
     opts.onUsage?.(u);
   },
   ```

   This satisfies the two plan-time decisions: `onUsage` is exposed now, fires once at child completion (the runner reports usage in its completion/`finally` path), and the internal `result.usage` capture feeding the retry-merge logic is fully preserved.

### `bun-apps/pi-agent-ext-subagent/tests/spawn-subagent.test.ts`

1. **Import:** added `type AgentUsage` to the `@repo/pi-agent-ext-core-runtime` import (biome-sorted to the front, wrapped across lines).
2. **Two new tests** appended inside the top-level `describe("spawnSubagent", …)` block, immediately after the `"forwards tier/onModelResolved/onModelFallback to runner.run"` test:
   - `"forwards onUsage to the caller (fires once at run end) alongside the internal result.usage capture"` — asserts `opts.onUsage` fires exactly once, the caller receives the payload verbatim, AND `result.usage` capture still works.
   - `"onUsage is optional — omitting it changes nothing (result.usage still captured)"` — asserts omitting `onUsage` leaves `result.usage` intact.

## Test coverage

Test file: `bun-apps/pi-agent-ext-subagent/tests/spawn-subagent.test.ts`

| # | Test | New? |
|---|------|------|
| — | `"forwards onUsage to the caller …"` | ✅ new (T1) |
| — | `"onUsage is optional — omitting it …"` | ✅ new (T1) |
| (33 pre-existing) | full regression suite (model resolution, transient/budget retries, usage-sum-across-retry, abort paths, schema repair, resolveSessionOverride) | existing — all still green |

The pre-existing `"onUsage fires → result.usage carries the reported AgentUsage"` and `"usage is summed across a transient failure + retry"` tests guard the internal capture that this task composes onto — both still pass, proving the capture was not removed.

## Exact test command + output

```
( cd bun-apps/pi-agent-ext-subagent && bun test tests/spawn-subagent.test.ts )
```

- **Before impl (failing for the right reason):** 1 fail — `seen.length` 0 !== 1 at `opts.onUsage fires exactly once` (the caller's `onUsage` never fired because the internal closure did not forward it). The omitted-`onUsage` variant passed (internal capture worked).
- **After impl:** `35 pass / 0 fail` (33 baseline + 2 new). `Ran 35 tests across 1 file. [266ms]`.

## Pre-commit gate

```
( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )
```
- `bun run check` (biome check .): **clean** — `Checked 60 files in 28ms. No fixes applied.` exit 0.
  - Note: biome's safe auto-fix (import reorder: `type AgentUsage` first + multi-line wrap) was applied once via `bunx biome check --write tests/spawn-subagent.test.ts` before the final clean gate run.
- `bun run build` (`bunx tsc`): **clean** — no diagnostics. exit 0.

## Commits

- **`018ffb9a..e29bbe58`** — single commit on `feat/improve-subagents-batch-tui`:
  `feat(subagent): expose onUsage on SpawnSubagentOptions + forward to runner (batch-tui T1)`
  - 2 files changed, 38 insertions(+), 1 deletion(-) — exactly `src/spawn-subagent.ts` + `tests/spawn-subagent.test.ts`. No `.planning/` files staged (explicit `git add <path>`; controller commits the audit trail separately).

## Return-contract summary

- **Status:** DONE
- **Commits:** `018ffb9a..e29bbe58`
- **Tests:** `spawn-subagent.test.ts`: 35 pass / 0 fail (33 baseline + 2 new T1)
- **Gate:** `bun run check` + `bun run build`: clean (exit 0 / exit 0)
- **Concerns:** none
