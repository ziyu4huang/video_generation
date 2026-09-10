---
effort: 2026-09-10-self-arc-24-devops-check-split
created: 2026-09-10
last: 2026-09-10
status: active
---

# Wayfinder map: 2026-09-10-self-arc-24-devops-check-split — the LAST lying lint gate: devops `check` becomes real

## Destination

devops' `check: tsc --noEmit` (a lint gate in name, a typecheck in bytes —
the exact class arc-18 fixed in hermes, decision-doc class B) is split into
the house triple: a REAL `check: biome check .` (wayfind specimen config) +
separate `typecheck: tsc --noEmit` + existing `test`. The split must SURVIVE
local_ci's name-resolved gate rows: after it, both biome and tsc actually run
in the devops lane (verified by a lane run, not by assumption — the
silent-drop hazard this class is named for). Every biome finding is fixed
properly (zero biome-ignore), with warn-layered style rules for tests if the
house specimen calls for it.

## Context (measured at claim time, 2026-09-10)

- Charter queue head: `output/next-goal-20260910-215900.md` (Immediate steps
  1–4) + the decision row:
  `.planning/2026-09-10-self-arc-19/check-scripts-decision.md` (class B,
  ADOPT — "smallest adopted class, gate-critical package").
- The specimen recipe: arc-18's hermes split (#2238) — wayfind's biome.json
  copied, findings fixed properly, layered warn-policy for test-dir style
  rules, `lint-executor-coverage`-adjacent wiring. devops has NO biome.json
  today (measured, self-arc-19 t05).
- THE hazard this arc exists to close: local_ci resolves per-package gates BY
  SCRIPT NAME (`ci-recipe`); a renamed/split script that the recipe doesn't
  expect can silently drop a gate (the arc-17 class). After the split:
  read how the recipe resolves devops' rows and RUN the affected lane to
  prove both gates execute.
