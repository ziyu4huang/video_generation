## Question

Owner-declare `gating` on every tool belonging to `workflow` (`bun-apps/pi-agent-ext-workflow/extensions/workflow.ts`), mirroring its current hardcoded entry in `extensions/tool-gate.ts` `GATES` (tool names: workflow, workflow_help, workflow_control). Then remove `workflow`'s entries from the hardcoded `GATES`/`CORE_TOOLS`, add `workflow` to the drift-guard migrated set (ticket 02), and verify `bun test` + drift-guard pass. Single-name tools: straight keyword/requires gate. Multi-name group: confirm ticket 01's resolution keeps siblings gated. Blocked until the hardening (01) and the net (02) are in place.

claimed: resume-10-11-combined

type: task
blocked by: 01, 02

## Resolution

Combined rollout — tickets 10 (subagent) + 11 (workflow) share one hardcoded GATES entry `["workflow","workflow_help","subagent","workflow_control"]` across two extensions (pi-agent-ext-subagent owns `subagent`; pi-agent-ext-workflow owns workflow/workflow_help/workflow_control). All 4 tools now carry byte-identical owner-declared `gating` (the combined keywords, keywords-only) → `reconstructOwnerDeclaredGates` collapses them back into ONE 4-name gate, preserving co-fire. The combined GATES entry was removed; neither tool is in CORE_TOOLS. Both extensions added to MIGRATED_EXTENSIONS; both registrars added to qa/evaluate.ts reconstructOwnerDeclaredGates. tool-gate.test.ts adapted (captureOwner for both extensions; dormant stand-ins → zai-mcp). `subagents` (plural) + `subagent_runs` left ungated (as original — never in the gate; flagged as possible drift, not fixed). Local `tool-gating.d.ts` added to both extensions (their tools live in src/, needing local module-augmentation for clean types; other rollouts' tools live in extensions/). Reconstructed gate name-order differs from the original in the last 2 positions (set + names[0] identical → behavior-preserving). Tests: tool-gate 262/0, subagent 400/0, workflow 1046+3todo/0. enable_tool NAME-mode sibling co-activation gap noted in test comments, NOT fixed (cross-cutting, tracked in map). Commit: 65628d76.

status: closed
