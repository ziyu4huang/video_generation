# SDD ledger — plan: .planning/2026-08-14-build-hitl-webui/plan.md

## Phase 1 — appexec return transport
- Task 1: complete (commits 33bae1c6, review APPROVED — 1 minor ledgered → fixed in T2)
- Task 2: complete (commits 32deb614, review APPROVED — 3 minors ledgered to Phase 2)
- Final whole-branch review: APPROVED, no fix dispatch (7279fec6..32deb614, 237/0 tests, build exit 0)

## Ledger (minor findings → Phase 2 plan must carry)
- [T2-review] Tighten `HitlResponse` (union `{action,tweak?} | {cancelled:true}`) when webui_present lands.
- [T2-review] One-pending-at-a-time guard lives in webui_present (Component 2) — plan the guard TEST explicitly; also fix silent duplicate-id overwrite in registerPending if touched.
- [T2-review] WS-close cancels all pending — note reconnect/refresh tension for the present-handler phase (Decision A/C contemplate re-fetch of a pending presentation).
- [final-review] Refresh stale parseCommand class-header JSDoc (web-transport.ts:47-49, old no-op seam wording) in Phase 2's first commit.
- [task-2-impl] HitlResponse.action made optional (deviation from plan verbatim: TS2741 with {cancelled:true}); Phase 2 branches on `cancelled` before reading `action`.
