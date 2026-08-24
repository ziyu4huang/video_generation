# Ticket 04 — retire the YAML; invariants + docs land as code

Status: open · Phase 3 (after 02+03)

## Scope

- Delete `bun-apps/s2-agent/s2-agent.registry.yaml` (ticket 02/03 removed all
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

- `git grep s2-agent.registry.yaml` returns zero hits (history only).
- Invariant suite green incl. in local_ci; `regen:static` still works;
  deploy from a scratch temp registry fixture (deploy-e2e's fixture lane)
  green; local_ci green; version bumped (minor — developer-facing workflow
  change).

## Notes

Deleting the YAML also deletes the rich header comments — before removal,
diff the YAML's comment content against `notes:` fields in registry-config.ts
and confirm nothing measured was dropped. The comments are the registry's
institutional memory (vendoring rationale, gate references, ordering rules).
