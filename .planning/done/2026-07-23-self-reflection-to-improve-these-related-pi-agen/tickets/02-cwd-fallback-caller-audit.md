---
type: research
status: closed
closed: 2026-07-23 (charted this session)
---

# 02 — cwd-fallback caller audit: does anything rely on the silent fallback?

## Question

If the silent `<cwd>` fallback in `resolveVaultRoot` is removed (replaced with a loud error), do any existing call sites break? Is cwd-as-vault ever a legitimate, relied-on behavior?

### Context

- `extensions/research-tool.ts` calls `resolveVaultRoot`/`resolveWritePath` from 4 tools.
- [01](01-root-cause-obsidian-config-tier-drift.md) established the fallback is a drift artifact, not intended behavior — but intent ≠ usage; confirm no caller depends on it.

## Resolution — ANSWERED (2026-07-23)

**No caller relies on cwd-as-vault.** All 4 call sites expect a real vault and use resolution only to find it:

- `collect_videos` → `resolveWritePath` (writes `weekly-news/`)
- `organize_vault_notes` → `resolveVaultRoot` (scans vault notes)
- `import_memory_to_vault` → `resolveVaultRoot` + `collections/` (writes jsonl)
- `arxiv_fetch2md` → `resolveVaultRoot` + `papers/` (writes fetched Markdown)

Every one assumes the resolved path *is* the vault. None treats "no vault found → use cwd" as a feature; the fallback is pure silent degradation. **Removing it (erroring when no vault resolves and no explicit override is given) breaks no intended flow** — it only surfaces misconfiguration currently mishandled silently. An explicit `outputPath`/`output_path` already bypasses resolution entirely, preserving the escape hatch.

**Net**: the silent fallback is safe to replace with a loud, actionable error. Unblocks [03](03-fix-approach-drifted-resolver.md).
