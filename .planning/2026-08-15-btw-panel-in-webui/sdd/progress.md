# SDD ledger — plan: .planning/2026-08-15-btw-panel-in-webui/plan.md
(branch feat/btw-panel-in-webui, base 0c9f6b89)
Task 1: implemented (commit pending review)
Task 1: complete (commits 0c9f6b8..a816351, review clean)
Task 1: minor (deferred): isBtwCommand guard is shallow for model/thinking kinds (plan-mandated verbatim) — later consumers must read fields defensively
Task 1: minor (deferred): ledger line wording "commit pending review" is stale — cosmetic
Task 2: implemented (commit pending review)
Task 2: complete (commits a816351..6070604, review clean)
Task 2: minor (deferred): snapshotsFromDetails keeps empty-text assistant snapshot when answer="" (plan-mandated verbatim)
Task 2: minor (deferred): brief says "6 tests", file has 7 — brief-side count slip, no behavioral drift
Task 3: implemented (commit pending review)
Task 3: fix round 1/5 (ruling: dedicated webuiBridgeUnsub field, human-approved deviation from plan verbatim)
Task 3: fix round 1/5 (ruling: dedicated webuiBridgeUnsub field, human-approved deviation from plan verbatim; commits 4e5948f..909428a)
Task 3: complete (commits 6070604..909428a, re-review clean)
Task 3: minor (deferred): disposeBtwSession emits nothing when no active session (emitThreadEvent after early-exit) — Task 4 handlers must not rely on dispose-always-emits
Task 3: minor (deferred): subscribeWebuiBridge with a different runtime leaves old subscription attached (unreachable via current call sites)
Task 3: PLAN DEVIATION (human-approved 2026-08-15): bridge disposer lives in engine field webuiBridgeUnsub, NOT sr.subscriptions — plan Task 3 verbatim code superseded; later tasks/tests must not regress the overlay-attach guard
Task 4: implemented (commit pending review)
