# Spec: `/subagents` viewer shows the resolved model in its Running section

> Synthesized from a Wayfind chart-the-map session (2026-07-25) that grilled the
> destination + scope and found no fog — plan-sized, so the map was skipped and
> this spec is the deliverable. Source: the just-completed "resolved model on the
> subagent call line" effort left the `/subagents` viewer blind to the same data.

## Problem Statement

When a subagent is running, the `/subagents` viewer's **Running** section shows the model *as requested* — `tier:medium` (the pre-resolution display string the registry stores at dispatch time) — and never updates to the concrete model the child actually resolved to. This is jarring because the *call line* in the main TUI (built in the prior effort) now shows the resolved model live (`tier:medium ▸ google/gemma-4-12b-qat`), but the dedicated "show me what's running" command — the one place a user goes specifically to inspect running subagents — stays stuck on the tier. The user opens `/subagents` to see what's really happening and sees a less informative view than the call line they just glanced at.

## Solution

The Running section reads the resolved concrete model from the same registry entry the call line already uses, and displays it (through the viewer's existing short-model idiom) once the child has resolved its model. Before resolution it continues to show the tier, exactly as today. No new data path: the registry already carries `resolvedModel` (added in the prior effort); the viewer simply wasn't reading it.

## User Stories

1. As a developer watching a long-running subagent, I want `/subagents`'s Running row to show the actual model the child resolved to, so that I can confirm it landed on the tier I intended (or spot a misroute) without leaving the viewer.
2. As a developer, I want the Running row's model to update live as the child resolves, so that I don't have to re-open the viewer or wait for completion to see the real model.
3. As a developer who dispatched with an explicit `model` (no tier), I want the Running row to keep showing that model, so that the display is unchanged for the case where requested == resolved.
4. As a developer who dispatched via `tier`, I want the row to show `tier:medium` only until resolution, then swap to the resolved model, so that the slot always reflects "the model" rather than freezing on the request.
5. As a developer comparing the call line and `/subagents`, I want both to agree that the resolved model is knowable mid-run, so the two surfaces don't contradict each other.

## Implementation Decisions

- **Data source:** the `InFlightSubagent` registry entry already has `resolvedModel?: string` (set by the subagent tool's `onModelResolved` → `registry.updateModel`). The viewer's Running section currently reads only `entry.model` (the pre-resolution display string). Read `entry.resolvedModel ?? entry.model` instead. One read point.
- **Display idiom:** keep the viewer's existing `shortModel()` shortening (it strips the `provider/` prefix, e.g. `google/gemma-4-12b-qat` → `gemma-4-12b-qat`). Do **not** introduce full `provider/id` here — the viewer's dense `·`-separated meta row uses the short idiom throughout; matching the call line's full-id segments would be inconsistent with the viewer's own style and crowd the row. (The call line and viewer intentionally diverge: the call line is a single focused line that can afford two segments; the viewer row packs 5+ metrics.)
- **Single slot, not two:** the Running row's model position is one meta item. Show the resolved model *in* that slot (swapping from the tier), not as an additional tier+model pair. The slot's semantics are "the model"; the tier is merely its pre-resolution proxy.
- **Live update is already wired:** the viewer's Running section is re-read on each render, and an existing ~1s invalidate timer drives re-renders so elapsed time counts up. Because the registry mutates `resolvedModel` in place, the next render tick picks it up with no extra plumbing. (Contrast the call line, which needed an explicit `invalidate` bind — the viewer already has its own timer.)
- **Done section needs no change:** completed runs are reconstructed from persisted records, whose stored `model` is already `resolvedModel ?? displayModelBeforeResolve` (the subagent tool writes that at completion). So the Done list/detail already show the resolved model when it was known. Only the Running section is stale.
- **Backward compatible:** additive read of an optional field. Viewers with no resolved model (pre-resolution, or older registry entries) behave exactly as today.

## Testing Decisions

- **Seam (single, existing, highest):** `pi-agent-ext-workflow`'s `subagent-viewer.test.ts` — it already constructs a Running section by passing an in-flight-runs array through the viewer's `getRunning` option and asserting on `viewer.render(width).join("\n")`. Extend that pattern; no new seam.
- **Test behavior, not internals:** assert the *rendered Running row text* contains the resolved (short) model and does not contain the stale tier, given a registry-shaped entry with `resolvedModel` set. Mirrors the prior art in the existing "Running section" tests.
- **Cases to cover:**
  - `resolvedModel` set → Running row shows the short resolved model (not the `model` field / tier).
  - `resolvedModel` unset (pre-resolution) → Running row still shows the `model` field (tier), unchanged behavior.
- The registry entry passed to `getRunning` is a plain `InFlightSubagent`-shaped object in the test (as the existing tests already do), so no real subagent dispatch is needed.

## Out of Scope

- The **workflow extension's `agent()` rows** in the main TUI (same tier/model gap, but a separate render path / different tool). Separate effort.
- Showing **both tier and resolved model** in the viewer row (two segments, call-line style) — explicitly decided against for this surface (dense row; short idiom).
- Full `provider/id` in the viewer (would break the short-model idiom).
- The Done section (already correct).
- Any change to the registry, the subagent tool, or the call line (all done in the prior effort).

## Further Notes

- This is the closest sibling to the prior effort and reuses its registry groundwork verbatim — `resolvedModel` is already flowing into the registry; this spec only adds a reader.
- **Fact freshness:** the working branch is behind `origin` (ahead 11 / behind 17 on `feat/extract-subagent-package`; behind 3 vs `origin/main`). The read point and registry field are stable across that range, but rebasing before implementation is still advised.
- Size: effectively one read-point change plus one or two test cases. A full tracer-bullet ticket slice (`to-tickets`) is heavier than the work warrants — a short plan or direct TDD implementation is the right next step.
