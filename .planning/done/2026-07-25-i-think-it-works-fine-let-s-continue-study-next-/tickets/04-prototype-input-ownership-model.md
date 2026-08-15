---
type: prototype
blocked by: 02, 03
status: closed
resolved: 2026-07-25
---

# 04 — Prototype: input-ownership model (type-to-filter + arrow-nav coexistence)

## Question

claude-code filters the list AS you keep typing (`/way…` narrows) AND lets ↓/↑ navigate at the same time. A pi-tui modal overlay (`MenuComponent`) takes over input entirely — you can't keep typing into the editor while it's up. Can we get the two to coexist in pi-tui, or must the menu be modal-only (which changes the feel)? Build a cheap throwaway to find out, and capture which model the component must expose.

## What resolving it looks like

A throwaway extension/script (linked as an asset) demonstrating the chosen input model; the decision recorded here drives the component API in **05**. Needs human reaction to the feel → HITL.

## Resolution (2026-07-25)

**Model: editor-driven coexistence** (confirmed via human reaction to the prototype).

- **Asset**: [`assets/proto-picker.ts`](../assets/proto-picker.ts) — standalone Bun script (raw ANSI, no pi-tui wiring on purpose — a feel throwaway; 02 already proved the real mechanism). Run: `bun run .../assets/proto-picker.ts`.
- **Feel validated**: type freely; `/` opens the picker; continued typing filters the list live; ↑/↓ or Ctrl-P/N navigate **while typing continues** (no conflict); Enter selects; Esc closes (buffer retained); Ctrl-C exits.
- **Key constraint surfaced**: nav keys MUST be non-printing (arrows / Ctrl-N/P). If nav used a printing key (e.g. `j`/`k`), it would collide with filter typing — so the editor-driven model pays for coexistence by reserving nav to non-printing keys. (claude-code's modal `Select` can afford `J/K` precisely because it's modal / owns input.)

### Component API this drives (→ ticket 05)

The generic menu component must expose:

- `triggerChar` (e.g. `"/"`) — the char that opens the picker (intercepted before `super.handleInput`).
- `query: string` — the live filter text (everything after the trigger char in the editor buffer).
- `items: SelectItem[]` — the candidate list; `filtered = items.filter(matches(query))`.
- `selectionIndex: number` — current highlight, **clamped** across filter changes (persist, don't reset, on each keystroke).
- `navKeys: { up: Key[]; down: Key[] }` — non-printing only (arrows + Ctrl-P/N); configurable but must exclude printing chars.
- `onAccept(item)` / `onCancel()` — Enter / Esc.

**Implementation path** = a `CustomEditor` subclass: `handleInput(data)` intercepts the trigger char (open overlay), routes nav/accept/cancel to the overlay while open, and passes every other key to `super.handleInput(data)` so the editor buffer (and live filter) keeps working. The overlay renders via `ctx.ui.custom(..., { overlay: true })` using the built-in `SelectList` (per 02 — "don't rebuild it").

**Frontier advances to [05](05-decide-generic-menu-component-spec.md)** — pin the formal component spec (props, theming hook, width-responsiveness) from this API shape.
