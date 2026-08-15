---
type: grilling
status: closed
closed: 2026-07-23 (work session)
blocked by: 01, 02
claimed: pi-agent (2026-07-23 work session)
---

# 03 — fix approach: re-align in place vs depend on / extract a shared canonical resolver

## Question

Given [01](01-root-cause-obsidian-config-tier-drift.md) (root cause = drifted duplicate) and [02](02-cwd-fallback-caller-audit.md) (safe to drop the cwd fallback), how do we fix `pi-agent-ext-research-tool`'s vault resolution so it sees the same vault the obsidian tools see — **fix the copy in place**, or **stop duplicating** (depend on obsidian-lib / extract a shared resolver)?

### Context

- **Scope tension to resolve first.** Q2 deliberately excluded "cross-package DRY/unification" as a refactor-for-its-own-sake. But [01] showed the drift *is* the root cause — so the DRY question is now *inside* this effort, not separate. Picking "fix in place" keeps DRY out of scope; picking "share/extract" moves the scope boundary. Name this trade-off explicitly before choosing.
- research-tool's `lib/vault.ts` is self-described as "decoupled: no cross-package import" — the decoupling was deliberate (avoid cross-ext deps), and it is exactly what enabled the drift.
- The three concrete things the chosen approach must deliver: (a) read the `~/.pi/obsidian_config.json` personal tier; (b) replace the silent cwd fallback with a loud error (no explicit override → fail with an actionable message: set `OB_VAULT_PATH`, open a vault, or pass `output_path`); (c) keep the explicit-`outputPath` escape hatch.

### Options to grill (one at a time)

1. **Fix in place** — re-align `lib/vault.ts` tiers to match obsidian-lib (add `~/.pi` tier), swap cwd→error. Smallest blast radius, no new cross-ext dependency, but the drift can recur (two copies to keep synced manually).
2. **Depend on obsidian-lib** — research-tool imports `pi-agent-ext-obsidian`'s resolver. Kills the drift permanently, but adds a cross-extension dependency (research-tool → obsidian-ext), couples release cadence, and needs obsidian-lib's export API to be stable (currently fog — see map Not-yet-specified).
3. **Extract a shared `vault-resolver`** — lift the resolver into a shared package both consume. Cleanest long-term, largest change; arguably its own effort if other consumers (knowledge-card, pi-agent-cli) should join.

## (acceptance — becomes the plan after this ticket closes)

The chosen approach, spelled out enough to hand to `writing-plans`: which file(s) change, the new tier set + error contract, and how the explicit-override escape hatch is preserved. The actual code change is post-map execution.

## Resolution — DECIDED (2026-07-23)

**Approach: fix in place + drift-detector contract test (Option A).**

research-tool's `lib/vault.ts` stays self-contained (no runtime cross-ext dependency — preserving the deliberate extension-independence that motivated the original decoupled copy), but is re-aligned and guarded:

1. **Re-align tiers to obsidian-lib's canonical set**: `OB_VAULT_PATH` env → `~/.pi/obsidian_config.json` (personal — the missing tier) → `<cwd>/.pi/obsidian_config.json` (project) → `run-dir/obsidian_config.json` → **error** (no silent cwd). Honor `mode="app"` semantics where feasible, or document the deviation.
2. **cwd fallback → loud, actionable error**: when no vault resolves and no explicit `outputPath`/`output_path` is given, throw naming the fixes (set `OB_VAULT_PATH`, open a vault via the obsidian extension, or pass `output_path`). Explicit override still bypasses resolution — [02](02-cwd-fallback-caller-audit.md) confirmed safe.
3. **Drift-detector contract test** (dev-only import of obsidian-lib): assert research-tool's resolved vault == obsidian-lib's `resolveVault(cwd)` for the same config inputs across all tiers. Future tier drift fails the test loudly — same philosophy as the `_Source:` liveness check. Runtime stays decoupled; only the test dev-depends on obsidian-lib.

**Why not depend on obsidian-lib (option B)**: `resolveVault(cwd)` is exported (`obsidian-lib.ts:356`, reachable via the package `./src/*` export) and would be a one-line fix, but it couples research-tool's deployability to obsidian-ext's presence — precisely the extension-independence the original decoupled copy preserved. Fix-in-place + test gets the correctness without that coupling.

**Scope consequence**: this confirms broader cross-package DRY/unification stays OUT of scope. The drift is fixed at its one known site with a recurrence guard, not via a shared-lib refactor.

**Handoff → `writing-plans`**: re-align `lib/vault.ts` tier set + error contract; add the contract test; rewrite the `vault.ts` header comment (drop the now-false "mirrors… decoupled" framing → "re-aligned to obsidian-lib; guarded by drift test"). No further decisions blocked.
