# Extensions baked-in as static imports, not loaded via run-dir manifest

pi-agent-cli statically imports every extension's factory and injects it through
`resourceLoaderOptions` (pi-obsidian always-on; all others per-command via
`extraExtensionFactories`), instead of loading extensions from pi-agent's
`run-dir/manifest.json` at runtime. The trade-off: pi-agent (the interactive
TUI) eagerly loads the *entire* manifest because a user may want any tool
mid-session, but pi-agent-cli runs single-turn workflows that **curate tools per
command** (e.g. `zk-extract` passes only the distill tools). Loading the full
manifest would bloat every run with extensions (`pi-flux2`, `zai-mcp`, …) the
command never uses. Both paths resolve to the same underlying factory; the
difference is the *load mechanism* (direct import vs `-e` argv), chosen to match
each entry point's execution model.
