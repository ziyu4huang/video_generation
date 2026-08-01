# Task 3 — Collapsible batch header (enter toggles collapse)

**Status:** DONE_WITH_CONCERNS (one deliberate, documented deviation + one pre-existing debt; all gates green)

## What I implemented

Made the batch group header in `/subagents` **selectable** and **collapsible**:

- New per-`batchId` collapse state: `private collapsedBatches = new Set<string>()`.
- `entries()` widened to a 3-kind union: `{kind:"running"}`, `{kind:"batchHeader"; batchId; count}`, `{kind:"completed"}`. A `batchHeader` is emitted once per batch (on first sight in registry order), and its children follow it **only when expanded**. Ungrouped runs (no `batchId`) stay flat; completed stays capped.
- `handleInput`: a new `batchHeader` branch **before** the running/completed enter handling — enter on a header toggles `collapsedBatches` for that `batchId`, clamps the cursor, invalidates, and returns (never reaches the follow/output branches).
- `renderList`: replaced T2's `lastBatch`/`batchCounts` precompute + two-branch loop with a single loop over the running-section entries. A `batchHeader` row renders `▼ … · k running` (expanded) or `▶ … · k running` (collapsed), selectable/`▶`-marked when current. Indented child rows and flat ungrouped rows keep **byte-identical prefixes** to pre-T3 (verified via diff) so existing visuals are unchanged.

## Deviation from the brief (documented)

**Strengthened `entries()` to truly COLLECT per batch (order-independent grouping).** The brief's literal Step-3(b) loop pushes each child at its own position inside the iteration, so an **interleaved** batch — e.g. `[batchX:0, solo, batchX:1]` — would **split** (`batchX:1` lands after `solo`), violating the orchestrator's explicit CONTEXT directive: *"Your new `entries()` groups by COLLECTING all children per `batchId`… so grouping is correct regardless of insertion order. Carry that property."* I verified the split empirically (probe), then rewrote the loop to, on each batch's first sight, emit the header **and collect all of that batch's children** (`allRunning.filter(batchId===bid)`) right after it, skipping later sightings. This:

- is strictly more correct (handles interleaving — fixes the T2 contiguity concern the orchestrator named);
- breaks **no** test (no existing test interleaves; the `mixed` test has the batch children already contiguous, so the result is identical);
- keeps the `count` semantics identical (`children.length` over the filtered set).

The single test-hygiene note on the brief's test code: tests 1 & 3 assert `"doing …"` substrings, which only render when the row has no history (otherwise the latest tool-call wins via `summarizeLatestAction`). The T2 batch tests already use `history: []` for this; the brief's new tests omitted it. I added `history: []` to tests 1 & 3 (test 2 asserts `→ read` and keeps default history). Without this, test 1's expand assertion would hard-fail and its collapse assertion would false-pass. This matches the orchestrator's own framing ("the tests assert on substrings … `doing …`").

## Handling of the 5 integration risks

1. **Cursor stays valid after toggle.** A header is only ever toggled when the cursor sits ON it (`e = entries[this.selected]`, `e.kind==="batchHeader"`). The header precedes its children, so its index is stable across its own collapse/expand — `selected` remains on the header. The brief's `Math.min(this.selected, entries.length-1)` clamp uses the pre-toggle length and is a no-op in this path (harmless safety net). Verified by the cursor-skip test (collapse → down lands on `solo`, not a hidden child) and the expand-again test.

2. **Filter still narrows (and is crash-free on filtered-out batches).** `allRunning` is filtered by `matches(agent, taskPreview)` before grouping. A `batchHeader` is emitted only when iterating a child that passed the filter, and its `count` is computed over the **filtered** set. A batch with **no** matching children is never iterated → no header, no children (dropped entirely — the sensible choice). A batchHeader itself has no agent/preview and is never passed to `matches`, so no crash. Collapsed + filtered still shows the header with the filtered count. Existing filter tests use ungrouped/completed runs and pass unchanged.

3. **Cap stays on completed only.** `COMPLETED_CAP` slices only `capped` (completed); `runningEntries` (headers + running) is never sliced. Unchanged.

