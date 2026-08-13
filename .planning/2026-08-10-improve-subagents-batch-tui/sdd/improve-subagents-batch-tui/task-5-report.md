# Task 5 Report — `buildLiveTable` pure live-row builder (T5)

**Branch:** `feat/improve-subagents-batch-tui`
**Base:** `236a6478` → **Head:** `e428a64e`
**Commit:** `e428a64e feat(subagent): batch-tui buildLiveTable pure live-row builder (T5)`

## Files changed (2, staged explicitly — `.planning/` NOT committed)
- `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (+43/-2)
- `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts` (+80/-2)

## What was added

Two PURE helpers placed immediately after `formatSlotMeta` (and before
`sumUsage`), exactly where the brief placed them:

### `childDispatchIndex(id: string): number`
```ts
export function childDispatchIndex(id: string): number {
  const idx = Number(id.slice(id.lastIndexOf(":") + 1));
  return Number.isFinite(idx) ? idx : NaN;
}
```
Extracts the trailing `:N` dispatch index from a batch child runId
(`${batchId}:${index}`). `NaN` for ids without a numeric suffix → sorts last.

### `buildLiveTable(entries: InFlightSubagent[], now: number = Date.now()): string`
```ts
export function buildLiveTable(entries: InFlightSubagent[], now: number = Date.now()): string {
  const sorted = [...entries].sort((a, b) => {
    const ia = childDispatchIndex(a.id);
    const ib = childDispatchIndex(b.id);
    return (Number.isNaN(ia) ? Infinity : ia) - (Number.isNaN(ib) ? Infinity : ib);
  });
  const rows = sorted.map((e) => {
    const idx = childDispatchIndex(e.id);
    const idxLabel = Number.isNaN(idx) ? "?" : String(idx);
    const slot = formatModelSeg(e.resolvedModel ?? e.model ?? "default", e.requestedModel, e.fellBack);
    const glyph = e.status === "completed" ? "✓" : "⏱";
    const elapsed = `${((now - e.startedAt) / 1000).toFixed(1)}s`;
    const action = summarizeLatestAction(e.history) ?? truncateToWidth(e.taskPreview ?? e.workIntent ?? "", 40);
    return `[${idxLabel}] ${slot} ${glyph} ${elapsed} · ${action}`;
  });
  return rows.join("\n");
}
```

## Row format
```
[i] slot ⏱/✓ liveElapsed · currentAction
```
- `[i]` — dispatch index from `childDispatchIndex(id)`; `?` when `NaN`.
- `slot` — `formatModelSeg(resolvedModel ?? model ?? "default", requestedModel, fellBack)` (fallback-aware; on fallback renders `requested → actual` shortModel-ed).
- glyph `⏱` while `status !== "completed"`, `✓` once completed.
- `liveElapsed` — `((now - startedAt)/1000).toFixed(1)s`.
- `currentAction` — `summarizeLatestAction(history)`, falling back to `truncateToWidth(taskPreview ?? workIntent ?? "", 40)`.
- Separator: single-space ` · ` (consistent with T3/T4 + spec + single-card ref).
- Empty input → `""` (header-only, per spec error-handling).

## Dispatch-index sorting
Ascending by `childDispatchIndex(id)`; `NaN` indices map to `Infinity` in the
comparator so non-numeric ids sort last (stable). The sort operates on a
shallow copy (`[...entries]`) so the input array is not mutated.

## Load-bearing decisions (as implemented)
- **Decision #3 — no caller tag on live rows:** the live row OMITS the `(id)`
  caller tag. `InFlightSubagent` has no caller-tag field and threading one is a
  core-runtime change that is OUT OF SCOPE. Done rows keep `(id)` via
  `slot.id`, but live rows do not. No caller-tag field was added.
- **Decision #4 — `(now)` not `(theme)`:** `buildLiveTable(entries, now)`
  takes a `now` timestamp for the live elapsed (default `Date.now()`), NOT a
  `Theme`. The helper emits PLAIN text; `execute()` receives no Theme, and the
  live text is themed-as-dim later by the existing `isPartial` render branch of
  `renderSubagentsResult` (Task 6 wires that). The helper neither takes nor
  applies a theme.

These are PURE helpers — no I/O, no side effects, no render-path wiring.
Task 6 wires `buildLiveTable` into the running (isPartial) state.

## Import plumbing (source)
`InFlightSubagent` added to the existing `@repo/pi-agent-ext-core-runtime`
type-import line (now multi-line, 4 names) — it is exported from the same
module as `SubagentInFlightRegistry` (verified: `index.ts` line 92).
`formatModelSeg`, `summarizeLatestAction`, and `truncateToWidth` were already
imported/defined in the file — reused as-is.

## Tests (7 new, all green)
1. `childDispatchIndex: trailing :N from a batch child runId; NaN-resistant`
2. `buildLiveTable: empty entries → empty string (header-only)`
3. `buildLiveTable: one running child → [i] slot ⏱ liveElapsed · currentAction`
4. `buildLiveTable: completed child shows ✓ glyph + the same meta`
5. `buildLiveTable: fallback child shows requested → actual slot`
6. `buildLiveTable: currentAction from summarizeLatestAction(history); falls back to task preview`
7. `buildLiveTable: sorted ascending by dispatch index; defaults to Date.now()`

The brief's snippet placed the test imports as a mid-file block (relative
path before external). To satisfy biome `organizeImports` without keeping an
awkward mid-file duplicate, the two symbols were merged into the test file's
existing top-of-file import blocks instead (`InFlightSubagent` into the
existing `import type { AgentUsage }` line; `buildLiveTable, childDispatchIndex`
into the existing `import { clampConcurrency, … } from "../src/subagents-tool.js"`
block, alphabetically first). Test bodies are verbatim from the brief.

## Gate / test commands + results
| Command | Result |
|---|---|
| `( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )` | **PASS** — 59 pass / 0 fail (7 new) |
| `( cd bun-apps/pi-agent-ext-subagent && bun test )` | **PASS** — 503 pass / 0 fail (whole package) |
| `( cd bun-apps/pi-agent-ext-subagent && bun run check )` | **PASS** — biome, 60 files, no fixes applied |
| `( cd bun-apps/pi-agent-ext-subagent && bun run build )` | **PASS** — `bunx tsc`, no errors |

## Commit SHAs
- Base: `236a6478`
- Head: `e428a64e`
