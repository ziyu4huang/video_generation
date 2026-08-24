# Ticket 01 — typed registry module + equivalence net (YAML stays authoritative)

Status: open · Phase 1 (gates the rest)

## Scope

Create `bun-apps/s2-agent/src/registry-config.ts` per spec §2.1: typed
`RegistryEntry[]` + `DEPLOY_CONFIG` + `HOST_CONTRACT`, zero imports,
side-effect-free (pre-load-providers doctrine). Migrate today's 24-entry
registry verbatim as data — including the two disabled entries (tool-gate,
hyperframes) as `enabled: false` + `disableReason` + `reEnableNote` (map D2),
and sv-analyzer's deploy-exclusion as an `excludeReason` entry.

Add `registryToLegacyShapes()` (pure): produce the exact structures today's
`parseRegistry(yaml)` and devops `parseShConfig(yaml)` return.

## Approach

1. Port the entry data mechanically from `s2-agent.registry.yaml` (comments
   become per-entry `notes:` strings — the measured rationale must not be lost;
   they are the registry's real documentation).
2. Unit tests in `src/registry-config.test.ts`:
   - deep-equal `registryToLegacyShapes()` vs `parseRegistry(readFileSync(yaml))`
     and vs `parseShConfig(yaml)` on the REAL repo file (the equivalence net,
     spec §3);
   - every non-deploy entry has `excludeReason`; every disabled entry has
     `disableReason` + `reEnableNote` (first invariants, land early).
3. NO consumer changes in this ticket — YAML remains authoritative everywhere.

## Done-when

- Module exists, zero-import (asserted by a test that reads the file and
  greps for `^import`/`require(`), 100% of current entries present as data.
- Equivalence tests green against the real YAML on this machine AND in local_ci.
- `bun run --cwd bun-apps/s2-agent test` canonical gate green; version bumped.

## Notes

The zero-import constraint (map D4) is what lets bun-apps/tests contract
suites read the module via relative path in ticket 03 without workspace links.
If an import turns out unavoidable, STOP and re-decide at the map level (D4
breaks).