- House review gate: dispatch via `arc-review.ts --name <harvest-name>` and
  HARVEST the verdict by name (self-arc-22's path, third dogfood).
- Effort proceeds in a DEDICATED WORKTREE
  (`/Users/huangziyu/proj/video_generation__selfarc23`; the memory worktree
  holds a parallel session's staged work). Absolute paths for every CLI.

## Tickets

### Phase 1 — the split (implementation)

- **t01 — scripts split + biome.json + proper fixes** (open)
  - Copy `bun-apps/s2-agent-ext-hermes-memory/biome.json` VERBATIM (layered
    overrides incl. the test-dir warn layer; note its `run-test.ts` override
    pattern is root-level only — see D5).
  - `bun-apps/s2-agent-ext-devops/package.json`: `"check": "biome check ."`,
    ADD `"typecheck": "tsc --noEmit"`, `test` unchanged. Add
    `@biomejs/biome@2.4.16` to devDependencies (`bun add` from `bun-apps/`
    only — isolated linker; `bun-apps/bun.lock` is canonical).
  - Fix every finding the REAL house-config run surfaces, properly — zero
    `biome-ignore`. Recon floor (defaults, 172 files checked): **20
    diagnostics / 11 files** — 12 lint (5 `noNonNullAssertion`, 4
    `useTemplate`, 1 each `noAssignInExpressions`/`noUnusedImports`/
    `noUnusedFunctionParameters`) + 5 format + 3 `organizeImports`.
    Concentration: `tests/worktree-doctor.test.ts` (6), `scripts/run-test.ts`
    (5), then 1-per-file in `src/{ci-matrix,ci-deploy-gate,changed-packages,
    changed-packages-cli,branch-recipe,branch-logic}.ts` (6 src files →
    deploy implication, t03), `scripts/{validate-next-goal,reviewer-harvest}.ts`,
    `package.json` (format-only).
  - Record per-finding fixed-vs-deferred (with rationale) in this map's
    Decisions when closing t01 — warn-layer placement counts as a decision,
    not a blanket ignore.
  - Done when: `bun run check` (biome), `bun run typecheck` (tsc), `bun test`
    all green in-package.

### Phase 2 — wiring proof (the arc's name)

- **t02 — lane run proves BOTH gates execute** (open)
  - Run local_ci scoped to the devops rows (devops chain, never hand-rolled)
    and read the receipt: biome must appear as `check:s2-agent-ext-devops`
    (phase-3a lint row — `scripts.check` matches `/biome/`); tsc must appear
    EITHER as `typecheck:s2-agent-ext-devops` OR as coverage by the
    `typecheck:ext` gate (devops has `extensions/devops.ts` + a tsc script →
    `coveredByExtTypecheckGate` → phase-3a spawns `skipped` with note; the
    GATE then runs the same tsc — a skipped-with-note row beside a green
    `typecheck:ext` gate IS the proof, a skipped row with no gate run is
    NOT). Cite the receipt rows verbatim in the map.
  - Run `bun-apps/tests/lint-executor-coverage.test.ts` — devops becomes the
    7th biome.json package and must carry the identical `check` script
    (dynamic discovery; lands green iff biome.json + script land together).
  - No `ci-recipe.ts` change expected (D3) — if the lane shows a silent drop,
    STOP and re-plan against the recipe's resolution order.

### Phase 3 — ship

- **t03 — deploy iff src changed** (open)
  - 6 src files carry findings; if their fixes edit bytes, run the deploy
    chain (receipt) and sweep merged branches; if biome fixes turn out
    test/script-only, record that and skip with evidence.
- **t04 — one PR through the devops chain** (open)
  - Map + tickets + evidence ride the PR (≤256KB/file, text-only). Review via
    `arc-review.ts --name <harvest-name>`, verdict HARVESTED by name
    (self-arc-22's path). Squash-merge via the chain; version-bump nudge if
    the merge tool raises it.

### Phase 4 — close-out

- **t05 — successor + ledger** (open)
  - Write `output/next-goal-<ts>.md` (strict v2) and repoint VIA
    `repoint-next-goal.ts`; flip map `status`; ledger entry already committed
    (113fb633 — do not renumber).

## Execution order

t01 → t02 → t03 → t04 → t05 (t02 may start the lane run while t03's deploy
scope is being read off t01's diff; t04 bundles everything as ONE PR).

## Decisions

- D1 (2026-09-10): arc number 23 claimed VIA `.planning/arc-ledger.json` at
  branch time (commit 113fb633); RENUMBERED 23→24 (2026-09-10): the parallel session's 2026-09-10-self-arc-23-subagent-steer-deploy landed its ledger claim on main first — the sixth same-number collision, and the FIRST the ledger era caught (my branch's own guard went red on the rebase).
- D2 (2026-09-10, measured): `bunx biome` (BARE package name) resolves to an
  npm squat `biome@0.3.3` that downloads, prints two lines, and exits 0 —
  silently NOT running Biome at all. Never invoke the bare name (recon or
  scripts); the binary is `@biomejs/biome@2.4.16` (hermes pin), invoked via
  the package devDependency + `bun run check`. Operating-learning class: the
  label is not the content.
- D3 (2026-09-10, read from `src/ci-recipe.ts` read-only phase): the recipe
  needs NO change for the split — lint row keys on `scripts.check` iff
  `/biome/.test(cmd)`, then `scripts.lint` iff biome; typecheck row prefers
  `scripts.typecheck`, falling back to `scripts.check` only iff `/tsc/`.
  The split is transparent by name-resolution — but transparency is claimed
  only after t02's lane run shows both gates (the arc-17 silent-drop hazard
  is disproven by receipt, not by reading).
- D4 (2026-09-10, recon): first-ever devops biome run (defaults, no config,
  real binary) = 20 diagnostics / 11 files / 172 checked, exit 1 — the
  sizing fear (biggest ext package) did NOT materialize at defaults. House
  config is LOOSER than defaults where they differ (`noExplicitAny` off,
  `useImportType` off, lineWidth 120 vs 80), so the house run should find a
  SUBSET-plus-format-diffs; arc-18's "real run found more" lesson is kept as
  the t01 acceptance criterion, not assumed away.
- D5 (2026-09-10): the specimen's warn-layer `run-test.ts` override is a
  ROOT-level pattern; devops' file is `scripts/run-test.ts` (5 findings) and
  is NOT covered. t01 decides per-finding: extend the override includes
  with `scripts/run-test.ts` (mirrors specimen intent — it is test-harness
  code) or fix as errors; either way record it here.

## Fog of war

- RESOLVED (planning recon): recipe keying — by script NAME plus a command
  regex (`/biome/` for lint, `typecheck` preferred over `check`-iff-`/tsc/`
  for tsc); the split is transparent, proof pending t02 (D3).
- RESOLVED (planning recon): no devops test or repo-level guard invokes
  devops' own `bun run check` directly — `ci-recipe.test.ts` hits are
  synthetic-fixture tests OF the resolution logic; no scripts-dir-contract
  test exists (nearest repo guards: `lint-executor-coverage.test.ts`,
  `extension-entry-typechecked.test.ts` — both stay green if biome.json +
  script land together).
- OPEN (bounded): how many ADDITIONAL findings the house config surfaces vs
  the defaults recon (expected a subset on the loosened rules; format rules
  differ — 120 width vs 80); t01 measures.
- OPEN: whether the lane receipt renders the tsc proof as a phase-3a
  `typecheck:` row or as `skipped` + green `typecheck:ext` gate (both count;
  t02 records which).

## Cross-effort links

- Builds-on: `2026-09-10-self-arc-19` (decision doc class B + ledger),
  `2026-09-09-self-arc-18` (the hermes split specimen), `2026-09-10-self-arc-22`
  (the named-harvest review path this arc dogfoods third).
- Absorbed-by: none.
