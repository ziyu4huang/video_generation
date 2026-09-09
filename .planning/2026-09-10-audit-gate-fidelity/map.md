---
effort: 2026-09-09-self-arc-18
created: 2026-09-09
last: 2026-09-09
status: active
---

# Wayfinder map: 2026-09-09-self-arc-18 — gate fidelity: the audit instrument, check-script standardization, and the measured truth about arc-17's "64 reds"

> ARC-NUMBER COLLISION NOTE (rebase 2026-09-10): this effort was planned as
> "self-arc-18 t01" in parallel with the hermes-memory maintenance arc-18
> (#2238, map at `.planning/2026-09-09-self-arc-18/`) — same number claimed
> twice on the same day (4th collision in the series). Relocated to
> `2026-09-10-audit-gate-fidelity/` at rebase time; the ledger-check proposal
> in the deep-exploration findings targets exactly this failure class.


## Destination

The maintenance-mode self-develop loop measures honestly: the committed audit
workflow (`samples/audit-ext-packages.js`) derives every gate command from each
package's own scripts (provenance recorded in the output schema), runs an
install preflight (arc-17 D8 as code) so stale installs classify as
`env-drift` instead of red; devops `local_ci` reports name-resolved gates it
skips as skip-with-reason instead of silently passing; all 26
`s2-agent-ext-*` packages define a `check` script pinned by a workspace
contract test; and one real audit re-run over all 26 packages is the closing
receipt. The arc-17 successor framing ("test-hygiene arc: 64 failing tests")
is corrected in both maps: the re-verification showed the reds were instrument
artifacts, and the fix is the instrument, not phantom test failures.

## Context

Measured 2026-09-09 on tip 6d225ca2 (this box, executor-run — the D3
receipts) unless cited otherwise:

- **The arc-17 dispositions re-verified**:
  - file2md `bun run test`: RED as reported (122 pass / 26 fail / 23 errors,
    exit 1) — but the cause is a stale workspace install (`tesseract-wasm`
    declared `^0.11.0`, absent from `node_modules`; `Cannot find package`
    load errors hid ~172 of 320 tests). After `bun install` from `bun-apps/`:
    **319 pass / 1 named skip (live engine) / 0 fail, exit 0**.
  - hyperframes: canonical `bun run test` (= `bun test tests/`) **60 pass / 0
    fail, exit 0**. Bare `bun test`: 359 tests across 50 files — 49 test files
    swept from `node_modules/@hyperframes/*` — 321 pass / 31 fail / 7 skip,
    exit 1. The audit's "34 fail / 325 pass" is this bare-run sweep: the audit
    ran the wrong gate.
  - check census: **exactly 19/26 ext packages lack a `check` script** (7
    have it: devops, file2md, hermes-memory, subagent, superpowers,
    ultracode, wayfind). CONFIRMED as systemic.
  - sv-analyzer "silent wasm skips": the skips are
    `describe.skipIf(!existsSync(WASM))` with the regeneration policy
    documented in the test header, skip names printed by bun. Non-issue by
    design.
- **Root cause in the instrument**: `audit-ext-packages.js` step 3 hard-codes
  `bun test` for every package and no step installs first — violating the
  arc-17 map's own rule ("derive its command list from each package.json's
  scripts") and ignoring its D8 (stale/dangling installs produce fake reds).
- **Package inventory unchanged**: 26 `s2-agent-ext-*` packages (arc-17
  audit's census; `s2-agent`, `s2-agent-core-interface`,
  `s2-agent-core-runtime` remain excluded by the charter's literal scope).
- **Gates vary per package** (arc-17 context, still true): devops/hermes-memory
  `check` = `tsc --noEmit`; file2md/subagent/superpowers/ultracode/wayfind
  `check` = `biome check .`; hyperframes scopes tests (`bun test tests/`);
  file2md runs `bun test --isolate`; webui has `test:unit` only; zai-mcp has
  no test script.
- **Driver exists and is proven**: `samples/run.ts` +
  `PI_MODEL=zai/glm-5.3` (`ZAI_API_KEY` must be sourced from `~/.zshrc`);
  arc-17 measured 15–30 min wall-clock for 27 children, bounded 7-wide
  parallel batches (D7).
- **local_ci resolves gates by script NAME** (devops `local-ci`), which is why
  a missing `check` script means silently skipped lint — the consumer-side
  half of the systemic finding.

## Tickets

**Execution order:** 01 → 02 → 03 → 04 (confirm-gate 2026-09-09: user
away; recommended defaults auto-confirmed — scope re-base D2 + instrument-first
order; 01/02/03 are choice-ordered, 04 hard-blocked by all three)

Phase 1 — fix the instrument:
- [x] `tickets/01-audit-gate-fidelity.md` — implemented on
      `self-arc18-t01-gate-fidelity` (Resolution in the ticket): script-derived
      gates + provenance + preflight + env-drift verdict; reviewer APPROVE
      after 4 fixes; gates green; LIVE 3-package receipt matches the
      hand-measured results (file2md + hyperframes green via their own
      scripts; zai-mcp absent gates recorded).

Phase 2 — make the consumer honest:
- [ ] `tickets/02-local-ci-skip-loudness.md` — local_ci reports gates skipped
      for a missing script as skip-with-reason (per package, in the outcome +
      summary); unit-pinned.

Phase 3 — standardize the surface:
- [ ] `tickets/03-check-scripts-workspace.md` — add `check` to the 19 packages
      per the derivation rule (biome or tsc, mapping table in the PR); devops
      contract test pins 26/26 define check (+test).

Phase 4 — receipt + close:
- [ ] `tickets/04-closeout-rerun.md` — real audit re-run (26/26 receipt,
      file2md + hyperframes green via canonical scripts), arc-17/18 map
      reconciliation, retrospective addendum, successor next-goal
      (maintenance queue: MC tickets, #2179, …).

## Decisions

- **D1 (2026-09-09)**: Arc number **18** claimed at SEED time; per arc-17 D1's
  lesson (numbers are claimed at merge; renumber at rebase), expect
  renumbering if a parallel session merges an 18 first. Reason: two same-day
  collisions already happened (14, 15).
- **D2 (2026-09-09)**: Scope re-base on measured truth. Arc-17's successor
  framing ("test-hygiene: 64 failing tests is its own arc") is SUPERSEDED by
  today's receipts: file2md's reds were env-drift, hyperframes' reds were
  vendored tests swept by the wrong gate, sv-analyzer's skips are by-design.
  The arc fixes the instrument + the gate surface; no phantom test fixes.
  Reason: D3 discipline — the executor's deterministic re-run is the receipt,
  and it changed the work.
- **D3 (2026-09-09)**: Canonical gate = the package's own `package.json`
  script, never a bare command. Gates with no script are `absent` (recorded),
  never silently passed. Reason: hyperframes receipt; arc-17 context rule the
  committed script violated.
- **D4 (2026-09-09)**: Install preflight runs before any gate measurement in
  the audit driver (workspace `bun install` from `bun-apps/`, the sanctioned
  form), recorded in the run receipt; module-resolution failures classify as
  `env-drift`, distinct from red. Reason: file2md receipt; arc-17 D8 made code.
- **D5 (2026-09-09)**: Per-ticket PRs through the devops chain; planning
  artifacts ride the first PR. t02 touches devops src/ → redeploy + qualify
  sweep per the arc-17 D5 precedent ("iff src/ changed"); t01 is samples/ +
  tests (likely no redeploy — verify scripts-dir-contract stays green).
- **D6 (2026-09-09)**: sv-analyzer disposition: by-design documented skip
  (`skipIf` on a regenerated gitignored wasm), closed no-action — recorded in
  t04's receipt, not fixed. Reason: the test header documents the policy; the
  audit's "silent" note did not survive re-verification.
- **D7 (2026-09-09)**: check-script derivation rule: biome config present →
  `"check": "biome check ."`; tsc-only package → `"check": "tsc --noEmit"`
  (devops/hermes precedent); no new tooling invented. The 19-package mapping
  table lives in t03's PR.

## Frontier

`t01` — preferred first (fix the instrument before re-measuring), but `t01`,
`t02`, `t03` are all frontier-eligible (no blocking edges between them;
parallelizable in principle, executed one at a time per the loop). `t04`
consumes all three.

## Fog of war

- Which of the 19 packages have a biome config vs tsc-only — runtime data,
  derived at t03 time (the mapping table).
- Whether bun offers an install-freshness check cheaper than a full
  `bun install` (idempotent, ~seconds here) — t01 picks the cheapest honest
  form.
- The real re-run's verdict mix: today's census says green-or-absent
  everywhere, but the audit children also produce improvementNotes — volume
  unknown until the run (triage rule: record, don't absorb).
- Redeploy need after t02 (devops src/) — precedent says yes; confirm the
  launcher version lineage at t02 time.
- Wall-clock/token cost of the closing re-run — arc-17 measured 15–30 min;
  record actuals in t04.

## Cross-effort links

- Builds-on / corrects: `2026-09-09-self-arc-17` (its Shipped-as named this
  successor; its "64 failing tests" disposition is superseded by this map's
  measured receipts — D2; its D3/D8 disciplines become code here). Both maps
  get the cross-link per the standing rule.
- Shares-decision-with: `2026-09-09-self-arc-16` (receipt discipline: no red
  believed or dismissed without an executor re-run).
- Maintenance-mode queue (NOT this arc): merge-chain MC tickets, #2179,
  tui-drive screenText-freeze audit, rpc-pair widening, true turn-time
  instrumentation — successors recorded in arc-17's retrospective.