4. **Enter handler order.** `batchHeader` branch is the first `if` after the `!e` guard, ahead of `running` (→ `enterFollow`) and `completed` (→ `output`), and `return`s. Verified: enter-on-ungrouped-running → follow, enter-on-batch-child → follow, enter-on-completed → output, enter-on-header → toggle — all covered by passing tests.

5. **All tests pass.** 41 viewer tests (34 original + 4 T2 + 3 new) green; full package 373/373; `tsc --noEmit` exit 0.

## TDD RED → GREEN

**RED** — wrote the 3 new tests + updated T2 test 4 (one `down` to reach the first child, since the header is now entry 0). Ran the brief's targeted failure check:

```
$ ( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts -t "collapses its children" )
AssertionError: collapsed glyph            ← enter did nothing on T2's non-selectable header
(fail) batch header is selectable; enter collapses its children, enter again expands
 0 pass  40 filtered out  1 fail
```

(The cursor-skip test passed on T2 for the *wrong* reason — first enter followed a child and later inputs are ignored in follow-view — and becomes meaningful only under T3; that's an acceptable regression guard, not a RED gap. The brief's Step 2 only requires the "collapses its children" test to fail, which it did.)

**GREEN** — after implementing `entries()` + state + `handleInput` branch + `renderList`:

```
$ ( cd bun-apps/pi-agent-ext-subagent && bun test tests/subagent-viewer.test.ts )
 41 pass  0 fail

$ ( cd bun-apps/pi-agent-ext-subagent && bun test )              # full package
 373 pass  0 fail   145 expect() calls   across 33 files

$ ( cd bun-apps/pi-agent-ext-subagent && bunx tsc --noEmit ); echo $?
0
```

## Files

- Modified: `bun-apps/pi-agent-ext-subagent/src/subagent-viewer.ts` (`collapsedBatches`, `entries()`, `handleInput` enter branch, `renderList` running section)
- Modified: `bun-apps/pi-agent-ext-subagent/tests/subagent-viewer.test.ts` (3 new collapse tests + T2 test-4 cursor-offset update + `history:[]` on the two `doing …`-asserting tests)

## Self-review

- **Spec coverage:** D2 (collapsible header) ✓. Deficits (1)/(2) → T1/T2; (3)/(4) out of scope.
- **YAGNI:** no speculative features. Collecting-strengthen is required by the orchestrator's directive, not gold-plating.
- **Backward-compat:** singular-tool dispatches never set `batchId` → stay flat, never collapsible, no header. Verified by the ungrouped tests.
- **Pristine output:** `biome format --write` applied to the src file (only my new lines changed). My new test code is biome-clean (fixed my one `let`→`const`). I did **not** touch two **pre-existing** biome findings (both predate T3): the `useOptionalChain` warning in `reconstructSubagentRuns` (untouched line) and the multi-line-array format error in T2's test-4 (left byte-identical). `bun run check` was already red on HEAD for these; fixing unrelated T2/src debt is out of scope for a focused T3 commit.
- **Test hygiene:** no `console.log`, no skipped tests, no magic numbers; each new test asserts one behavior; the `history:[]` additions are documented above.

## Concerns

1. **Deviation from the brief's literal `entries()` loop** (collecting vs. emit-at-position) — deliberate, per the orchestrator's explicit "Carry that property" directive; documented above. If a reviewer diffs against the brief's literal code, this is the one intentional divergence.
2. **Pre-existing biome debt** (2 findings, both on HEAD before T3): `useOptionalChain` in `reconstructSubagentRuns` and the multi-line array in T2's test-4. Not introduced by T3; left untouched to keep the diff focused. `bun run check` (the package's combined gate) remains red on these — a pre-existing condition, not a T3 regression. The T3-required gates (`bun test`, `tsc --noEmit`) are green.
3. **Filter-on-batch semantics chosen:** a batch with zero matching children is dropped entirely (no orphan header); a batch with some matching children shows the header with the filtered count and only matching children. Sensible and consistent with completed-row filtering; no test exercises it but it's crash-free.
