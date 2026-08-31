# MOC Regen on Hierarchy Build — Design

**Date:** 2026-08-31
**Status:** Shipped (branch `t06-moc-regen-on-hierarchy-build`)
**Scope:** `bun-apps/s2-agent-ext-hermes-memory/src/handlers/hierarchy-build.ts` + `src/walk-and-ingest.ts` (tests in both packages)

## Problem

Every hierarchy build left the vault MOC (`Tags/Knowledge Graph.md`) stale.
Measured 2026-08-30 on this machine (the t14 fold-back converge receipt run):
`runConverge` → `ingestRecords` regenerated the MOC and caught up **+407
insertion-only agg-L0..L3 links** that had accumulated since vault PR #21
(t06's first hierarchy build, `d3abad1`, 2026-08-2x). The staleness is
structural, not one-off:

1. **Ordering** — `walkAndIngest` heals the graph at step 7
   (`walk-and-ingest.ts` `kp.healGraph(...)`), then fires the hierarchy build
   at step 8e (`fireHierarchyBuildBestEffort`). The agg cards land AFTER the
   MOC regeneration, so the MOC cannot know them.
2. **No later healer** — the MOC is regenerated only by ingest lanes and
   `pipeline lint/run`; nothing runs after a build.

Consequence beyond the vault being dirty: the obsidian A0.9 search baseline
(`s2-agent-ext-obsidian/extensions/__tests__/fixtures/search-baseline.txt`)
records real-vault line numbers, so a stale-then-caught-up MOC shifts lines
under it and fails `s2-agent-ext-obsidian` local_ci on the next gitlink bump
(paid manually in PR #2173).

## Decision

**Heal at the fire site, via the seam hermes already owns** — after
`kp.buildHierarchy` resolves (and is not `skipped`), the fire-and-forget
handler calls `kp.healGraph({vaultPath, folder, mocPath})`. Rationale:

- The `KnowledgePipeline` seam contract already documents this exact usage
  ("hermes calls it AFTER ingest to keep the vault graph healthy") — the fix
  is one more call at the one place builds complete.
- zk's `buildHierarchy` stays PURE (hierarchy-build.ts imports only
  hierarchy/aggregation-write/llm-chat by design); it knows `kbDir`, not the
  vault root or MOC path, and deriving them from `kbDir` would hard-code a
  layout assumption the hermes side holds natively.
- `healGraph` is idempotent and deterministic (regenerates the MOC from
  on-disk cards), and its orphan cascade (ticket 03) runs BEFORE the MOC
  regen — a build whose agg children are on disk (the production shape) is
  never pruned.

Alternatives rejected: (a) buildHierarchy writing the MOC itself — purity
break + path derivation; (b) reordering walkAndIngest (build before heal) —
still leaves CLI/other build lanes unhealed and couples the fire to the walk.

## Guardrails

- `skipped` builds (e.g. `no-entities`) do NOT heal — no agg cards were
  written, the MOC state is untouched.
- Heal failure is isolated from build failure in the warn log (the build
  itself completed; a heal error must not read "build skipped/failed").
- The returned promise is awaitable (tests pin the build→heal call order);
  production callers stay fire-and-forget.
- Legacy call shape (no heal target) is unchanged — build only.

## Verification

- `s2-agent-ext-hermes-memory/tests/handlers/hierarchy-build.test.ts` —
  order-pinned fake-seam tests: completed build → healGraph with the target;
  skipped → no heal; heal failure isolated; skip guards short-circuit.
- `s2-agent-ext-knowledge-card/__tests__/hierarchy-moc-freshness.test.ts` —
  production-shape pair test (real temp vault, ingest → buildHierarchy from
  disk → healGraph): pins `mocStale: true` after the bare build (the gap),
  then `mocStale: false`, `ok: true`, and MOC byte-equal to `buildMocContent`
  output (the graph-health drift seam) after the heal; second run idempotent.
- Canonical gates: hermes-memory `check` (tsc) + `test` 1564 pass;
  knowledge-card `typecheck` + `test` 801 pass (2026-08-31, this machine).

## Follow-ups (tracked in the successor next-goal, not this change)

- `.distill-state.json.tmp` vault gitignore entry — batch into the next
  vault-side PR (never a gitlink-only PR).
- s2-agent patch version bump — dormant, trigger = next `bun-apps/s2-agent/**`
  PR (this change does not touch it).
