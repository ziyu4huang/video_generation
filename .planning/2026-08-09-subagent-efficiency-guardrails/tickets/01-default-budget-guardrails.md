# Ticket 01 — default token + spend budget guardrails
**status:** done  **risk:** med  **size:** medium

## Goal
When a dispatch omits tokenBudget/spendBudget, inject a TIER-CALIBRATED default
so unbounded runs cannot blow past sane limits. Budgets already work when set
(proof: run msl3c9zi aborted cleanly at 380k); the gap is they are rarely set.

## Step 0 — calibrate (read-only, decision input)
Survey recent SUCCESSFUL runs' token usage by role (read-only/research vs
implementer vs big-synthesis) from ~/.pi/subagents/runs. Current rough
distribution: research 10k–600k (wide), implementer 130k–1.3M, big 0.3–3.4M.
A single default won't fit → pick TIERED defaults (e.g. small 40k / medium 120k
/ big 250k — TBD by the calibration). Record the distribution + chosen defaults
+ rationale in this ticket.

## Implementation
- Inject default tokenBudget + spendBudget in subagent-tool.ts dispatch path
  when the caller omits them.
- Make defaults configurable (override via ~/.pi/agent/settings.json or workflow
  settings.json).
- Skip or scale-down for explicitly read-only dispatches to avoid false aborts.

## DECISION POINT (needs sign-off)
hard-abort (current tokenBudget semantics) vs soft-warn-on-approach? Hard-abort
protects but risks false aborts on legit long runs; the calibration de-risks the
cutoffs.

## Acceptance
1. calibration numbers + chosen tiered defaults committed here
2. default applied when omitted (unit-tested)
3. override path documented
4. existing subagent tests green

## Files
subagent-tool.ts:181 ; agent.ts:373-375,609

## Shipped
Shipped via #1280
