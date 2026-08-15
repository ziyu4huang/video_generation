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
