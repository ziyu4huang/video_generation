# Ticket 02 — v-model archetype geometry

**Effort:** 2026-08-22-archify-deck-template-v2 · **Status:** closed

Add `meta.archetype: "v-model"` + payload (ordered leftArm/rightArm id lists, crossbars pairs). IR→IR pre-pass fills absent pos/size (slanted arms, bottom apex, interpolated crossbars); never overrides explicit pos. Validate errors: unknown archetype, unknown node id. Tests: geometry generation, explicit-pos preservation, error diagnostics, baseline unchanged.
