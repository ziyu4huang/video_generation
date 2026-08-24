# Ticket 03 — devops parseShConfig + ext-new scaffold + contract suites

Status: open · Phase 2 (after 01; parallel-safe with 02 but merges after)

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
