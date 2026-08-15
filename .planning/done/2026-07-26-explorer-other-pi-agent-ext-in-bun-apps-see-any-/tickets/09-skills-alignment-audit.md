---
type: task
status: closed
priority: low
---

# 09 — skills alignment audit

## Outcome: NO DRIFT (confirmed clean) + one completeness fix

Audited every skill's subagent-dispatch guidance against the contract (02).
**Finding: no drift.** No skill instructs a divergent dispatch mechanism
(`createAgentSession` direct, `child_process` spawn, `runSubagent*`). The two
`child_process` references in skills are UTILITY SCRIPTS, not dispatch
instructions: `brainstorming/scripts/server.cjs` (dev server) +
`writing-skills/render-graphs.js` (mermaid CLI renderer).

The SDD dispatch skills (`subagent-driven-development`, `dispatching-parallel-
agents`) speak ABSTRACTLY ("dispatch a subagent" / "one agent per problem
domain") WITHOUT naming a mechanism — so they cannot point wrong. The model
follows them via the only dispatch surface in the environment, which IS the
unified `subagent` / `workflow` tool.

The canonical tool reference — `using-superpowers/references/pi-tools.md` — is
ALREADY correctly aligned: it documents the `subagent` tool (LLM path, full
param list incl. `agentType`/`commitScope`/`schemaRepairAttempts`), the
`workflow` tool for parallel fan-out, + the `spawnSubagent` programmatic
import path (with the `.ts`-subpath + ADR-0001 caveat).

**One completeness fix:** `pi-tools.md`'s Public-API note documented only the
IN-PROCESS `spawnSubagent`; it didn't mention the subprocess wrapper
(`spawnSubagentSubprocess`, ticket 04) that obsidian (05) now uses. Added a
"Process isolation (subprocess runner)" paragraph so the unified-surface
reference covers BOTH runners + reiterates the `.ts`-subpath / 8s-boot lesson.

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
