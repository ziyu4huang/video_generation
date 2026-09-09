# t01 — Gate honesty: biome `check` + tsc `typecheck` + `test`, and fix every finding

Status: open · Phase 1 · Needs: — · Blocks: t02, t03, t04

## Goal

`bun-apps/s2-agent-ext-hermes-memory` gets the house gate triple under its
real names, and every biome finding the real config reports is fixed properly.
After this ticket, local_ci's lint row for hermes runs biome, not tsc in
disguise (map D2, D3).

## Steps

1. Copy the specimen: `biome.json` + the `@biomejs/biome` devDep (same version
   pin) from `bun-apps/s2-agent-ext-wayfind`. Adjust only what paths/overrides
   require for hermes's layout (`src`, `__tests__`, `bench`, `scripts`,
   `docs`).
2. Split `package.json` scripts to the house triple: `"check": "biome check ."`,
   `"typecheck": "tsc --noEmit"`, keep `"test": "bun test"`. Install from
   `bun-apps/` ONLY (`bun add` inside it or edit + `bun install`); never
   commit `package-lock.json`.
3. Run `bun run check` → capture the FULL finding list with the real config.
   The recon inventory (~12: format drift in `__tests__/db-transfer*`,
   `knowledge-corpus-roundtrip*`, `knowledge-pipeline-seam*`, `bench/corpus.ts`,
   `package.json`; `noNonNullAssertion` ×3 in `knowledge-corpus-roundtrip.test.ts`;
   `useArrowFunction` + `noAssignInExpressions` in `bench/corpus.ts`;
   `noSvgWithoutTitle` ×2 in `docs/images/*.svg`) is a FLOOR — anything extra
   the config surfaces joins the list (map Fog of war).
4. Fix, never blanket-ignore (D3):
   - Format drift → `biome check --write` (safe autofix only).
   - `noNonNullAssertion` ×3 → replace `!` with real guards (explicit
     if-throw or an assert helper) — the corpus-roundtrip fixtures CAN be
     absent; assert that loudly.
   - `useArrowFunction` + `noAssignInExpressions` in `bench/corpus.ts` →
     refactor (arrow callback; split the assignment out of the expression).
   - `noSvgWithoutTitle` ×2 → add a `<title>` element to each doc SVG
     (descriptive, short). `biome-ignore` is NOT used here.
   - Any genuinely-wrong new finding → `biome-ignore` with a written reason,
     counted in the ticket Resolution (expected count: 0).
5. Verify the gates: `( cd bun-apps/s2-agent-ext-hermes-memory && bun run check
   && bun run typecheck && bun test )` — all green (tests must still be
   1564-pass class after the test-file edits).
6. Verify local_ci wiring (constraint — don't break it): confirm how
   local_ci resolves per-package scripts (it resolves BY NAME), then run the
   relevant lane for this package via the devops CLI and confirm the lint row
   executes biome; also
   `( cd bun-apps/s2-agent-ext-devops && bun test tests/scripts-dir-contract.test.ts )`
   stays green (no new scripts-dir entries were added).
7. schema-cost +0: `git diff --exit-code` on the file holding
   MEMORY_TOOL_DESCRIPTION (locate via rg) — byte-identical, or the ticket is
   not done.

## Acceptance

- `bun run check` (biome) exit 0; `bun run typecheck` (tsc) exit 0;
  `bun test` green — all three under their real names in package.json.
- Zero unexplained `biome-ignore` additions; every recon finding + every
  config-surfed extra is fixed or listed with disposition in Resolution.
- local_ci lane for hermes shows lint = biome; scripts-dir-contract green.
- MEMORY_TOOL_DESCRIPTION byte-identical (receipt: the git diff command + exit 0).
