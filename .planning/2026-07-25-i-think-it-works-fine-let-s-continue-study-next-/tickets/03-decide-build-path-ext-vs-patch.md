---
type: grilling
blocked by: 02
status: closed
resolved: 2026-07-25
---

# 03 — Decide: build path (extension vs patch vs upstream)

## Question

Where does the generic menu component live? (a) **Extension-only** via `ctx.ui.custom` overlay / `setWidget` — no upstream change; (b) **Patch the vendored package** — `pi-agent/src/patches/` precedent exists; (c) **Contribute upstream** to `@earendil-works/pi-coding-agent`. Resolve with a `grilling` pass once 02 says whether the extension surface suffices or hits a wall.

## Recommendation

Extension-only unless 02 proves a hard wall; patch only the narrow gap if one exists. Keeps the feature local and upgrade-safe.

## Resolution (2026-07-25)

**Extension-only.** 02 proved the extension surface is fully sufficient — overlay (`ctx.ui.custom({overlay:true})`), the built-in `SelectList` ("don't rebuild"), `CustomEditor` (Pattern 7, for type-to-filter + arrow-nav coexistence), and `setWidget({placement:"belowEditor"})` all work, with the slash-command data source already present (`CombinedAutocompleteProvider`). No hard wall → no upstream patch, no fork. Honors the standing extension-path preference and keeps the feature local + upgrade-safe.

**Frontier advances to [04](04-prototype-input-ownership-model.md)** — prototype the input-ownership model (coexistence of type-to-filter + arrow-nav) using these mechanisms.
