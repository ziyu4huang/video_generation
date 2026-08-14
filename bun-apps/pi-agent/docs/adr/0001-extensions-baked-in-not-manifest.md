**ID:** `ADR-pi-agent-0001` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

> **Amended 2026-08-12 (pi-agent-cli merge).** The CLI now lives inside `pi-agent`
> (`src/cli/`), so "pi-agent-cli" and "pi-agent" below name the two *entry
> namespaces* of one package, not two packages. The decision is unchanged and is
> now what the `src/cli.ts` argv intercept exists to preserve: the `cli` token is
> handled BEFORE `applyPatches()`, so a CLI run never gets the run-dir `-e`
> splice and per-command tool curation stays meaningful.

# Extensions baked-in as static imports, not loaded via run-dir manifest

The `cli` namespace statically imports every extension's factory and injects it through
`resourceLoaderOptions` (pi-obsidian always-on; all others per-command via
`extraExtensionFactories`), instead of loading extensions from pi-agent's
`run-dir/manifest.json` at runtime. The trade-off: pi-agent (the interactive
TUI) eagerly loads the *entire* manifest because a user may want any tool
mid-session, but `pi-agent cli` runs single-turn workflows that **curate tools per
command** (e.g. `zk-extract` passes only the distill tools). Loading the full
manifest would bloat every run with extensions (`pi-flux2`, `zai-mcp`, …) the
command never uses. Both paths resolve to the same underlying factory; the
difference is the *load mechanism* (direct import vs `-e` argv), chosen to match
each entry point's execution model.
