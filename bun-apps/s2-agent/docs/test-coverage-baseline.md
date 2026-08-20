# Test Coverage Baseline

> **Baseline captured 2026-07-08** (post-#360, on `feat/verify-hygiene` off `origin/main`).
> Purpose: make "did coverage go up or down" answerable per-PR instead of vibes-based.
> Re-run any section after meaningful test/impl changes and update the numbers here.

## How to run

Every package uses the same one-liner (`bun test --coverage` is native — no extra deps):

```bash
( cd bun-apps/<pkg> && bun run test:coverage )          # text table to stdout
# add BUN Coverage config in package.json / bunfig.toml for lcov if needed later
```

`test:coverage` is wired into: `gui-movie-director` (pre-existing), `pi-obsidian` and
`s2-agent-ext-power-tool` (added in the verification-hygiene pass — PR for goal
`next-goal-20260708_211444`, P1).

## Baseline numbers

| package | tests | % Funcs | % Lines | notes |
|---------|------:|--------:|--------:|-------|
| `pi-obsidian` | 349 pass / 0 fail | **91.16** | **93.75** | new wiring; obsidian.ts 87.97/83.83 |
| `s2-agent-ext-power-tool` | 286 pass / 8 skip / 0 fail | **55.05** | **62.89** | new wiring; many `todo/*` leaves untested (see below) |
| `gui-movie-director` | 616 tests (2 pre-existing fails) | 67.15 | 81.07 | pre-existing wiring; included for comparison |

### pi-obsidian (new)
Strong coverage on the extension surface:
- `extensions/obsidian.ts` — 87.97% funcs / 83.83% lines (the 7-tool surface).
- `lib/graphExport.ts` — 90.91% / 98.53%.
- `lib/vaultReport.ts` — 76.92% / 94.74% (incl. #347's `scheduleVaultBanner`
  stale-ctx guard, which has a dedicated regression test #357 — the high line
  coverage here proves the wiring is live).
- Uncovered obsidian.ts bands are mostly the `zk_*`-migration / edge-error
  formatting tails (lines listed in the `--coverage` table).

### s2-agent-ext-power-tool (new)
Mixed — the pure-logic cores are well covered, the I/O/render leaves are not:
- Well covered (≥90% lines): `ask-user/index`, `goal/format`, `goal/overlay`,
  `index.ts`, `todo/state/{invariants,replay,state,task-graph}`, `state-reducer`.
- **Gaps** (future-test candidates): `todo/view/format` (46%), `todo/todo.ts`
  (46%), `shared/status-widget` (15% lines — mostly the render branch),
  `sdk-patch` (31%), `todo/tool/response-envelope` (5%).

## Maintenance notes

- **`pi-obsidian` real-vault snapshot drifts by design.** `baseline.test.mjs`
  compares against `fixtures/search-baseline.txt`, a snapshot of the *real*
  `vaults_root/s2-agent-vault` submodule (598 notes at capture). It drifts
  whenever vault notes are added/removed — that is intentional. The backward-compat
  *contract* lives separately in `fixtures/frozen-baseline.txt` /
  `baseline-contract.test.mjs` (content-controlled, does **not** drift).
  After a vault-content PR, refresh the snapshot:
  ```bash
  ( cd bun-apps/s2-agent-ext-obsidian && bun run regen:baseline )
  ```
  (Refreshed in this same pass: vault grew 553→598 + dead-link cleanup.)
- The `gui-movie-director` 2 fails (`check-runtime … hard errors`) are
  pre-existing and unrelated to coverage wiring.
