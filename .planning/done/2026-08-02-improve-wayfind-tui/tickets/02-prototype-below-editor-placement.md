## Question

Does moving the composite status below the chat input actually read better / more claude-code-like? Prototype it cheaply: temporarily flip `placement: "belowEditor"` on the `pi-core-task` key, run the TUI, and eyeball:

1. goal + todo + wayfind rendered **under** the input (does the stack still scan, or does it feel stranded below the prompt?),
2. crowding against the **footer** (cwd / tokens),
3. any clash with **full-screen overlays** (the ask_user_question modal, model / theme selectors, external editor).

Capture a screenshot or a written readout as the asset, and graduate any fog (footer restyle, overlay collision) back into the map.

type: prototype
claimed: wayfind-session (2026-08-02)
blocked by: 01

## Resolution

**Verdict: AFTER (`belowEditor`) is better — keep it.** The composite (goal + loop + todo + wayfind) renders between the chat input and the footer, the claude-code spot. The 1-line flip in `status-widget.ts:99` stays as the implementation (uncommitted; will bundle into the implementation PR).

**Graduated fog (new ticket 07):** the user wants the wayfind block below the input to be **interactive** — cursor-down to focus/hover it, Enter to open a wayfind detail panel. That's more advanced than claude-code's passive status bar and hinges on SDK widget interactivity feasibility (→ research pass + [07](07-interactive-selectable-wayfind-widget.md)).

closed: 2026-08-02
