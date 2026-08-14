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
Task 4: complete (commits 909428a..69270a5, review clean; implementer was mechanical tester/committer — reviewer was sole compliance gate, approved)
Task 4: minor (deferred): BTW_COMMAND_CHANNEL subscription never torn down (no unsubscribe on shutdown) — harmless single-pi-per-process; note for hardening
Task 4: minor (deferred): handleWebuiCommand unserialized (rapid commands interleave) — brief defines single-command contract
Task 5: implemented (commit pending review)
Task 5: complete (commits 69270a5..046813f, review clean)
Task 5: minor (deferred): btwCommandFromFrame validates mode string only; thinking/model values pass unvalidated (plan-mandated verbatim) — Task 11 contract test mitigates
Task 5: minor (deferred): isBtwEvent thread-state validation shallow (plan-mandated verbatim) — consumers must not assume state.messages
Task 6: implemented (commit pending review)
Task 6: complete (commits 046813f..618ee8bc, review clean; implementer was mechanical tester/committer — reviewer sole compliance gate, approved)
Task 6: minor (deferred): BtwWebFrame interface declared after its WebFrame union reference (cosmetic, plan-mandated)
Task 7: implemented (commit pending review)
Task 7: complete (commits 618ee8bc..a5f0b1b, review clean)
Task 7: minor (deferred): store returns shared EMPTY_STATE by reference pre-first-thread-event (plan-mandated) — Task 8 consumers must NOT mutate state()
Task 7: minor (deferred): no test for second-thread-event replacement — Task 8 tests may cover
Task 8: implemented (commit pending review)
Task 8: complete (commits a5f0b1b..a28dc86, review clean; implementer died post-staging — mechanical completion, reviewer sole compliance gate, approved)
Task 8: minor (deferred): createBtwRoutes deps closure re-instantiated per request (plan-mandated verbatim) — hoist candidate for hardening
Task 8: minor (deferred): no store second-thread-event-replacement or getModels null-bound test — deferred to Task 11 contract test per brief
Task 9: implemented (commit pending review)
Task 9: complete (commits a28dc86..cb38a61, review clean)
Task 9: minor (deferred): btw-panel-collapsed string only in CSS contract comment (plan-mandated toContain test) — Task 10 must wire the literal key
Task 9: minor (deferred): BTW_MESSAGE_HTML interpolates m.id/m.role unescaped (plan-mandated verbatim) — harden alongside Task 10/11
Task 10: implemented (commit pending review)
Task 10: complete (commits cb38a61..821f6b3, review clean; implementer fixed brief's reconnect-loss bug by placing ws.onmessage inside connectWs)
Task 10: minor (deferred): pull/subscribe race — thread event during initial /api/btw fetch can be overwritten by stale snapshot (plan-inherited, self-heals)
Task 10: minor (deferred): snapshot load doesn't sync mode label or model/thinking dropdowns (display-only staleness, plan-verbatim)
Task 10: minor (deferred): btwMessageHtml/btwRenderMessages unescaped m.id/m.role interpolation + notice rows never pruned (plan-mandated; harden with Task 9's copy together)
Task 11: implemented (commit pending review)
Task 11: complete (commits 821f6b3..1c73378, review clean)
Task 11: minor (deferred): contract test asserts no package.json dependency but not source-import absence — grep/lint assertion candidate
Task 12: complete (verification — both gates green, sweep clean)
Task 12: btw gate 31 pass/0 fail (7 files, 86 expects); webui gate 319 pass/0 fail (27 files, 701 expects)
Task 12: sweep — zero @repo imports in webui src/, zero package.json dep; only comment-only mention src/btw-channels.ts:5 ("Mirrors ... WITHOUT importing") — accepted, no coupling
Task 12: no real-model calls — only comment-only mention tests/helpers/mock-pi.ts:10; all tests use fake sessions/mocks/pure helpers
Final review: FINDINGS (1 Important F1 contract-pin self-referential, 3 Minor F2-F4) — one fix wave; all deferred minors triaged ACCEPT (see final review)
Final fix wave: complete (F1-F4 fixed, both gates green)
Final review: fix wave re-review clean (F1-F4 ADDRESSED, no new breakage) — branch ready to merge
SDD complete: 12/12 tasks, 1 task fix round (T3, human-approved deviation webuiBridgeUnsup), final fix wave cf9c6ec6; gates btw 36/0 webui 319/0
