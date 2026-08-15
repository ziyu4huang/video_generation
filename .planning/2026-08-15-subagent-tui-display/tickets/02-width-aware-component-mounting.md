---
type: task
status: open
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
