# wayfind + planning-with-files: shared status widget + command consolidation

Date: 2026-07-17
Status: approved (design), not yet implemented

## Problem

`pi-agent-ext-wayfind` and `pi-agent-ext-planning-with-files` each write directly
to the TUI footer via `ctx.ui.setStatus(PKG_NAME, text)`. This is a per-key map
rendered by the SDK, so both packages' status lines appear simultaneously at
the bottom of the screen. Even though the two packages already coordinate via
a `globalThis` seam (wayfind publishes `__piWayfindActive`; pwf yields its
injection/auto-continue while a grill is active), yielding only changes the
*text* of pwf's line — it never disappears. Result: two status lines
competing for attention in the footer, redundant and confusing.

Separately, the two packages together expose 19 top-level slash commands
(wayfind: 10, planning-with-files: 9), several of which overlap in naming
intent (`wayfind`'s `/plan-seed` reads as part of pwf's `/plan-*` namespace
even though it belongs to wayfind).

`pi-agent-ext-goal-todo` already solved an equivalent problem for `/goal` +
`todo`: a single composite above-editor widget (`PowerToolStatusWidget`,
`src/shared/status-widget.ts`) with one SDK widget key and ordered
`addSection()` calls, avoiding the Map-insertion-order flicker bug that
plagues multiple independent `setWidget` keys.

## Decision

Promote goal-todo's `PowerToolStatusWidget` to a process-singleton shared
component. wayfind and planning-with-files take a hard dependency on
`@repo/pi-agent-ext-goal-todo` and register their own status as sections on
the same widget instead of independent `ctx.ui.setStatus` calls. In parallel,
consolidate each package's slash commands into a small number of
subcommand-style dispatchers.

