---
effort: 2026-08-20-develop-pipeline-v2
created: 2026-08-20
tier: T3
status: complete
---

# Wayfinder map: develop-pipeline-v2

## Destination
Pipeline v2: workflow promoted to primary execution engine + T1/T2/T3
tier system + pipeline-gate teeth + unified dispatch records. Spec: ./spec.md.

## Diagram of record

    entry (tier router: mechanical size rules, spec §1)
      T1 small:  bounded chat design -> execute-t1 -> devops
      T2 medium: wayfind quick grill -> thin map+spec -> plan -> execute-plan -> devops
      T3 large:  wayfind full spine -> superpowers plan -> execute-plan (fan-out) -> devops

## Decisions
- D1 two-runtimes "workflow = JUDGMENT only" REOPENED and superseded:
  workflow is the primary execution engine; superpowers executing-plans
  is driver/judgment. Evidence: shipped artifacts — pipeline-gate
  (bun-apps/pi-agent/src/cli/commands/pipeline-gate.ts), dispatch-log
  (bun-apps/pi-agent/src/cli/commands/dispatch-log.ts), execute-t1 template
  (bun-apps/pi-agent-ext-workflow/samples/execute-t1.js), execute-plan template
  (bun-apps/pi-agent-ext-workflow/samples/execute-plan.js), shell.run host-fn
  (bun-apps/pi-agent-ext-workflow/src/shell-host-fn.ts), and
  dispatching-parallel-agents v2 (bun-apps/pi-agent-ext-superpowers/skills/dispatching-parallel-agents).
- D2 2026-08-17 D5 "no tool-gate linter" superseded: pipeline-gate is the
  mechanical enforcement (user decision 2026-08-20).
- D3 T1 efforts skip the effort folder; tier declaration via --tier /
  commit trailer; dispatch records still land.
- D4 dispatch ledger = workflow Report phase output; dispatch-log queries it.
- D5 security posture (2026-08-20 final review): shell.run exposes arbitrary
  host execution to workflow scripts — including model-authored inline
  scripts via the workflow tool, with no approval gate. ACCEPTED for this
  local, single-user, no-cloud repo. Tightening option (future knob):
  first-token allowlist (bun/git).
- D6 workflow-side dispatch-log wiring (run-persistence aggregation export +
  a normalizeWorkflowRun caller) deliberately deferred to a follow-up
  ticket; until then dispatch-log is manual-archive-only and manual records
  carry no effort attribution ("unknown").

## Not yet specified
<!-- none -->
