# subagents Completed-section visibility (deficit 4b) — spec

> Plan-ready synthesis of the 2026-08-02 wayfinder session. Closes the last deferred
> visibility deficit from the live-visibility (#988) → visibility-finish (#993) arc:
> `subagents` batch children are invisible in the `/subagents` **Completed** section after
> the batch ends.

## Goal

Show each `subagents` batch child as a selectable entry in the `/subagents` viewer's
**Completed** section once the batch finishes — task preview + model + status + usage,
selectable → follow shows its frozen output — matching the singular-`subagent` Completed
richness. **Session-scoped** (this session's batches only); no durable-store coupling, no
write-once record schema change.

## Background — the fog, grounded in code

The Completed section is built by `reconstructSubagentRuns(branch)` (`src/subagent-viewer.ts:57`),
which scans the session branch for `toolResult` messages and hard-filters
`msg.toolName !== "subagent"`:

```ts
if (!msg || msg.role !== "toolResult" || msg.toolName !== "subagent") continue;
```

A `subagents` batch produces **one** `toolResult` with `toolName === "subagents"` whose
`details.results` is the positional child array — so the whole batch is skipped and **no
batch child ever reaches Completed**. Confirmed present on `main`.

Each completed child's result slot today (`src/subagents-tool.ts:289`) is impoverished:

```ts
slots[index] = { output: result.output, status, id: task.id, index, usage: result.usage };
```

— **no `task` text, no `model`, no per-child `elapsedMs`**. The full data *is* persisted to
the durable store (`subagents-tool.ts:303`), but the viewer is branch-only today; coupling it
to the store is out of scope (decision D1).

## Decisions (resolved via grilling — all confirmed the recommendation)

- **D1 — Sourcing = B' (enrich the slot, reconstruct from branch).** Add `task` / `model` /
  `elapsedMs` to each child result slot (the data exists at execution time), then widen
  `reconstructSubagentRuns` to expand a `subagents` toolResult into N child entries. **No
  durable-store coupling, no `SubagentRunRecord` schema change.** Session-scoped = the core
  deficit. Rejected **A** (read `~/.pi/subagents/runs/`): enables cross-session but needs a
  `batchId`/parent link added to write-once records + couples the branch-only viewer to the
  store — bigger, riskier; cross-session is already served by the `subagent_runs` tool.

- **D2 — Slot enrichment.** Completed/done/timedout slots gain `task` (→ `taskPreview`),
  `model` (`childModel`), `elapsedMs` (per-child, from a start timestamp recorded at dispatch).
  Budget slots (`status: "budget"`) gain `task` + `model` (so they preview in Completed).
  `id` / `index` / `usage` / `output` / `status` / `exhaustion` / `source` unchanged. **The
  model-facing `renderBatchResult` is byte-identical** — it selects `output`/`status`/`id`
  only; the enrichment lives in the machine-readable `details` slot objects, never in the
  rendered text.

- **D3 — Reconstruction.** `reconstructSubagentRuns` gains a second branch:
  `toolName === "subagents"` → expand `details.results` into N child `SubagentRun` entries,
  each carrying the **batch's** `toolCallId` (shared) + the slot's `index`, plus an optional
  `batchChild: true` flag. Singular `subagent` entries are **byte-identical** to today (the
  new branch is purely additive). **Failed (`null`) slots are skipped** in reconstruct (no
  data; their count is already in the batch header). Budget slots render with `status:
  "budget"`.

- **D4 — Completed rendering.** A batch's reconstructed children group under a collapsible
  header in Completed, mirroring the live **Running**-section batch grouping shipped in #988
  (e.g. `▼ subagents batch · N children`). Selecting a child + enter → `follow` shows its
  frozen `output` (same follow path as singular Completed entries). Order: batch order, then
  child `index`. A batch with a single child still groups (consistent), but renders
  compactly.

## In scope

- **`src/subagents-tool.ts`** — record a per-child start timestamp at dispatch (before the
  `await spawn`); on completion compute `elapsedMs = now - childStart`; enrich each
  completed/timedout/budget result slot with `task` / `model` / `elapsedMs`. Widen the
  `BatchResultSlot` / `SubagentsToolDetails` types accordingly.
- **`src/subagent-viewer.ts`** — `reconstructSubagentRuns`: add the `toolName === "subagents"`
  expansion branch; `SubagentRun` gains optional `batchChild?` (group key = shared batch
  `toolCallId`). Completed rendering groups batch children under a collapsible header;
  select → follow frozen output (reuse existing follow path).
- **Tests** — `subagents-tool.test.ts` (slot fields present + `renderBatchResult` text
  unchanged + per-child elapsed), `subagent-viewer.test.ts` (reconstruct expands a batch into
  N entries, skips `null`, groups under the batch toolCallId; Completed select→follow shows
  frozen output; singular entries unchanged).

## Out of scope (deferred — separate effort)

- **Cross-session Completed via durable-store read (Option A)** + any `SubagentRunRecord`
  schema change (`batchId`/`parentToolCallId`). The `subagent_runs` tool already serves
  cross-session inspection.
- **Live (Running-section) changes** — shipped in #988 / visibility-finish (deficits 1–4a).
- **Parent-model live visibility / mid-flight intervention** — the deferred frontier thread
  from the `what-s-next` map; genuinely foggy, separate effort.
- **Multi-line merged inline feed** for the batch tool's own Ctrl-O call (D3 of
  visibility-finish chose single-line).

## Implementation surface

| File | Change |
|------|--------|
| `src/subagents-tool.ts` | per-child start timestamp; enrich result slots (`task`/`model`/`elapsedMs`); widen `BatchResultSlot` + `SubagentsToolDetails` types |
| `src/subagent-viewer.ts` | `reconstructSubagentRuns` — add `subagents` expansion branch; `SubagentRun.batchChild?`; Completed batch grouping + select→follow |
| `tests/subagents-tool.test.ts` | slot enrichment + render unchanged + per-child elapsed |
| `tests/subagent-viewer.test.ts` | reconstruct expansion + grouping + select→follow + singular-no-regression |

## Acceptance criteria

1. After a `subagents` batch completes, its non-failed children appear in the `/subagents`
   **Completed** section, grouped under a collapsible `▼ subagents batch · N children` header.
2. Each child entry shows **task preview + model + status + usage** — matching the
   singular-`subagent` Completed richness (was: invisible).
3. Selecting a batch child + enter → `follow` shows its **frozen** output (same path as
   singular Completed).
4. The batch tool's **model-facing rendered text** (`renderBatchResult`) is **byte-identical**
   to today — enrichment adds machine-readable slot fields only.
5. **Singular `subagent` dispatches** reconstruct + render **exactly as before** — no
   regression in cursor, filter, cap, header, grouping, or follow.
6. All existing viewer / reconstruct / batch-tool tests stay green; new tests cover slot
   enrichment, reconstruct expansion, Completed grouping, and select→follow.

## Footguns (carry into the plan)

- **`renderBatchResult` MUST stay unchanged.** The enrichment is in the `details` slot objects
  only. If the render ever dumps the whole slot, the model would see bloated text — the plan's
  test must assert byte-identical rendered output before/after.
- **Per-child `elapsedMs` needs a dispatch-time timestamp**, recorded *before* the `await
  spawn` — not derived from the batch-wide `t0` (that would attribute queue/wait time to every
  child).
- **`reconstructSubagentRuns` re-runs on every viewer render** (it's the `getRuns` re-scan).
  Expanding a batch is O(children) for one branch entry — fine, but never make it O(branch ×
  children).
- **Singular path is sacred.** The `toolName === "subagents"` branch is additive; do not touch
  the `"subagent"` path or shared rendering defaults. A regression test must pin singular
  output byte-for-byte.
- **`null` (failed) slots have no data** — skip them in reconstruct (don't emit empty
  entries); the batch header's failure count already represents them.
- **Grouping key = the batch's shared `toolCallId`.** Singular entries each have a unique
  `toolCallId` and `batchChild` unset → never group. Verify a single-child batch still
  renders sensibly (header + one child), and that two distinct batches in one session form two
  separate groups.
- **Shared singleton unaffected.** This work touches the branch-reconstruction path only; the
  in-flight registry and run-persistence singletons are unchanged.
