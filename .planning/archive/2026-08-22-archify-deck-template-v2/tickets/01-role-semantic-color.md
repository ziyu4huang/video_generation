# Ticket 01 — role semantic color field

**Effort:** 2026-08-22-archify-deck-template-v2 · **Status:** closed

Add optional `role` (enum `spec`/`verify`) to components and connections in common.schema.json; map to theme colors in the svg-theme and pptx color paths (role overrides componentType color; variant composes). SKILL.md gains the role-vs-variant rule. Tests: role→color mapping in both paths; absent-role renders bit-for-bit.
