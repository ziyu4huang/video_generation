---
type: grilling
blocked by: []
claimed: pi-agent (grilling)
status: closed
resolved: 2026-08-05
---

## Question

Lock the deck builder's **default visual style** and the **compact-detail** direction, via a `grilling` session (one question at a time). The user was mid-exploration on this (tried `signal-flow` after finding `blueprint` "too simple"; asked for a "compact style to show detail").

Resolve:
- Which `meta.visual_preset` should generated decks default to — `signal-flow`, `blueprint`, or `classic`?
- Light or dark theme by default?
- Should the canonical example (ticket 03) reuse the 5 current IRs as-is, or densify them for more compact detail?

Note: the builder reads style from the manifest, so this pins the **default + the example**, not a hard constraint — a manifest can still override per deck. Resolved by the user's answers; record the chosen default preset, theme, and the densify-or-not verdict.

## Resolution (2026-08-05)

Locked via grilling (3 questions, one at a time):

- **Default `visual_preset`: `signal-flow`** — richest skin (glow, demo/launch feel); what was explored last. Overridable per-deck via the manifest `theme`/style field.
- **Default theme: `light`** — conventional for slides/projectors, prints cleanly. Dark available via manifest override.
- **Example detail: densify, keep structure** — preserve the approved 5-slide narrative + one-message-per-slide; enrich each slide with real item IDs (e.g. `APU.SYS3.IF`), denser annotation cards, and sub-paths for compact detail.

Downstream effect: ticket 03 (manifest + example) now also densifies the 5 example IRs. The map's densify fog item is graduated/cleared.
