# 03 — Path A: inline-focusable status bar (deferred follow-up)

## Question

The literal "click on the status bar" UX — Down moves focus **into** the status bar (hover-highlight + Enter on an element) rather than opening a separate panel. This is the polished vision the panel MVP (Path C) defers.

## Why deferred

- Requires a **core patch** to `pi-coding-agent` (compiled dep): a new focus-target type, key routing to widgets, editor-yields-on-Down-at-bottom, and a hover-state hook. The repo's `bun-apps/pi-agent/src/patches/` monkey-patch flow is the delivery path.
- High effort; crosses into the compiled core (the project's standing preference is to keep changes on the extension/SDK surface; a core change is a separate effort).
- The panel MVP (tickets [01](01-panel-content-and-element-actions.md) + [02](02-trigger-mechanism.md)) captures the user's core intent ("select element → trigger function") without the core work.

## When to pursue

Only if, after the panel MVP ships, the inline-hover polish is worth a core patch. If pursued, it seeds a **fresh** `.planning/<date>-inline-focus-core-enhancement/` effort (it's a core change, not an extension change) — this ticket just tracks it.

type: task
status: closed
blocked by: (none — independent future effort)

## Resolution (2026-08-09)
WON'T-DO / retired. The inline-focusable status bar (Path A core-patch follow-up)
is not being built. v1 (PR #1019) was deleted 2026-08-07 for TUI bugs (38fe1372 —
onTerminalInput teardown unreliable; 50906350 — orphaned bottom-center overlay →
invalidate() re-entry cascade → RangeError). A robust rebuild (this effort,
PR #1094) was chartered to avoid both bugs via pi.registerShortcut + an
overlay-free inline CustomEditor, but remained unstarted. Decision (2026-08-09):
retire as won't-do — the below-editor static status shipped in PR #999 (aa09621c)
is sufficient.
closed: 2026-08-09 (wontfix)
