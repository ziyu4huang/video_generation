# Task 3 Report — done header Σ + done-collapsed per-slot meta

**Branch:** `feat/improve-subagents-batch-tui`
**Base:** `bc20c87f` → **Head:** `c411f5d9`
**Files changed:**
- `bun-apps/pi-agent-ext-subagent/src/subagents-tool.ts` (`renderSubagentsResult` — header build + collapsed branch)
- `bun-apps/pi-agent-ext-subagent/tests/subagents-tool.test.ts` (6 new tests appended)

---

## 1. Header Σ change

In `renderSubagentsResult`, after computing `done`/`aborted`/`failed`, the header now
aggregates usage across non-null slots that carry a `usage` and appends a suffix:

```ts
const slotUsages: AgentUsage[] = [];
for (const s of d.results) {
  if (s && (s as { usage?: AgentUsage }).usage) slotUsages.push((s as { usage: AgentUsage }).usage);
}
const agg = sumUsage(slotUsages);
const aggStr = agg.total > 0 ? ` · $${agg.cost.toFixed(3)} · ${agg.total} tok` : "";
```

The header line gains `${aggStr}` after the elapsed seconds:

```
subagents batch (N ok · … failed · M skipped) — X.Xs · $Σ · Σtok
```

- **Σ-order is contractual (decision 6):** `$Σ · Σtok` (dollars first), matching the
  single subagent card.
- When **no** slot carries usage, `aggStr === ""` and the header is byte-identical to
  the pre-T3 form (`… — X.Xs`, no trailing suffix) — verified by the byte-stable test.

## 2. Collapsed per-slot line format

The `!options.expanded` branch now builds the per-slot meta via the T2 helper
`formatSlotMeta` (fallback-aware `requested → actual`, single-space ` · ` separators
internally) and appends a **quoted** task preview:

```ts
const meta = formatSlotMeta(slot, theme);
const taskPreview60 = truncateToWidth(slot.task ?? "", 60);
const idTag = slot.id ? `${theme.fg("dim", `(${slot.id})`)} ` : "";
lines.push(`  ${theme.fg("dim", `[${i}]`)} ${idTag}${badge}  ${meta} · ${theme.fg("dim", `"${taskPreview60}"`)}`);
```

Render-target cell (done-collapsed):

```
[i] (id) ✓ model · elapsed · $cost · Ntok · "task"
```

- The fixed-width `batchStatusBadge` (`✓ done` / `⊘ aborted` / `✗ failed`, padded to
  `BATCH_BADGE_WIDTH`) is unchanged.
- `formatSlotMeta` degrades to `model · elapsed` (no `$cost · Ntok`) when `usage` is
  absent — verified by the degrade test.
- The null-slot branch (`[i] ✗ failed  ·  (child failed)`) is unchanged.

## 3. Existing fixtures UPDATED — none needed updating

The brief anticipated that pre-existing DONE-collapsed render fixtures would need
their expected strings updated. **In practice, zero existing tests required changes.**
All 43 pre-existing tests in `subagents-tool.test.ts` stayed green untouched because
their assertions are loose (substring/regex `assert.match`), and:

- the meta segment text (`model`, `elapsed`, fallback `requested → actual`) is
  semantically identical (only the column separator inside the meta tightened from
  double-space `  ·  ` to single-space ` · `, courtesy of `formatSlotMeta`);
- the quoted task preview (`"task"`) is appended, not validated by existing assertions.

**No assertion was deleted or weakened.** Net: +6 new tests, 0 existing modified.

## 4. Transcription inconsistencies resolved (literal fixes only)

### 4a. Meta→task separator (single vs double space)
The brief's verbatim **impl** push line used a double-space separator:
`${meta}  ·  ${…task…}`. But the brief's own **degrade-test** regex and the
**render-target cell** both use single-space ` · ` across that boundary
(`/glm-5\.2 · 0\.5s · "t-aborted"/`, cell `Ntok · "task"`). With double-space the
degrade test cannot pass (regex whitespace is exact). Since the test + render-target
agree and `formatSlotMeta` is already single-space internally, the impl separator was
set to **single-space** `${meta} · ${…}`. This is a literal transcription fix to
satisfy the authoritative test+spec; no behavior beyond what the tests assert.

### 4b. Biome line-width wrap
The 6 appended tests' `renderSubagentsResult(...)` call lines exceed the repo's
biome `lineWidth: 120` (the `collapsed` var name is longer than the existing `out`
fixture at the same line). Applied `bunx biome check --write` to wrap those calls
across lines. **Formatting-only** — call args and all `assert.*` expressions are
byte-identical to the brief; biome also normalized two test-title string literals
containing `"` from double- to single-quote delimiters (cosmetic, no logic change).
The source file needed no reformatting.

## 5. Test command + result

```
( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagents-tool.test.ts )
```

- **Run-to-fail (pre-impl):** 4 of the 6 new tests failed as expected (header Σ,
  with-usage meta, fallback meta, degrade meta). The 2 byte-stable/no-usage cases
  already passed against the unchanged header.
- **Run-to-pass (post-impl):** **49 pass / 0 fail** (43 pre-existing + 6 new).

## 6. Gate result

```
( cd bun-apps/pi-agent-ext-subagent && bun run check && bun run build )
```

- `bun run check` (`biome check .`): **Checked 60 files. No fixes applied.** ✓
- `bun run build` (`bunx tsc`): clean, no errors. ✓

## 7. Commit

```
c411f5d9 feat(subagent): batch-tui done-header Σ + done-collapsed per-slot meta (T3)
```

- Staged **only** the two source files (explicit `git add <src> <test>`); `.planning/`
  left untracked and uncommitted per dispatch rules.
- 2 files changed, 146 insertions(+), 11 deletions(-).

## 8. Concerns

- **Brief self-inconsistency (§4a):** the verbatim impl push line and the verbatim
  degrade test disagreed on the meta→task separator spacing. Resolved toward the
  test + render-target (single-space). Flagging for the plan author in case the
  double-space was intentional (it was not testable as written).
- **Brief over-anticipated fixture churn (§3):** predicted existing DONE-collapsed
  fixtures would need updates; none did. No action needed — positive outcome, no
  assertion weakened.
