**ID:** `ADR-ultracode-0002` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# Pack identity is a path-resolved hash, version-INDEPENDENT

**Status:** accepted (locked 2026-07-19; wayfinder ticket [08-pack-identity-versioning](../../../.planning/2026-07-19-review-the-workflow-pack-feature-via-s2-agent-ex/tickets/08-pack-identity-versioning.md))

A workflow-pack's stable identity (`pack-id`) is `<name-slug>-<sha256(resolvedAbsolutePath).slice(0,12)>`, derived at resolve time and **never** stored in the manifest. It is **version-INDEPENDENT** — the manifest's optional `version` field is pure metadata (groundwork for the deferred self-improve loop), NOT part of the identity. This mirrors the existing `workflowProjectKey` (slug-hash) in `workflow-paths.ts`, and disambiguates same-named packs across locations.

## Considered options

- **`name@version`** — identity-based, location-independent. **Rejected**: a `version` bump would change the identity and orphan the pack's own `runs/`/`outputs/` history (you'd lose every prior run on each release). Also collides when two distinct packs share a name+version.
- **`name` alone** — simplest. **Rejected**: collides across locations (`.pi/workflows/audit` vs `bun-apps/pkgA/workflows/audit` are indistinguishable).
- **Path-resolved hash** ✅ — chosen. Disambiguates by location; stable across version bumps; consistent with the codebase's existing project-key pattern.

## Consequences

- **Checked-in packs redirect state by `pack-id`.** A pack under `bun-apps/<pkg>/workflows/` can't hold writable state, so its runtime state redirects to `.pi/workflows/.state/<pack-id>/` (project-local, never `~/.pi` — honors ADR-0001).
- **Moving a pack changes its `pack-id`** (path-derived). For co-located `.pi/` packs this is fine (state moves with the folder); for redirected checked-in packs, moving orphans the redirected state. Accepted edge.
- **`version` is load-bearing only for human info + future self-improve**, never for identity or state-keying.
