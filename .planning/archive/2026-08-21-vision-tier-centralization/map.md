---
effort: 2026-08-21-vision-tier-centralization
created: 2026-08-21
last: 2026-08-23
status: complete
---
# vision-tier-centralization — one resolution leaf for extension model selection

## Destination

Extensions never hardcode provider/model ids: every LLM/vision call resolves through
`~/.pi/workflows/model-tiers.json` via `resolveModelRole()` in `s2-agent-core-runtime`.

## Context (measured 2026-08-21 on this machine)

- Four bypass packages rewired: movie-director gemma brain, flux2 VLM, file2md
  `vision_ask`, knowledge-card chat/distill.
- Text tier vocabulary unchanged (`small/medium/big`); vision tiers are capability keys,
  not renames.
- Shipped in a single commit: #1768, 2026-08-21. Ground truth on main:
  dashed-capability fallback (`vision-large` → `vision-medium` → … → `vision`) lives in
  `bun-apps/s2-agent-core-runtime/src/model-role-config.ts:129-132`.

## Tickets

Single-plan effort (`plans/2026-08-21-vision-tier-centralization.md`, no ticket split):
- Task 1 fallback semantics + 4 package rewires — **closed** (#1768)

## Decisions

- **D1 — exact-key-wins dashed-capability fallback.** `lastIndexOf("-")` walk; an exact
  key always beats a generalized one.
- **D2 — terminal hardcoded fallback removed where throw is allowed**; retained (documented
  last-resort) only in knowledge-card `chatJson`, whose contract forbids throwing.
- **Out of scope:** web-access cloud search-API model ids, movie-director TTS defaults,
  knowledge-card embedding endpoint (that endpoint has its own resolution leaf — see
  `.planning/2026-08-22-context-lifecycle`).

## Frontier

cleared — #1768 merged 2026-08-21, same day the effort opened.

Housekeeping note (2026-08-23): this folder predates the effort-folder convention
(plans-only, no map until retrofitted; plan checkboxes unticked despite the merge).

## Fog of war

- No telemetry on how often the fallback chain actually walks past `vision-large`. If a
  provider gap ever produces silent downgrades, add a warn-level log at the first hop.

## Cross-effort links

- **Shares-decision-with**: `.planning/2026-08-22-context-lifecycle` — both keep exactly one
  resolution leaf per concern (model roles here, embedding config there); neither allows
  extensions to hardcode endpoints or ids.
