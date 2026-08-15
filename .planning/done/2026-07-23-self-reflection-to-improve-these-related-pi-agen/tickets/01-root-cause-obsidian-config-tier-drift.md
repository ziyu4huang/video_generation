---
type: research
status: closed
closed: 2026-07-23 (charted this session)
---

# 01 — root cause: research-tool's vault resolver is a drifted copy of obsidian-lib

## Question

Why does `pi-agent-ext-research-tool`'s `resolveVaultRoot` miss the configured vault and silently fall back to `<cwd>`? Specifically: who owns/writes `obsidian_config.json`, what is the canonical resolution tier set, and where does research-tool's copy diverge?

### Context

- Incident 2026-07-18: `arxiv_fetch2md` wrote a paper to the repo root instead of the active vault because `obsidian_config.json` was absent from the tiers research-tool checks and `OB_VAULT_PATH` was unset.
- research-tool's `lib/vault.ts` header comment states it "mirrors the obsidian extension's vault tiers (decoupled: no cross-package import)".

## Resolution — ANSWERED (2026-07-23)

research-tool's `lib/vault.ts` is a **decoupled copy that has drifted** from the canonical resolver `pi-agent-ext-obsidian/src/obsidian-lib.ts`. Two concrete divergences cause the footgun:

1. **Missing `~/.pi/obsidian_config.json` (personal) tier.** obsidian-lib reads three config locations — `run-dir/obsidian_config.json`, **`~/.pi/obsidian_config.json` (user-global default, per obsidian-lib:142/189)**, and `<cwd>/.pi/obsidian_config.json` (per-project). research-tool's copy reads only run-dir (its 1b) and `<cwd>/.pi` (its 1c) — it **omits `~/.pi`**. When the vault is configured user-globally (the documented default), research-tool never sees it.
2. **Silent cwd fallback replaces obsidian-lib's `mode="app"` tier.** obsidian-lib's last tier follows the Obsidian app's open vault (`mode: "app"`). research-tool's copy replaces this with `return cwd` — a silent, semantically-wrong degradation (cwd is never "the vault").

**Ownership**: the config is written/read by the **obsidian extension** (`obsidian-lib.ts` imports `writeFile` and defines all three paths + the `mode` schema). Nothing in research-tool writes it; research-tool only reads a stale subset.

**Net**: the footgun is not "config is missing" — it's "research-tool reads a drifted subset of tiers, so a correctly-configured vault is invisible to it." The fix is about resolver alignment, not config creation. This reframes [03] (see its scope-tension note).
