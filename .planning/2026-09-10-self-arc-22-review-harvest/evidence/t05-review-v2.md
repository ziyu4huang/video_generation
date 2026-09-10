Review complete — all four claims verified against the actual artifact. Commands run and evidence:

## Claim verification

**1. Round-trip ✅** — `bun bun-apps/s2-agent-ext-devops/scripts/reviewer-harvest.ts --name arc-reviewer --timeout 0` → **EXIT=0**, `"status": "completed"`, `"source": "pi-runs"`, `"model": "zai/glm-5.3"`, non-empty verdict (a real review citing map.md line numbers), and an idempotent receipt (`"unchanged": true, "overwritten": false`). Independently reproduced by me, not just read from the evidence JSONs.

**2. Independence double-pin ✅** — `scripts/arc-review.ts:69–72`: `model: "zai/glm-5.3"` as the explicit spec with the comment "must never match loosely (it is a substring of glm-5.3-flash)"; the record's fallback is also pinned (`resolvedModel ?? "zai/glm-5.3"`, arc-review.ts:87). No loose matching anywhere.

**3. Failure path ✅** — `writeArcReviewRunRecord` is called at `scripts/arc-review.ts:80–95`, before the receipt writes and before `if (result.failure) … process.exit(1)` (arc-review.ts:118–121) — a failed dispatch persists first. Mapping: `scripts/lib/arc-run-record.ts:44–45` → `failure || blankOutput ? "failed" : "done"`, and `devops/src/reviewer-harvest.ts:265` has `"failed"` in `PI_TERMINAL_FAILURES` → harvests as errored, never still-running. Bonus: core's `save()` swallows all write errors (`subagent-run-persistence.ts:275–287`, bare `catch` with "best-effort" comment), so a persistence hiccup cannot crash a successful dispatch — the t02 claim holds.

**4. Tests ✅** — `bun test tests/arc-run-record.test.ts` → **4 pass / 0 fail, 15 expect() calls**. The request said "expect 3/0"; the 4th test is the D3 empty-output guard from commit 2dbcdca9 — a superset, not a defect (the request's expectation was stale).

## Findings

**Blockers:** none.

**Should-fix:** none.

**Nits:**
1. **Stale ticket statuses** — `.planning/2026-09-10-self-arc-22-review-harvest/map.md` shows `Status: open` for t01–t04, yet commits cc216ce5/b18f4cd9 prove t01–t03 implemented and t04 proven (evidence files present in the diff). Flip them to done at t06 close-out — or now, it's one edit.
2. **Artifact drift from t01 ticket text** — ticket specifies `src/arc-run-record.ts` + `saveArcReviewRunRecord` with a cross-package `findPiRuns`/`parsePiRun` contract test; shipped is `scripts/lib/arc-run-record.ts` + `writeArcReviewRunRecord` with a record-shape pin (tests/arc-run-record.test.ts header documents the deferral to the live t04 proof, and Fog-of-war's "Open (small)" cross-package-import item was resolved by omission, not by a map note). Functionally equivalent and the contract is proven live twice (t04 + my re-run), so cosmetic only.

VERDICT: APPROVE