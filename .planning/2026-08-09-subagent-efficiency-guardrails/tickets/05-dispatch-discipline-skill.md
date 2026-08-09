# Ticket 05 — wayfind skill: subagent dispatch discipline
**status:** done  **risk:** low  **size:** small  (RECOMMENDED QUICK WIN)

## Goal
A wayfind skill codifying efficient dispatch — fixes the root cause (mostly
dispatch-side) durably + cheaply. The existing subagent-driven-development skill
is SILENT on tokenBudget/spendBudget/commitScope and on impossible-tool tasks.

## Skill content (checklist the dispatcher follows every time)
1. ALWAYS set tokenBudget + spendBudget, calibrated to the task tier (small/med/big).
2. ALWAYS set commitScope (exact paths) for any committing subagent; [] for read-only.
3. NEVER delegate a task that requires a tool the subagent's allowlist lacks —
   do it in the orchestrator, or add the tool, or reshape the task.
4. Keep tasks bounded — if a task would exceed the tier budget, SPLIT it.
5. Prefer the orchestrator doing trivial writes/calls itself over spawning a subagent.
6. Read-only fan-out → use subagents (plural); single focused task → subagent.

## Acceptance
1. skill created under the project skills location (NOT a SKILL.md body edit —
   a new skill file) following the repo's skill convention
2. skill discoverable; references the knob locations from map.md
3.ADR-0004 respected (no SKILL.md body edits)

## Notes
This is the lowest-risk, highest-leverage start — it changes dispatcher
behavior immediately without code risk, and complements tickets 01–04.

## Shipped
- Skill: `bun-apps/pi-agent-ext-wayfind/skills/subagent-dispatch-discipline/SKILL.md`
  (wayfind serves `skills/` wholesale via `pi.skills`; no per-skill manifest
  edit; ADR-0004 respected — new skill file, no SKILL.md body edit).
- Passes wayfind `skills.test.ts` CSO rules; `skill-weight.test.ts` (fixed
  3-skill list) untouched.

Shipped via #1158
