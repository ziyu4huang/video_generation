---
type: task
status: open
priority: low
---

# 09 — skills alignment audit

## Question

The skills that instruct the model to dispatch subagents (superpowers SDD
ecosystem, knowledge-card, obsidian, wayfind — per 01's audit) — do they steer to
the unified surface, or to a divergent one? Check each against the contract (02);
update instructions that point wrong.

## What resolving it looks like

For each skill: read its subagent-dispatch instructions; verify they reference the
unified tool (`subagent` / `workflow`) not a divergent path; update where stale.
Partly independent of the build tickets (04–08) — can run now the contract is
locked.

## blocked by

(none — contract is locked; this is documentation alignment)

## Note

Lower priority than the runner consolidation (04–08). The skills currently drive
the model toward `subagent`/`workflow` tools (the unified surface) in practice;
this ticket confirms that + fixes drift, if any.
