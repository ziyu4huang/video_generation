> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# Map — superpowers ↔ workflow subagent bridge

## Destination

Superpowers' `subagent-driven-development` (SDD) + `dispatching-parallel-agents`
skills can **actually invoke a subagent through `pi-agent-ext-workflow`** —
closing the Layer-3 drift where SDD names a `subagent` tool this repo does not
ship.

**End state:** an agent following SDD can dispatch an implementer/reviewer that
runs in an isolated-context child session backed by the workflow extension, and
reports back with SDD's status contract (`DONE | DONE_WITH_CONCERNS | BLOCKED |
NEEDS_CONTEXT` + commits + test summary + report-file path).

> Destination evolved during grilling: the literal ask was *"explain it in
> ASCII"*; the user's scope answer reframed it as a real change — *make
> `pi-agent-ext-workflow` take the subagent role, learning the interface from
> `/Users/huangziyu/proj/pi-subagents`, so superpowers can invoke it.* The ASCII
> explainer is now one inline artifact inside this map, not the destination.

## Notes

- **Domain:** pi extension internals — `pi-agent-ext-workflow` (target),
  `pi-agent-ext-superpowers` (the consumer whose contract we satisfy),
  `/Users/huangziyu/proj/pi-subagents` (the reference to learn the interface
  from, not to replicate).
- **Skills every session should consult:** `wayfinder` (work-through-the-map),
  `grilling` + `domain-modeling` (ticket 02 is a grilling ticket),
  `subagent-driven-development` (the contract we are satisfying).
- **Standing preferences (CLAUDE.md):** conversation in zh_TW; written artifacts
  in English. No top-level `cd` (use subshells / `--cwd`). Run `bun` from
  `bun-apps/`. Python via `python/venv/bin/python`.
- **Key files:**
  - superpowers runtime hook — `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` (`resources_discover` + `context` bootstrap injection; `piToolMapping()` is the spot that says "use `subagent` from `pi-subagents` if available")
  - SDD dispatch contract — `bun-apps/pi-agent-ext-superpowers/skills/subagent-driven-development/{SKILL.md, implementer-prompt.md, task-reviewer-prompt.md}`
  - superpowers pi-mapping docs — `…/skills/using-superpowers/references/pi-tools.md`
  - workflow engine — `bun-apps/pi-agent-ext-workflow/src/{workflow-tool.ts (tool schema: script/name/args/background…), spawn-subagent.ts (EXISTING isolated child-agent runner), agent.ts (WorkflowAgent.run), workflow-manager.ts}`
  - reference — `/Users/huangziyu/proj/pi-subagents/src/extension/{index.ts, schemas.ts (SubagentParams)}, src/slash/prompt-template-bridge.ts, src/api/delegation.ts`

## Decisions so far

- [Capability-gap audit](tickets/01-capability-gap-audit.md) — workflow **already has `spawnSubagent()`**: isolated child session + model override + tool allowlist/exclude + structured-output schema + cwd + timeout + parent-tool bridging. The missing piece is the **binding surface** superpowers' dispatch can hit (a tool / a delegation-protocol provider) — *not* the runner. The runner is ~80% there.
- [Compatibility-shape decision](tickets/02-compatibility-shape-decision.md) — **Shape A**: register a `subagent` tool *inside* `pi-agent-ext-workflow` wrapping `spawnSubagent()` with SDD's contract. Workflow **owns** the role (no `pi-subagents` collision — it's a sibling reference, not installed). B/C/D rejected.

## Not yet specified

**Route is clear** — 01 (gap) + 02 (Shape A, minimal v1) are both closed. The implementation
work is specifiable now and is handed off to the spec/plan substrate rather than duplicated as
wayfinder decision tickets. `to-spec` → `.planning/<effort>/spec.md`, then `writing-plans` →
`docs/superpowers/plans/<date>-superpowers-subagent-bridge.md` will carry:

- the `subagent` tool registration in `pi-agent-ext-workflow` (params `{agent, task, model, cwd,
  tools?, excludeTools?}`) wrapping `spawnSubagent()`, mapping SDD's report-back status;
- the `piToolMapping()` + `references/pi-tools.md` update so the bootstrap tells the agent to use
  this `subagent` tool (likely a one-line change since the name matches);
- coexistence note: workflow owns the name by design — installing real `pi-subagents` later would
  collide, recorded as a known constraint, not a ticket;
- end-to-end verification: an SDD dispatch spawns an isolated implementer that reports `DONE`.

Deferred (only if a real SDD run proves the need): `clarify`-TUI, `acceptance`, `turnBudget`,
`toolBudget`.

- **The binding implementation** — code for whichever shape 02 picks (register a `subagent` tool / delegation-protocol provider / extended `workflow` mode / new adapter extension). Becomes 1–2 prototype/task tickets.
- **superpowers pi-mapping update** — once a surface exists, point `piToolMapping()` + `references/pi-tools.md` at it so the bootstrap tells the agent where to dispatch. May be a no-op if the surface is the literal `subagent` tool name.
- **Coexistence with real `pi-subagents`** — if the user later installs the real package, does the workflow-backed shim collide (tool-name / event-bus)? Decide handling; may graduate its own ticket depending on 02's shape.
- **"Ask-questions (clarify)" parity** — SDD's implementer is expected to ask questions before starting; `spawnSubagent()` is fire-and-forget. Whether to port pi-subagents' `clarify` TUI or rely on the child asking within its own run folds into 02's scope and may graduate its own ticket.
- **End-to-end verification** — prove SDD can dispatch an implementer that runs isolated and reports `DONE`; a task ticket after impl lands.

## Out of scope

- **Replicating pi-subagents' breadth** — chains, async/await, watchdog, intercom, scheduled runs, dynamic fanout, `parallel`/`chain` modes. We learn the *interface/protocol* from it; we do not rebuild its feature set. Workflow already has its own multi-agent scripting via the `workflow` tool.
- **Rewriting SDD's dispatch template** — the `Subagent (general-purpose):` / `subagent`-tool contract is treated as the **fixed target**. We make workflow meet it, not edit superpowers to lower its aim.
- **The original "explain in ASCII" as the deliverable** — satisfied inline during charting (see chat); not a remaining ticket.
