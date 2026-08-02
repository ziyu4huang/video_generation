## Question

The completion act — the destination edge. Once every extension is migrated (all rollout tickets closed), the drift-guard covers the full migrated set (02), `qa/evaluate.ts` consumes effective gates, and telemetry is fixed: delete the hardcoded `GATES`/`CORE_TOOLS` fallback from `extensions/tool-gate.ts` entirely, and simplify `buildEffectiveGates` now that the fallback is gone. Verify the full suite + a final drift-guard run. After this, gating is owner-declared end to end with no legacy fallback.

type: task
blocked by: 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14
