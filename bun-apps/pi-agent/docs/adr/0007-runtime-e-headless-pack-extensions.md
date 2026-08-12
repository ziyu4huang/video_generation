> **⚠ Deprecated — 2026-07-17 (ticket 03).** This carve-out is **not exercised**: 03 dropped the `-e <pack>` surface — packs run via `workflow run <name|path>`, never via `-e`. Packs are not extensions (ticket 04: dispatch branch), so ADR 0001's extension-loading rule was never in their path. Retained as history of the decision path (02 → 03).

# Runtime `-e` loading permitted for headless pack-extensions (amends ADR 0001)

ADR 0001 made every extension in the `cli` namespace **baked-in** — statically imported
and injected through `extensionFactories` / `extraExtensionFactories`, never
loaded at runtime via `-e` — so that each single-turn run curates a small
agent-session tool surface instead of bloating every invocation with the full
manifest. This ADR adds a **narrow carve-out**: a **headless workflow-pack**
loaded via `-e <pack>` is permitted at runtime.

A workflow-pack (folder of `manifest.json` + an entry workflow script; see the
`workflow-pack-runner` effort) loaded via `-e` does **not** become an
agent-session extension: it registers a CLI sub-command that calls `runWorkflow()`
**directly**, creating no agent session and injecting **zero** tools into any
session. Its execution path is exactly the one `workflow run` already uses —
deterministic, non-agent. Runtime loading here contributes a *dispatch entry*,
not session tools.

That is why ADR 0001's rationale does not extend to packs: the bloat it guards
against is *agent-session tools*, and a headless pack adds none. Permitting its
runtime `-e` load is therefore the minimal reversal — ADR 0001's baked-in rule
still holds unchanged for any extension that *does* inject session tools.

The carve-out is framed by **behavior**, not identity: any runtime `-e`-loaded
extension that registers no agent-session tools and dispatches headless qualifies
(workflow-packs today; other headless sub-command extensions in future).
Rejected alternative: broadly allowing runtime `-e` for *all* extensions and
superseding 0001 — rejected because it re-introduces exactly the per-run
tool-surface bloat 0001 exists to prevent. (the `cli` namespace wires no extension
auto-discovery, so this concerns the explicit `-e` surface only; the `-e <pack>`
resolution convention and the headless factory mechanism are settled separately.)
