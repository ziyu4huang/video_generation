# t03 — Coverage signal: one flag away; threshold gating dispositioned to the successor

Status: open · Phase 2 · Needs: t01 · Blocks: t04

## Goal

The auditor's third note ("plain `bun test` with no coverage signal") gets its
smallest honest answer (map D5): coverage becomes one command away via bun's
built-in flag, zero new dependencies; threshold/per-file enforcement is
consciously DEFERRED to the test-hygiene successor with rationale — not
silently dropped.

## Steps

1. Add a script named per house convention (check neighboring packages for
   the canonical name; default `test:cov`): `bun test --coverage`. No new
   deps; `bun-apps/bun.lock` updated from `bun-apps/` only if the script
   itself forces it (it should not).
2. Run it once on this machine with the SurrealDB server UP; record in
   Resolution: wall-clock vs the plain ~18s run, whether bun's coverage
   output renders sanely for 137 files, and the headline number (overall %).
3. Judge stability: if it wedges, is unusably slow, or emits garbage — FALL
   BACK to disposition-only and record the measured reason (map Fog of war
   names this exact escape hatch). Do not chase a coverage toolchain in a
   maintenance arc.
4. Write the disposition into this ticket's Resolution AND the map's
   Shipped-as: "threshold + per-file coverage enforcement deferred to the
   test-hygiene successor (named in arc-17's Shipped-as) — rationale: a
   coverage toolchain is renovation; maintenance mode ships the signal and
   the deferral, not the toolchain." That sentence is what makes the
   auditor's note "addressed", per the arc's definition of done.

## Acceptance

- Either `bun run test:cov` works and its receipt (numbers) is recorded, or
  the fallback disposition with measured reason is recorded — explicitly one
  or the other, never silence.
- `bun run check` / `typecheck` / `test` unaffected (test:cov is additive).
- scripts-dir-contract still green (package.json script entries are not
  scripts-dir entries, but verify the test agrees).
