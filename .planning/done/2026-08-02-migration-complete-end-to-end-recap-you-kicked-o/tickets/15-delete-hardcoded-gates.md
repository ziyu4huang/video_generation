## Question

The completion act — the destination edge. Once every extension is migrated (all rollout tickets closed), the drift-guard covers the full migrated set (02), `qa/evaluate.ts` consumes effective gates, and telemetry is fixed: delete the hardcoded `GATES`/`CORE_TOOLS` fallback from `extensions/tool-gate.ts` entirely, and simplify `buildEffectiveGates` now that the fallback is gone. Verify the full suite + a final drift-guard run. After this, gating is owner-declared end to end with no legacy fallback.

type: task
blocked by: 02, 03, 04, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14
status: closed

## Resolution — ticket 15 CLOSED (migration COMPLETE)

Deleted the empty hardcoded `GATES` module + simplified `buildEffectiveGates` — the migration's completion act. GATES-ONLY scope: CORE_TOOLS kept (still authoritative for ~18 unmigrated always-on tools; its migration is a separate major effort). Changes: tool-gate.ts — `export interface ToolGate` (was unexported), `GATES` declaration deleted, `TRACKED_TOOLS = new Set(CORE_TOOLS)`, `buildEffectiveGates` simplified (dropped dead `fallbackGates` param + FOLLOWUPS-#4 per-name partition loop; kept `fallbackCore = CORE_TOOLS`), updateSticky/computeBannerSaved defaults → [], effectiveGates init → []; qa/evaluate.ts — dropped GATES import, `type CorpusGate = ToolGate`; qa/research-cost.ts — re-routed off GATES → CORPUS_EFF.tracked (also fixes a latent bug where formerly-gated tools mis-reported as ungated), deleted dead HELP_NAMES (this was the real GATES-deletion blocker flagged by ticket 14); tool-gate.test.ts — dropped GATES import, deleted the S1 "GATES data" block + 2 removed-mechanism tests (coverage backstopped by bun run qa), 3 false-fire guards GATES→EFF.gates. Confirmed ZERO cross-package GATES code refs (all cross-package hits are comments). Tests: bun test 266/0, `bun run qa` default PASS (savings 8,275 tok/req 44%), qa/research-cost.ts clean. qa --strict still fails on 5 genuinely-ungated tools (separate finding, unchanged by 15). MIGRATION COMPLETE: every gate is owner-declared end to end; no hardcoded GATES fallback remains. Commit: 719e78e1.

OPEN post-migration items (separate scope, NOT ticket 15): (1) 5 genuinely-ungated heavy tools need gate-vs-always-on decisions (subagents, sweep_branches, await_pr_merge, memory_supersede, wayfind_effort) — qa --strict stays red until then; (2) CORE_TOOLS migration (~18 unmigrated always-on tools) — separate major effort; (3) final rebase to origin/main.
