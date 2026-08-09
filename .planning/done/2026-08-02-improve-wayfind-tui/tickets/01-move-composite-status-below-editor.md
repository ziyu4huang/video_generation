## Question

To get the wayfind status below the chat input, do we (a) move the whole composite `pi-core-task` key (goal + loop + todo + wayfind) to `placement: "belowEditor"`, (b) split wayfind into its own below-editor key, (c) make placement per-section configurable, or (d) reconsider and stay above?

type: grilling
blocked by: _(none)_

## Resolution

**(a) — move the whole composite below.** Flip `placement: "aboveEditor"` → `"belowEditor"` on the single `pi-core-task` key in `bun-apps/pi-agent-ext-core-task/src/shared/status-widget.ts`. Keeps the one-key invariant that kills the Map-insertion-order flicker bug. Accepted cost: goal + loop + todo also move below the input (not just wayfind) — to be visually confirmed in [02](02-prototype-below-editor-placement.md).

closed: 2026-08-02 (resolved during charting)
