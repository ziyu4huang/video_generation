**ID:** `ADR-wayfind-0002` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# ADR-0002: Shared status widget + command consolidation across wayfind and planning-with-files

Date: 2026-07-17
Status: partially superseded — Decision 1 (shared status-widget `workspace:*`
dependency) reversed by [ADR-0004](./0004-decouple-status-widget-via-global.md);
Decision 2 (command consolidation: `/grill`, `/wayfind`) still accepted.

> **Historical note (2026-07-18):** `pi-agent-ext-planning-with-files` was
> removed in PR #620. The shared-widget design this ADR established still holds
> for wayfind; the `planning-with-files` party no longer ships, and the
> coordination seam it published (`__piPlan*`) is now read best-effort by
> wayfind / core-task (graceful no-op when absent). The references to
> "planning-with-files" below are retained as the historical record of this
> decision.

## Context

wayfind and planning-with-files each wrote directly to the TUI footer via
`ctx.ui.setStatus(PKG_NAME, text)`. Both status lines rendered simultaneously —
the `globalThis.__piWayfindActive` seam was published but its documented
"plan-coordinator yields" was never implemented (no consumer ever read it; the
seam was later removed — see ADR-0006), so nothing actually hid a line.
Separately, the two packages exposed 19 top-level slash commands
with overlapping naming intent (wayfind's `/plan-seed` read as part of
planning-with-files' `/plan-*` namespace).

## Decision

1. Promote `pi-agent-ext-core-task`'s `CoreTaskStatusWidget` to a
   `globalThis`-backed singleton (`getSharedStatusWidget()`), exposed via the
   package's `./src/*` + `./src/*.js` export map entries. wayfind and
   planning-with-files take a `workspace:*` dependency on core-task and each
   register one `StatusSection` (order 2 and 3, after goal=0/todo=1) instead
   of an independent footer line.
2. Consolidate wayfind's 10 commands into `/grill [me|docs|done|domain]` and
   `/wayfind [<destination>|status|spec|tickets|seed|sync]`, and
   planning-with-files' 9 commands into
   `/plan [status|execute|done|attest|goal|loop|list|lint|switch]`. Old
   command names are removed with no aliases — this is an internal dev-tool
   CLI, not a public API.

## Consequences

- wayfind and planning-with-files now hard-depend on core-task for status
  display; if core-task is not loaded, their status sections simply never
  render (no fallback to standalone `setStatus`). Acceptable because
  core-task is already the earliest-loaded core package in
  `bun-apps/pi-agent/run-dir/manifest.json`.
- The singleton MUST be `globalThis`-backed, not a module-level `let
  instance` — pi loads extensions via jiti, and jiti-loaded module identity is
  not guaranteed to match a native `import()` of the same package (the same
  reason the `globalThis`-backed `__piGoalActive` / `__piPlan*` keys use
  `globalThis`). A module-level singleton would silently give
  wayfind and planning-with-files disconnected widget instances. The
  singleton guard also cannot rely on `instanceof` for the same cross-loader
  reason — it uses existence, not class-identity, checking.
- The shared widget's `dispose()` tears down every registered package's
  section, not just the caller's — only `pi-agent-ext-core-task`'s own
  `session_shutdown` handler is allowed to call it. wayfind and
  planning-with-files each dispose only their own small overlay object.
- Breaking, hard-to-reverse change for anyone with muscle memory around the
  old command names — no aliases are kept.
  Full spec: `.planning/2026-07-17-wayfind-pwf-unification/spec.md`.
  Full implementation plan: `.planning/2026-07-17-wayfind-pwf-unification/plan.md`.
