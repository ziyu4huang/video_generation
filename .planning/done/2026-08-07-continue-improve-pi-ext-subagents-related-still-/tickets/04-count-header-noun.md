---
type: task
status: closed
claimed: claude
---

# 04 — Count-header noun when only a workflow is running

## Question

The box count header reads `${running.length} background ${noun} running` with `noun` ∈ {"subagent", "subagents"} — which wrongly says "1 background subagent running" when the only running thing is a workflow. Make the noun account for workflow runs (e.g. "run"/"runs", or per-type counts like "1 workflow running" / "2 subagents running").

## What to build

- `src/subagent-context-widget.ts` `render()` header — compute the noun from the actual run mix (registry entries where `r.agent === "workflow"` vs subagent), not a fixed "subagent(s)".

## Acceptance

- [x] Workflow-only state shows a workflow-appropriate noun ("workflow"/"workflows"), not "subagent"
- [x] Mixed state reads naturally ("runs")
- [x] typecheck + tests green (467 pass / 0 fail)

## Notes

- Trivial, standalone, non-blocking. Touches the same file as 03 (header vs expand are different code paths).

## Resolution

**Implemented + verified green 2026-08-07.** typecheck clean, 467 pass / 0 fail (+5 new).

### What landed
- `src/subagent-context-widget.ts`: new exported `countNoun(running)` — picks the noun from the actual run mix: subagent-only → "subagent"/"subagents"; workflow-only → "workflow"/"workflows"; mixed → "runs". `render()` uses it.
- Header line gains a Ctrl-O discoverability hint (ticket 03 just shipped box-expand on Ctrl-O): ` ${n} background ${noun} running · Ctrl-O to expand · /subagents for detail `.

### Tests (+5 new)
`countNoun`: 1 subagent→"subagent"; 2→"subagents"; 1 workflow→"workflow"; 2→"workflows"; mixed→"runs". Existing header test updated to assert `/Ctrl-O to expand/`; Stage B workflow test strengthened to `/1 background workflow running/`.

### Delivery
Shipped via branch `feat/subagent-count-noun` (squash-merge to `main`).
