# Ticket 03 — devops parseShConfig + ext-new scaffold + contract suites

Status: done (PR #1967, merged CLEAN 2026-08-24) · Phase 2 (after 01;
parallel-safe with 02 but merges after)

## Close-out notes

- `config.ts` gained `shConfig()` / `excludedExtensionsFromRegistry()` over
  `loadRegistry()`; `parseShConfig` / `excludedExtensions` kept verbatim as
  deprecated YAML-bridge projections, fixture tests only (04 deletes).
- `--config` retired: removed from argv parsing (errors loudly pointing at
  `src/registry-config.ts`), run.ts / deploy-cli.ts read the TS; deploy
  report `configPath` → `registryModule`; verify-deploy-e2e-cli +
  session-doctor-cli derive outRoot via `shConfig()`.
- `ext new` appends a typed REGISTRY entry via `appendRegistryTsEntry`
  (comment-preserving text surgery); `run-dir/registry-insert.ts` + its test
  DELETED here (zero non-test callers after the flip — map D7 revision).
- Contract suites: `registry-base-set.ts` line scanner → relative import of
  `registry-config.ts`; dep-guard + isolation derive from `shippedEntries`;
  `registry-base-set.test.ts` rewritten to real-data invariants (the scanner
  divergence parity it pinned now lives in t01's equivalence net + t02's
  loadRegistry bridge).
- Done-when verified: scratch `ext new` (dynamic) produced a typed entry,
  regen + freshness green with it present, then reverted (entry removed,
  manifest regenerated, bridge tests green).
- map Fog: fresh-worktree CI answered — GitHub CI disabled
  (ci.yml.disabled); working gate is change-scoped local_ci, always
  workspace-linked; D4 relative import belt-and-suspenders. New decision D8:
  probe suite boots deepseek (zai coding-plan quota is not a CI dependency).
- local_ci pass; s2-agent 0.6.8 (bump included in the PR).

## Scope

- devops `src/deploy/lib/config.ts`: `parseShConfig` reads
  `@repo/s2-agent`'s REGISTRY (devops has workspace links — map D4 applies
  only to bun-apps/tests). Keep the exported function shape; deploy CLI,
  deploy-e2e/probe tests, and `config.test.ts`'s real-registry assertion
  switch to the imported truth (the hardcoded name list becomes
  `REGISTRY.filter(ships).map(name)` — no more hand-maintained list, the
  exact failure PR #1958 hit).
- `src/ext-new.ts`: scaffold appends a typed entry (with `enabled: true`,
  `excludeReason`-or-`deploy` prompts) instead of emitting YAML.
- `bun-apps/tests/lib/registry-base-set.ts`: line scanner → relative-path
  import of `registry-config.ts` (link-immune, map D4); dep-guard +
  extension-isolation-contract keep their floors, now over real data.
- Verify the CI-without-install fog (map): do contract suites ever run with
  no workspace links? Record the answer in the map Fog resolution.

## Done-when

- No devops code path reads the YAML; `config.test.ts` derives its expected
  list from REGISTRY (hand-maintained list deleted).
- `bun bun-apps/s2-agent/src/cli.ts ext new` on a scratch package produces a
  registry entry that passes regen + freshness (then reverted — scratch only).
- dep-guard / isolation-contract / config suites green; local_ci green;
  version bumped.

## Notes

The scanner's MIN_EXPECTED floors stay — they are the anti-vacuity guard for
the import path too (an empty REGISTRY import must fail loudly, not pass).
