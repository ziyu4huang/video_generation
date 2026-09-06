# 01 — Viewport-aware streaming-expanded trace tail (G1)

## Done when
- `viewportTraceTail(rows)` in core-runtime/agent-trace-display.ts: clamp(rows−14, 8, 28);
  unknown/non-positive rows → STREAMING_EXPANDED_TAIL (16) so headless/print and
  unit tests stay deterministic.
- BOTH capped surfaces adopt it: `renderSubagentResult` isPartial+expanded
  (subagent-tool-render.ts) and the dock expanded block
  (ext-task subagents-section.ts). `opts.rows`/`process.stdout.rows` read at the
  render seam only (purity preserved: helper takes rows as a parameter).
- Height-stability rule intact: the cap varies with RESIZE, never per tick (#1104).
- On a 36-row terminal the expanded live view shows ~22 trace lines (was 16).

## Why
CC's ctrl+o on a running agent fills the viewport with live activity; a fixed
16-line tail wastes the window on tall terminals while overflowing small ones
(the original #1104 constraint was "fits the viewport", which is a FUNCTION of
rows, not a constant).
