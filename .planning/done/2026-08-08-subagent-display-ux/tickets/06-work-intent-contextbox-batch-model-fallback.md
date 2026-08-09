---
type: task
status: closed
origin: 2026-08-08-subagent-display-glanceable-by-default/tickets/04-work-intent-contextbox-batch-model-fallback.md
---

## Question

Post-merge display review (after #1101 / #1103 / #1104 / #1106 landed) found 4
display regressions / polish gaps — 2 P1 (false claims / silent stale model) +
2 P2 (fallback indicator vanishes, collapsed lines overflow on long model ids).

This is one cohesive PR: "subagent display polish — work-intent context-box +
batch/model fallback consistency". Not a re-implementation of the merged PRs —
it closes the gaps their commit messages claimed but their tests missed.

## Findings

### Finding 1 (P1) — #1101 work-intent strip is DEAD on the docked context box
`subagent-context-widget.ts` `renderRun` passes `r.taskPreview` (already
single-lined by `taskPreview()` → `task.replace(/\s+/g," ")`) into
`renderSubagentCall`. `workIntentPreview` then `split("\n")`s a one-liner, so
its `^(working dir|cwd|repo):` preamble-strip branch never matches (only one
line → loop finds nothing → falls back to the full preview). Net: the context
box STILL shows "Working dir: …" — the exact thing #1101 claimed to fix on
both surfaces (its tests only called `renderSubagentCall` with a raw multi-line
task, never the collapsed-preview path).

**Fix**: precompute `workIntent = workIntentPreview(task)` once at `start()`
on the `InFlightSubagent` entry; `renderRun` passes that (not `taskPreview`)
into `renderSubagentCall`. `taskPreview` stays the viewer/persistence verbatim
path (unchanged). The inline live path already strips correctly (it has the raw
task).

### Finding 2 (P1) — #1103 actual-model-on-fallback never extended to `subagents`
`subagents-tool.ts` `dispatchChild` stores `model: childModel` (the REQUESTED
spec) in every `BatchResultSlot`, and only wires `onModelResolved`
(registry-only — never captured into the slot, NO `onModelFallback`). So a
batch child that requests `anthropic/claude-opus-4-1` and falls back to
`zai/glm-5.2` renders the REQUESTED `opus` under a `✓ done` badge — a success
badge on a model that never ran, with no `→` / `requestedModel` anywhere. The
singular tool captures this correctly (mirror that pattern).

**Fix**: capture per-child `resolvedModel` / `fellBack` /
`requestedModel` from `onModelResolved` / `onModelFallback`; add `onModelFallback`
to `childSpawnOpts`; write the ACTUAL model into the slot; thread
`requestedModel` / `fellBack` into `BatchResultSlot` + the batch renderer so a
fallback displays `requested → actual`.

### Finding 3 (P2) — fallback `→` indicator vanishes on settle + missing on context-box header
The live inline call line shows `▸ opus ▸ → glm-5.2` (good), but on settle the
result `meta` collapses to just the actual model (fallback invisible). The
context-box `renderRun` never passes `fellBack` (the registry carries
`r.fellBack` / `r.requestedModel` from `markFallback`), so its header never gets
the `→` either.

**Fix**: pass `fellBack` (+ `requestedModel`) into `renderSubagentCall` from
`renderRun`; add a dim `requested → actual` segment on the settled result
`meta` when `d.fellBack` so a surprising fallback persists after settle.

### Finding 5 (P2) — collapsed call/result lines overflow width on fallback
`renderSubagentCall` joins `title ▸ agent ▸ slot ▸ →resolved ▸ "intent(60)"`
with FULL provider/model ids (~120–135 chars), wrapping on 80-col terminals.
`shortModel()` already exists in `agent-row-display.ts` (used by the viewer)
but is NOT used by the call/result lines.

**Fix**: run the model segments through `shortModel()` in `renderSubagentCall`
and the settled `meta` (and the batch collapsed renderer's `requested → actual`
segment), so the collapsed line stays within terminal width. Do NOT change the
expanded/verbatim view.

## Constraints
- Do NOT change the expanded/verbatim (viewer/persistence) path except where a
  finding explicitly says so.
- Do NOT uncap the streaming-expanded tail (#1104 fix must hold).
- `requestedModel` audit field stays the FULL spec (display is shortened, audit
  is not) — mirrors the singular tool.

## Resolution

(implementing)
