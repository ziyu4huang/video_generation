---
type: task
status: closed
origin: 2026-08-08-subagent-expanded-display-flicker/tickets/01-expanded-display-flicker-on-fast-stream.md
---

## Question

BUG: enabling Ctrl-O to expand a subagent tool box, when the content is large and updates very fast (streaming), causes the ENTIRE TUI interface to flicker (not just the tool box). Find the root cause + fix it so the expanded view is stable under fast streaming.

**Symptom:** the whole interface flickers while a fast-streaming subagent is expanded via Ctrl-O.

**To resolve, investigate + decide (root-cause-first):**
1. Expand mechanism: Ctrl-O → global `toolOutputExpanded` → `setExpanded()` on every ToolExecutionComponent → `renderResult(expanded:true)` re-invoked. For the subagent tool, expanded `renderResult` produces the FULL themed output (large). Trace the path (file:line) in `bun-apps/pi-agent/src/` (TUI) + `bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`.
2. Stream-update re-render: on each `onUpdate`, does the tool box re-render → re-invoke `renderResult(expanded)` with the FULL expanded string? How often does `onUpdate` fire (per token? chunk? tool call?)?
3. Why the WHOLE interface flickers (not just the box): message-list reflow from height changes? no throttle/batch? Ink/React full-tree re-render on each update? terminal write thrash (clear + redraw large regions)? Pinpoint the actual cause.
4. Throttling/batching/virtualization: is there ANY throttle, debounce, frame-limit, or virtualization on the render path? (grep throttle/debounce/requestAnimationFrame/useMemo/memo/windowing in the TUI.) If none, likely the root cause.
5. Fix candidates: (a) throttle/debounce the `renderResult` re-invocation on stream updates (cap re-renders to ~10-30fps); (b) during streaming, render a TRUNCATED expanded view (tail/head), full output only when settled; (c) memoize/stabilize the render so only changed regions re-render; (d) reserve the box height to avoid message-list reflow.

**Goal:** the Ctrl-O expanded view stays stable (no whole-TUI flicker) even with large + fast-streaming content.

Related: the `2026-08-08-subagent-display-glanceable-by-default` effort covers the COLLAPSED view; this ticket covers the EXPANDED view's stability.

## Findings

**Root cause (condensed):** the pi TUI is a custom immediate-mode renderer (`@earendil-works/pi-tui`, NOT Ink/React). Each frame it regenerates the entire line buffer, diffs vs the previous frame, and differentially redraws the changed region — UNLESS the first changed line sits ABOVE the bottom-anchored viewport top, in which case it bails to `fullRender(true)` (`tui.js:1169: if (firstChanged < prevViewportTop) { fullRender(true); return; }`) = full-screen clear (`\x1b[2J\x1b[H\x1b[3J`) + rewrite of ALL lines.

- The subagent STREAMING-expanded view = 2-line header + up to 100 trace lines (~102 rows) — TALLER than the terminal viewport (24–50 rows). Its first line sits above `prevViewportTop`.
- Each ~4Hz stream update changes content at the box top → `firstChanged < prevViewportTop` → `fullRender(true)` EVERY frame → whole-screen clear+rewrite at 4Hz = the visible flicker.
- Collapsed (2 rows) + non-streaming don't trip this → no flicker. Two throttles already exist (250ms emit + 16ms frame) but can't hide a per-frame full clear.

**The bail is correct TUI behavior** (bottom-anchored scrollback). Fix = keep the streaming-expanded box SMALL + height-stable so `firstChanged` stays INSIDE the viewport → differential path runs → no `fullRender`.

## Resolution

**Fix (effort ticket 01):** in `renderSubagentResult` (`bun-apps/pi-agent-ext-subagent/src/subagent-tool.ts`), cap the `isPartial` (streaming) EXPANDED branch to a viewport-safe tail instead of rendering all ~100 trace lines. Added tunable `const STREAMING_EXPANDED_TAIL = 16;`:

- If `lines.length <= 2 + STREAMING_EXPANDED_TAIL`: show all lines (small enough already — no ellipsis).
- Else: `[...header(2), "…", ...last STREAMING_EXPANDED_TAIL trace lines]` ≈ 19 rows → fits most viewports, height-stable.
- Collapsed (`lines.slice(0, 2)`) — UNCHANGED.
- Settled (`isPartial:false`) expanded report — UNCHANGED (renders in full once at stream-done; no repeated clears, no flicker).

**Effect:** the streaming-expanded box stays small + height-stable → `firstChanged` inside the viewport → differential render → no `fullRender` → no flicker. Settled expanded report is unaffected.

**Tests (`tests/subagent-tool.test.ts`, +4):** isPartial+expanded+MANY → exactly 2 header + 1 ellipsis + last CAP trace, oldest dropped; isPartial+expanded+FEW → all lines, no ellipsis; isPartial+collapsed → 2 lines (unchanged); non-partial+expanded → full report (no cap). **Gate green: `bun run typecheck && bun test` → 541 → 545 pass, 0 fail.**

**Verification note:** the unit tests verify the CAP LOGIC (height + ellipsis + tail selection) but NOT the visual flicker — confirming the flicker is gone requires a rebuild + eyeball of a fast-streaming subagent expanded via Ctrl-O.
