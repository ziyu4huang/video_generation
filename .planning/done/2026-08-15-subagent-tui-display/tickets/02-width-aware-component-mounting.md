---
type: task
status: closed
blocking: 01
---
# 02 — Width-aware mounting: compose-in-render (both tools)

## Question

How does real terminal width reach live subagent lines and re-flow on resize?

## What to build

- `renderCall`/`renderResult` for BOTH the single subagent tool and the batch subagents tool stop baking fixed-capped plain strings into a text component at hook time; they return components that compose the lines inside `render(width)` at the real terminal width.
- The live header, running-phrase, and elapsed lines re-flow at the actual width on every frame; resize re-flow comes for free from the component `render(width)` contract (no manual resize subscription, no stdout-column polling).
- The settled-collapsed branch switches its hardcoded cap to the width-derived cap when composing inside `render(width)`.
- The batch header's first-task preview becomes width-aware — width reaches it only via this component mounting.
- Streaming shapes are untouched: collapsed stays a fixed 2-line slice, expanded keeps its tail cap.

## Acceptance

- [ ] Component `.render(width)` at 40 / 80 / 120 / 200 → every line's visibleWidth ≤ width.
- [ ] The same component rendered at two different widths re-flows.
- [ ] Streaming 2-line collapsed + tail structure pins intact.
- [ ] `▸`-join pins intact.

## Resolution

- New `ComposerComponent` (src/composer-component.ts) implementing the pi-tui `Component` contract; `setComposer` incrementally reuses `lastComponent` so the TUI frame loop re-renders the same instance instead of churning components.
- `renderCall`/`renderResult` of BOTH tools (`subagent-tool`, `subagents-tool`) now mount a `ComposerComponent` and defer all line composition to `render(width)` — live lines, settled-collapsed, and the batch first-task preview all render at real terminal width.
- Settled-collapsed truncation is now width-derived via `capWidth(60, width)` instead of a fixed 60.
- Marker-position ladder tests at widths 40/80/120/200 plus re-flow (same component at two widths) and component-reuse (same instance across `setComposer` calls).
- Import-bug note: `ComposerComponent` is a LOCAL class (`../src/composer-component.js`), never a pi-tui export — tests must not import it from `@earendil-works/pi-tui`.
- Gates: `bun run test` (check + typecheck + bun test) → 608 pass / 0 fail / 35 files.
