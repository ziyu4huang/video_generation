# Ticket 04 — retire the YAML; invariants + docs land as code

Status: done · Phase 3 (merged PR #1970, CLEAN, 2026-08-24; s2-agent 0.7.0)

## Scope

- Delete the retired YAML registry file (ticket 02/03 removed all
  parsers; verify with repo-wide grep including docs that name it as a FILE to
  edit — CLAUDE.md § Extension packages, devops SKILL.md, ext headers,
  docs/deploy.md).
- Land the full invariant suite (spec §2.3): excludeReason completeness,
  disabled-entry metadata, static order (subagent < ultracode),
  HOST_CONTRACT vs `src/sh/host-modules.ts` equality, one-entry-per-folder +
  entry-file-exists. The equivalence-net tests flip from "TS matches YAML" to
  "legacy shapes are the source" (or get deleted if no consumer needs the
  legacy shapes anymore — prefer deletion).
- Update every doc that describes the add-an-extension workflow: "ONE edit in
  registry-config.ts + regen:manifest" replaces "ONE edit in the YAML".
- CLAUDE.md's Extension packages section + devops SKILL.md references.

## Done-when

- `git grep` of the retired registry filename returns zero hits (history only).
- Invariant suite green incl. in local_ci; `regen:static` still works;
  deploy from a scratch temp registry fixture (deploy-e2e's fixture lane)
  green; local_ci green; version bumped (minor — developer-facing workflow
  change).

## Close-out (PR #1970, merged CLEAN 2026-08-24)

- Deleted: the YAML; `parseRegistry` (run-dir/registry.ts) with its schema
  constants; `parseShConfig`/`excludedExtensions` (devops config.ts); the
  fixture tests (run-dir/registry.test.ts describe, devops config.test.ts
  fixture describes). The equivalence net dropped (map D9) —
  `registryToLegacyShapes()` became `legacyRegistry()` (converter, shConfig
  half deleted); the invariant suite in registry-config.test.ts absorbed the
  rule layer.
- Comment-diff per Notes: the YAML's per-entry comments were ported verbatim
  into `notes:` fields during t01; re-checked before deletion (web-access /
  obsidian / file2md / power-tool externals / webui / hyperframes
  vendor+fontsource / tool-gate history) — nothing measured dropped.
- `$generated` unfrozen → "from src/registry-config.ts by regen:manifest";
  manifest regenerated; `regen:static` byte-identical (17 entries).
- single-registry-guard flips to a zero-mention form (retired filename must
  never reappear in bun-apps/scripts); `git grep` of the filename: zero hits
  repo-wide (docs sweep incl. planning docs + archives).
- GATES: s2-agent 1038/0 + typecheck clean · devops 871/0 + tsc clean ·
  contract suites 168/0 · local_ci pass (merge gate) · deploy-probe fixture
  lane 15/15 (PI_AGENT_E2E=1) · verify-merge CLEAN (58 files,
  +225/−1252, outOfScope []) · version bump minor → 0.7.0.

## Notes

Deleting the YAML also deletes the rich header comments — before removal,
diff the YAML's comment content against `notes:` fields in registry-config.ts
and confirm nothing measured was dropped. The comments are the registry's
institutional memory (vendoring rationale, gate references, ordering rules).