goal-todo is already the earliest-loaded core package in
`bun-apps/pi-agent/run-dir/manifest.json`; requiring it for wayfind/pwf status
display (no fallback to standalone `setStatus` if goal-todo isn't loaded) is
an acceptable trade-off given that positioning.

## Part 1 — Shared status widget

### API change (goal-todo)

`pi-agent-ext-goal-todo/src/shared/status-widget.ts`:

```ts
let instance: PowerToolStatusWidget | undefined;
export function getSharedStatusWidget(): PowerToolStatusWidget {
  return (instance ??= new PowerToolStatusWidget());
}
```

`StatusSection` gains an optional `order` field (number, default = registration
index) so `renderAll()` sorts sections deterministically regardless of which
package happened to load first:

```ts
export interface StatusSection {
  id: string;
  order?: number;
  render(theme: Theme, width: number): string[];
}
```

Section order (top to bottom): goal (0) → todo (1) → wayfind (2) →
planning-with-files (3).

### Dependency direction

`pi-agent-ext-wayfind/package.json` and
`pi-agent-ext-planning-with-files/package.json` add:

```json
"dependencies": {
  "@repo/pi-agent-ext-goal-todo": "workspace:*"
}
```

Both import `getSharedStatusWidget` from
`@repo/pi-agent-ext-goal-todo/src/shared/status-widget`.

### Consumer changes

wayfind and pwf each get a small overlay module (mirroring
`GoalOverlay`/`TodoOverlay`) holding their own display state and exposing
`render(theme, width): string[]`. Every one of the 19 existing
`ctx.ui.setStatus(PKG_NAME, text)` call sites is replaced with: update the
overlay's internal state, then call `getSharedStatusWidget().update()`.
`addSection` is called once per package at `session_start` (idempotent thanks
to the `id` de-dupe already in `PowerToolStatusWidget.addSection`).

The existing yield message ("... — /goal or /grill driving, injection
yielded") is preserved as visible text inside pwf's section — it's useful
information, not noise. What changes is that it now renders as one line
inside a single composite widget instead of a second independent footer
entry.

## Part 2 — Command consolidation (19 → 3 top-level commands)

Old command names are removed outright, no aliases. This is an internal dev
tool, not a public API; README/CONTEXT/memory references get updated in the
same change.

### `/grill [me|docs|done|domain] [args...]`

Replaces `/grill-me`, `/grill-me-with-docs`, `/grill-done`,
`/domain-modeling` (4 → 1).

```
/grill me [topic]         = /grill-me [topic]
/grill docs [topic]       = /grill-me-with-docs [topic]   (flagship)
/grill done [--seed-plan] = /grill-done [--seed-plan]
/grill domain             = /domain-modeling
/grill                    = usage text
```

### `/wayfind [<destination>|status|spec|tickets|seed|sync] [args...]`

Replaces `/wayfinder`, `/wayfinder-status`, `/to-spec`, `/to-tickets`,
`/plan-seed`, `/chain-sync` (6 → 1). Renaming wayfind's `/plan-seed` to
`/wayfind seed` also resolves the naming collision with pwf's `/plan-*`
namespace.

```
/wayfind <destination>    = /wayfinder <destination>   (chart a new map)
/wayfind                  = /wayfinder                 (work next frontier ticket)
/wayfind status [effort]  = /wayfinder-status [effort]
/wayfind spec [effort]    = /to-spec [effort]
/wayfind tickets [effort] = /to-tickets [effort]
/wayfind seed [effort]    = /plan-seed [effort]
/wayfind sync [effort]    = /chain-sync [effort]
```

Dispatch rule: the first whitespace-delimited token is checked against the
fixed keyword set (`status`, `spec`, `tickets`, `seed`, `sync`); anything else
(including empty) falls through to the existing `<destination>` / no-arg
frontier-ticket logic. Safe because destinations are natural-language phrases
that essentially never collide with these five keywords as their first word.

### `/plan [status|execute|done|attest|goal|loop|list|lint|switch] [args...]`

Replaces all 9 pwf commands (9 → 1).

```
/plan status                   = /plan-status
/plan execute [reset]          = /plan-execute [reset]
/plan done [--delete]          = /plan-done [--delete]
/plan attest [--show|--clear]  = /plan-attest [--show|--clear]
/plan goal <text>              = /plan-goal <text>
/plan loop [interval]          = /plan-loop [interval]
/plan list                     = /plan-list
/plan lint [--all]             = /plan-lint [--all]
/plan switch <id>              = /plan-switch <id>
```

### Implementation shape

Each package keeps its existing per-command handler logic as private
functions (zero behavior change) and adds one top-level
`pi.registerCommand("grill" | "wayfind" | "plan", { handler })` that parses
the first token of `args`, routes to the matching private handler with the
remaining args, and prints a usage message for unrecognized/missing
subcommands. The 19 old `pi.registerCommand(...)` call sites are deleted.

## File-level changes

- `pi-agent-ext-goal-todo/src/shared/status-widget.ts` — singleton getter +
  `order` field; update `src/shared/__tests__/status-widget.test.ts`
- `pi-agent-ext-wayfind/package.json` — add goal-todo dependency
- `pi-agent-ext-wayfind/src/commands.ts` — collapse to `/grill` + `/wayfind`
  dispatchers; existing handler bodies become private functions
- `pi-agent-ext-wayfind/src/overlay.ts` (new) — status section state + render
- `pi-agent-ext-planning-with-files/package.json` — add goal-todo dependency
- `pi-agent-ext-planning-with-files/src/commands.ts` — collapse to `/plan`
  dispatcher
- `pi-agent-ext-planning-with-files/src/runtime.ts` — replace the 10
  `ctx.ui.setStatus(PKG_NAME, ...)` call sites with overlay state updates +
  `widget.update()`
- Both packages' `README.md` / `CONTEXT.md` — update command tables
- `docs/adr/` — one ADR recording this decision (command renaming is a
  breaking, hard-to-reverse change for anyone with muscle memory around the
  old names)

## Testing

- Existing `bun test` in all three packages stays green. Any test that
  invokes a command by its old registered name (e.g. asserts on
  `pi.registerCommand("grill-me", ...)`) is updated to go through the new
  dispatcher.
- New dispatcher-level unit tests per package: valid subcommand routes
  correctly with remaining args forwarded, unknown/missing subcommand prints
  usage and does not throw.
- New integration test for the shared widget: goal + todo + wayfind + pwf all
  call `addSection` on the singleton; assert the rendered widget contains all
  four sections in `order`, with no widget-key collision.
- Manual verification: run the real `pi` TUI (`bun run dev` equivalent for
  the CLI), exercise `/grill docs` → `/wayfind` → `/plan status`, confirm the
  footer shows exactly one composite widget with no duplicate/competing
  status lines.

## Out of scope

- No changes to wayfind's or pwf's core decision/execution logic — this is
  purely a UI (status widget) and command-surface (dispatcher) refactor.
- No backward-compatible command aliases.
- No changes to the existing `globalThis` coordination seam
  (`__piWayfindActive`, `__piPlanPhases`) — it continues to gate yield
  behavior; only how that yield state is *displayed* changes.
