---
type: task
status: closed
---
# 02 — writing-plans entry criteria

## Question
What must be true of spec.md before writing-plans starts?

## What to build
Add `## Entry criteria` to `bun-apps/pi-agent-ext-superpowers/skills/writing-plans/SKILL.md`: a settled spec exists (effort path `.planning/<effort>/spec.md` or no-effort `.planning/specs/`) with zero open decisions — Implementation Decisions section present, no unresolved questions. Fidelity protocol per ADR-superpowers-0004: after editing run `bun scripts/rebalance-upstream-skills.ts` then `bun test` (132 baseline). Add a LOCAL-DIVERGENCES row to `tests/__fixtures__/upstream-skills/UPSTREAM.ref` marking the entry-criteria block as a repo-local addition (do not drop on re-sync).

## Acceptance
- [ ] writing-plans SKILL.md has `## Entry criteria` (settled spec, zero open decisions, both .planning paths)
- [ ] rebalance-upstream-skills.ts run; byte-pinned fixtures updated
- [ ] superpowers `bun test` green (132 baseline)
- [ ] UPSTREAM.ref LOCAL-DIVERGENCES carries the new row

## Resolution
Done — writing-plans entry criteria: settled spec with zero open decisions before planning; rebalance run, byte-pinned fixtures + UPSTREAM.ref LOCAL-DIVERGENCES row, 9376ea1e.
