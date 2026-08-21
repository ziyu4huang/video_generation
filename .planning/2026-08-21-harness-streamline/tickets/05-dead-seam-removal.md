---
type: task
blocking:
---

## Question

Remove the dead `__piPlanIncomplete`/`__piPlanSummary` seam COORDINATED (D1): wayfind readers `readPlanIncomplete`/`readPlanSummary` (`src/coordination.ts`) + `PLAN_INCOMPLETE_KEY`/`PLAN_SUMMARY_KEY` (`src/constants.ts`) + index.ts re-export; publisher `s2-agent-ext-task/extensions/task.ts:71-72` + its contract-test expectations; registry `s2-agent-core-interface/src/seam-keys.ts` + `seam.ts` SeamImplMap entries. KEEP `__piPlanPhases` (alive — `/wayfind sync` reads it via `src/chain.ts`) and `__piWayfindGrill` (hermes reads it). One-sided delete would fail seam-contract "no self-only seams" — hence one isolated cross-package PR. Gates: wayfind trio + ext-task + core-interface suites + `bun-apps/tests/seam-contract.test.ts`.
