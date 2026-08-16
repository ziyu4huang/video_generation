---
type: task
blocking: 1, 3, 5
---

## Question

Land the subagent stage: ratified cuts (03) + TUI additions (05: render existing data, gauges, message-through-render) + absorbed cost-spec workstream C (wrap-now injection at 85% budget / maxTurns−3; calibration persistence ~/.pi/subagents/budget-calibration.json, ≥50-run recalibration cadence, env > calibrated > frozen precedence) + stale-artifact cleanup. Gates: package `bun run check && bun test` green; trio-wide net-negative per ticket 03 (Δtrio ≤ −400, subagent Δsrc ≤ +800, superpowers Δ ≤ −1,200, features ≥80%/pkg); feature count ≥80% (viewer/dock/list/follow/output all survive); runs-DB schema backward-compatible. Devops chain: branch → PR → local CI → gh ship.
