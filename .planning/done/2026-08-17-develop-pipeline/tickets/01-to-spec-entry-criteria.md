---
type: task
status: closed
---
# 01 — to-spec entry-criteria block

## Question
How does an orchestrator know the map is frozen before synthesizing a spec?

## What to build
Add a named `## Entry criteria` block to `bun-apps/pi-agent-ext-wayfind/skills/to-spec/SKILL.md`, promoting the chain-wiring sentence into an explicit gate: synthesis starts only when the source map is frozen — map exists and its `## Not yet specified` is empty (or explicitly deferred with an owner). Place the block above `## Artifact contract`. No other sections change.

## Acceptance
- [ ] to-spec SKILL.md contains `## Entry criteria` naming: map exists; Not-yet-specified resolves to none
- [ ] Chain wiring section unchanged (still references grill-me-with-docs / map collapse)
- [ ] `( cd bun-apps/pi-agent-ext-wayfind && bun run check && bun run typecheck && bun test )` green (513 baseline)
- [ ] Commit message references ticket 01

## Resolution
Done — to-spec entry criteria: `## Entry criteria` block in to-spec SKILL.md gating synthesis on a frozen map (exists, Not-yet-specified empty or deferred with owner), 1138bac8.
