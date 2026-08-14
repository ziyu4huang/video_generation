# Task 2 + Task 3 — Phase 5 ledger hardening (implementer report)

- **BASE:** `0c715949` (Task 1 done)
- **HEAD:** `3fdec250`
- **Commits:**
  - `9eff893e` fix(webui): percent-encode imageMd rel path (spaces/parens in output filenames) — 2 files
  - `3fdec250` hardening(webui): isPayload view type-guard; drop unused rmSync import — 3 files
- **Gate:** `( cd bun-apps/pi-agent-ext-webui && bun run test )` → build (bunx tsc) exit 0, **290 pass / 0 fail** (286 Task-1 + 3 imageMd + 1 isPayload), 622 expect() calls, 21 files.

## Task 2 — imageMd percent-encode (ledger [P4-final] #1)

- TDD: added 3 tests to `describe("imageMd")` in `tests/image-presentation.test.ts` (space → `%20`, parens preserved with space encoded, clean-path no-op).
- Red: 2 fail / 1 pass (space + parens fail; clean path passes pre-change, as the plan predicted).
- Fix: `src/image-presentation.ts` `imageMd` return now wraps the separator-normalized rel path in `encodeURI` (with the plan's explanatory comment). The `/output` route's `decodeURIComponent` round-trips `%20` — no serving change.
- Green: file suite 21/21. Committed exactly the 2 plan paths with the plan's message.

## Task 3 — isPayload view guard + rmSync import cleanup ([P4-final] #2, Phase-2 [T1-review])

- TDD: added 1 test to `tests/present-event-handler.test.ts` after the "ignores an invalid mode" test: `handler({content, controls, view: 42})` must mint nothing (`listViews()` empty).
- Red: FAIL — the old handler forwarded raw `42` as a view id.
- Fix: `src/present-event-handler.ts` `isPayload` gains `if (o.view !== undefined && typeof o.view !== "string") return false;` (mirrors the `id` guard style). Also removed the unused `rmSync` from the `node:fs` import at `tests/output-routes.test.ts:11` (only that file; `webui-wiring.test.ts` untouched).
- Green: 5 present-event-handler + 20 output-routes = 25/25.

## Deviations

None. Verbatim plan code used throughout; no preserved files touched; no push/PR/merge performed.

## Notes for the controller

- Working tree residue at completion is pre-existing/unrelated (`MEMORY.md` modified, untracked `task-01-phase5.md` report, `.planning/zk-spawn/`, `history.txt`).
- Final-verification items (negative-tool grep, invariant checklist, `sdd/progress.md` ledger closure) remain for the controller per plan — not implementer scope.
