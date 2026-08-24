# Ticket 02 — flip the run-dir consumers to the TS module

Status: open · Phase 2 (after 01)

## Scope

`run-dir/registry.ts` (authority), `run-dir/registry-to-manifest.ts`,
`scripts/regen-manifest.ts`, `run-dir/registry-insert.ts` stop parsing YAML and
import `src/registry-config.ts`. `run-dir/manifest.json` stays DERIVED with the
freshness + single-registry-guard gates unchanged (map D3).

## Approach

1. `registry.ts`: keep its validation surface (the invariants it enforces on
   parse move to validation-over-REGISTRY), keep exported types stable so
   downstream imports don't churn.
2. `regen-manifest.ts` / `registry-to-manifest.ts`: read REGISTRY; regen and
   commit manifest.json — byte-identical expectation (equivalence net from 01
   proves it; a diff here means the net was wrong — investigate, don't force).
3. `registry-insert.ts`: determine its real callers (map Fog: runtime YAML
   surgery vs repo-time). If run-dir extensions inject at runtime, the
   manifest.json path must cover it — PROVE no compiled-binary path reads the
   YAML (map Fog item; this ticket closes it).
4. Keep the YAML file physically present but no longer read by these four
   (devops still reads it until 03); add a header line marking it
   "superseded pending ticket 04".

## Done-when

- The four consumers import REGISTRY; `grep -l "s2-agent.registry.yaml"` in
  bun-apps/s2-agent returns only docs/tests.
- `regen:manifest` output byte-identical to pre-flip manifest.json.
- Freshness, single-registry-guard, registry-to-manifest tests green;
  local_ci green; version bumped.

## Notes

If registry-insert turns out to serve the dynamic run-dir loading lane
(`registry-insert.ts` name suggests insert-into-YAML for dynamic exts), its
replacement is an in-memory insert + regen — design note goes back to the map
as a Decision before implementing.
