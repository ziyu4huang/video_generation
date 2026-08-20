# Extension UI Conventions

How persistent and transient user-facing state is surfaced in this repo's s2-agent
extensions (`bun-apps/s2-agent-ext-*`). This doc exists so every new persistent
feature picks the **right** display tier instead of copy-pasting the wrong one —
the mistake that left `/goal` on a bare footer fragment for months (fixed in PR
#324 + the overlay-unification work).

## The four UI tiers

Extensions interact with the user through four distinct surfaces. Pick by
answering "how persistent, how prominent, how interactive?"

| Tier | API | Persistence | Prominence | Interactivity | Use for |
|---|---|---|---|---|---|
| **1. Above-editor widget** | `ctx.ui.setWidget(key, factory, {placement:"aboveEditor"})` | persistent (until cleared) | high — always visible above the input | none (render-only) | ongoing state the user must keep in view: active goal, todo list |
| **2. Custom dialog** | `ctx.ui.custom(factory)` / `select` / `confirm` / `input` | transient (modal) | blocking — takes over the screen | full (keyboard) | required user input: ask-a-question, confirmations |
| **3. Footer status fragment** | `ctx.ui.setStatus(key, text)` | persistent | low — one uncolored line in the footer, label-less | none | ephemeral one-word indicators (rarely the right choice) |
| **4. Tool output** | tool `execute()` return value | transient (turn-scoped) | inline in the conversation | none | reports: analysis, query results, health audits |

## Decision rule

1. **Is it ongoing state the user needs while the agent works?** → Tier 1 (widget).
   Examples: the active `/goal` + its iteration/elapsed, the todo list. If the
   agent works autonomously and the user watches, the state belongs in a widget.
2. **Does it block until the user answers?** → Tier 2 (dialog). Examples:
   `ask_user_question`, "replace goal?" confirmations.
3. **Is it a one-word status token with no semantic color needs?** → Tier 3
   (footer). Almost never the right answer for anything the user must NOTICE —
   `setStatus` renders a bare, uncolored, **label-less** fragment sorted
   alphabetically with other extensions. A paused goal and an active goal looked
   identical there. Reserve it for trivial indicators only.
4. **Is it a report the user reads once and moves on?** → Tier 4 (tool output).
   Examples: `inspect_context`, `inspect_agent`, `inspect_extensions`,
   `knowledge_query`, `graph_health`.

## Why `/goal` was moved (the cautionary tale)

`/goal` originally used Tier 3 (`setStatus("goal", "active 5s")`). Three problems:

- **No label, no color.** `paused` (needs user action) was visually identical to
  `active`. The footer renders extension statuses as a bare space-joined string
  with no per-key theming.
- **Wrong precedence.** A goal that drives an autonomous agent loop is the MOST
  important persistent state — but it was relegated to the lowest-precedence
  footer fragment.
- **Fragile heartbeat.** A 1s `setInterval` re-called `setStatus` to tick the
  elapsed time, depending on a separate `footer-extension-status-notify` patch.

It was moved to **Tier 1** (`GoalOverlay`) in PR #323, then unified with
`TodoOverlay` into a single composite widget (`CoreTaskStatusWidget`) so the two
persistent features share one display mechanism and one stable stacking slot.

## The composite widget pattern (persistent features)

`TodoOverlay` and `GoalOverlay` are **sections** of ONE widget, owned by
`CoreTaskStatusWidget` (`src/shared/status-widget.ts`). This is the pattern all
future persistent features should follow:

- **One widget key.** The SDK orders above-editor widgets by `Map` insertion
  order with **no index API**. Two separate keys flicker/reorder whenever one is
  cleared and re-registered. One composite key ("pi-core-task") cannot reorder
  relative to itself — stacking is deterministic by construction.
- **Shared lifecycle.** All `setWidget`/`requestRender`/`dispose`/stale-ctx
  handling lives in `CoreTaskStatusWidget`. A new persistent feature is a thin
  state-holder that exposes `render(theme, width): string[]` + `setRefresh(fn)`
  and is added as a section via `addSection({id, render})`.
- **Section order = addSection order.** Goal renders on top, todo below.

### Adding a 3rd persistent indicator (template)

```ts
// 1. state-holder: owns its state, exposes render + setRefresh
class MyIndicator {
  private refresh?: () => void;
  setRefresh(fn: () => void) { this.refresh = fn; }
  update() { this.refresh?.(); }
  render(theme: Theme, width: number): string[] { /* return [] when hidden */ return [...]; }
}

// 2. in src/index.ts factory:
const myIndicator = new MyIndicator();
const statusWidget = /* existing CoreTaskStatusWidget */;
myIndicator.setRefresh(() => statusWidget.update());
statusWidget.addSection({ id: "my-indicator", render: (t, w) => myIndicator.render(t, w) });
// wire session lifecycle (update on session_start, dispose on shutdown)
```

Defer speculative indicators until `tools-metrics` shows one would change
behavior — don't build UI for its own sake.

## ask-user-question: Tier 2 (intentionally different)

`ask_user_question` uses `ctx.ui.custom(...)` (Tier 2 modal dialog), NOT a
widget. This is correct: it blocks for required input, with full keyboard
interaction (tab navigation, multi-select, preview panes). It does NOT adopt the
`CoreTaskStatusWidget` base — overlays are render-only; dialogs are interactive.
The 38-file state-machine (`state/`, `selectors/`, `view/`) reflects that
complexity, which is inherent to a multi-question modal, not accidental.

## The footer `setStatus` path — deprecated for persistent display

As of this work, **no extension uses `ctx.ui.setStatus` for persistent display.**
The `footer-extension-status-notify` patch in `bun-apps/s2-agent/src/patches/`
is retained but documented as redundant (SDK 0.80.3's `setExtensionStatus`
already calls `requestRender`; the sole consumer `/goal` moved to a widget). New
persistent features should use Tier 1, not Tier 3.

## Typecheck gate

`cd bun-apps/s2-agent-ext-power-tool && bunx tsc --noEmit` must show **0 errors
in power-tool's own source** (`src/**`). (The `knowledge_query` + `graph_health`
tools and their workspace dependency were moved out in the consolidation cycle —
power-tool is now self-contained diagnostics, so no external workspace source
contributes residual errors.) The `bun:test` `Cannot find module 'bun:test'`
editor/LSP warning is a known false positive resolved at runtime (see
`.claude/memory`); gate on `bun test` exit code, not the editor squiggle.
