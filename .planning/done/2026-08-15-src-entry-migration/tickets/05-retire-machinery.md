type: task
blocked by: 04-workflow-consumers

## Question

Retire (or explicitly keep as no-op guards) the stale-dist machinery, now that no `@repo/*`
package resolves its root to dist:

- `bun-apps/tests/workspace-dist-fresh.test.ts` — its vacuity guard
  `expect(checked).toBeGreaterThan(0)` FAILS once `distEntryMain` returns null everywhere;
  decide retire vs re-scope (e.g. flip polarity: assert zero dist-entry packages remain —
  a regression tripwire if someone re-adds one).
- `bun-apps/pi-agent/src/patches/ensure-workspace-dist.ts` + `src/workspace-dist-staleness.ts`
  — heal loop no-ops when no package matches; decide delete (with PATCH_TABLE +
  `BUN_PI_ENSURE_WORKSPACE_DIST` env removal + `bun run test:dist` root script cleanup) vs
  keep as a guard. The #1370 heal-loop tests would go with a deletion.
- Update `output/next-goal-20260815_084136.md`'s deferred-prize ledger via the effort's
  closing ceremony (`/wayfind done`).

## Resolution

**Done — machinery retired, tripwire kept.**

- **Deleted**: `src/patches/ensure-workspace-dist.ts` + its test (the #1370 heal-loop tests
  went with it — pi-agent suite 952 → 930, delta exactly the deleted tests); the PATCH_TABLE
  row, union-type member, switch case, env knob `BUN_PI_ENSURE_WORKSPACE_DIST`, and the
  index.test known-patches entry.
- **Slimmed** `src/workspace-dist-staleness.ts` (131 → 44 lines) to the one survivor:
  `distEntryMain` — the predicate the tripwire gate imports. The mtime walkers
  (`newestMtimeMs`/`newestSrcMtimeMs`) and `shouldRebuildDist` deleted; header rewritten as
  history (incident → migration → what survives and why).
- **Kept**: `bun run test:dist` root script + the workflow gate step, now in tripwire form
  (zero dist-root packages). Gate/test/workflow comments rewritten to say so.
- The gate-polarity flip itself rode ticket 04's PR (it blocked that push — the old vacuity
  guard fired the moment the fourth root flipped); this ticket deleted what it made dead.

Verification: pi-agent 930 / 0 fail; patches/ subset 170 / 0; tripwire gate pass;
cross-package typecheck exit 0; `./pi-agent.sh -p` boots `BOOT5OK` with no heal patch in the
graph at all.

Ticket closed 2026-08-15.
