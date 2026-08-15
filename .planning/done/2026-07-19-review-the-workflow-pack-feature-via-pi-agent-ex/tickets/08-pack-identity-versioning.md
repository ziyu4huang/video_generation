## Question

What is a pack's **stable identity** (`pack-id`) for keying pack-local state, and does the manifest gain a **`version`** field (groundwork for the deferred self-improve loop, harmless now)?

type: grilling
status: closed
claimed: work-session (2026-07-19)  — 3rd ticket this session (override; user "直接做 08")

blocked by: _(none — frontier)_

## Context

Pack-local state (03) is keyed by pack identity, but resolution today is by *name/path* and names collide across locations (`.pi/workflows/x` vs `bun-apps/pkg/workflows/x`). Decide the `pack-id` derivation: manifest `name` alone (collision-prone), `name@version`, or a path-resolved hash. Decide whether `version` is semver / date / integer and where it's validated (`workflow-pack-manifest.ts`). This blocks repeat-run semantics (11) and is groundwork for the out-of-scope self-improve loop (a pack that improves itself must be versioned) — but build ONLY the identity/version primitive here, not the loop.

## Resolution

**pack-id = path-hash (version-INDEPENDENT); `version` = optional semver-recommended metadata.**

1. **pack-id = `<name>-<sha256(resolvedAbsPath)[:12]>`** — mirrors the existing `workflowProjectKey` pattern in `workflow-paths.ts` (`slug + "-" + sha256(absPath).slice(0,12)`).
   - **Version-INDEPENDENT** — bumping `version` never changes pack-id, so it NEVER orphans `runs/`/`outputs/`. (This is the argument that killed `name@version`: a version bump would detach a pack from its own history.)
   - Disambiguates same-named packs across locations (`.pi/workflows/audit/` vs `bun-apps/pkgA/workflows/audit/` → different hashes).
   - **Derived at resolve time** (`resolveWorkflowPack`), NOT stored in the manifest. Stable per-location.
   - Load-bearing uses: (a) tooling disambiguation (`workflow pack list/clean <name>` resolves to a unique pack-id when names collide); (b) the **checked-in-pack state-redirect key** (map fog — a pack under `bun-apps/<pkg>/workflows/` can't hold writable state, so its state redirects to a pack-id-keyed location; mechanics → 07/13). For co-located packs (`.pi/workflows/<name>/`) pack-id is informational (state is in-place).

2. **`version` = optional manifest field, semver RECOMMENDED, validated as a non-empty string ONLY** (lenient — NO strict semver parse in v1; optional LINT later). Add to the optional-string field set in `workflow-pack-manifest.ts` (`validateManifest`), alongside `model`/`thinking`.
   - NOT part of pack-id.
   - Pure metadata now: human info, display, groundwork for the (out-of-scope) self-improve loop. semver chosen so a future self-improve pass can distinguish breaking-change (major) from improvement (minor/patch).
   - This is the **pack-version**; distinct from **run-version/output-version** (11) — already sharpened in 11's resolution.

**Deferrals:** the actual redirect mechanics for checked-in packs → 07 (scaffolder) + 13 (backward-compat); strict semver enforcement → future (only if/when self-improve consumes it).
