---
type: task
blocking:
---

## Question

Remove the dead `__piPlanIncomplete`/`__piPlanSummary` seam COORDINATED (D1): wayfind readers `readPlanIncomplete`/`readPlanSummary` (`src/coordination.ts`) + `PLAN_INCOMPLETE_KEY`/`PLAN_SUMMARY_KEY` (`src/constants.ts`) + index.ts re-export; publisher `s2-agent-ext-task/extensions/task.ts:71-72` + its contract-test expectations; registry `s2-agent-core-interface/src/seam-keys.ts` + `seam.ts` SeamImplMap entries. KEEP `__piPlanPhases` (alive — `/wayfind sync` reads it via `src/chain.ts`) and `__piWayfindGrill` (hermes reads it). One-sided delete would fail seam-contract "no self-only seams" — hence one isolated cross-package PR. Gates: wayfind trio + ext-task + core-interface suites + `bun-apps/tests/seam-contract.test.ts`.

## Resolution

Landed 2026-08-21 (phase W5, branch feat/w5-dead-seam-removal). Coordinated removal of `__piPlanIncomplete`/`__piPlanSummary` (decision D1): wayfind readers + keys + tests; publisher lines in s2-agent-ext-task/extensions/task.ts (+ its contract-test expectations, import trim); core-interface seam-keys.ts + seam.ts SeamImplMap rows (+ SEAM_KEY_ENTRIES count 11→9). KEPT: `__piPlanPhases` (alive — /wayfind sync) and `__piWayfindGrill` (hermes reads). Also cleaned three sites the exploration missed: power-tool inspect-tui displayed the dead seam (row removed), goal internals/goal-complete-tool comments referenced the keys (reworded — the seam-contract scanner counts `__pi*` tokens in comments too). Gates: wayfind 467/0, task 872/0, core-interface 37/0, power-tool 271/0, seam+routing contract 10/0.

closed: (landed)
