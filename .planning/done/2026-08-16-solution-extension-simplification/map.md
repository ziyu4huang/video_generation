---
effort: 2026-08-16-solution-extension-simplification
created: 2026-08-16
last: 2026-08-17
status: complete
---

# Wayfinder map: solution-extension-simplification (retro)

> Recorded complete post-hoc: this effort ran through the superpowers no-effort
> paths (.planning/specs/ + .planning/plans/) before map discipline applied.

## Destination
One methodology vocabulary across solution extensions: wayfind = pure decide
engine, superpowers = methodology home, archify = architecture verbs.
Reached — merged as PR #1574 (squash 923032eb).

## Notes
- 14-task plan executed 14/14; wayfind 22 -> 16 skills, 6 merged into superpowers.
- commands.ts 625 -> 137 lines (+ 5 handler modules); effort-tool extraction
  (+ effort-render/effort-enrich); architecture-render relocated to archify.
- docs/superpowers/ namespace retired; .planning/ is the sole artifact home
  (ADR-superpowers-0009, ADR-wayfind-0007).
- Accepted deviation: effort-tool.ts 376 ln > 260 estimate (extraction fidelity
  was the real bar; documented in ADR-wayfind-0007).
- Lesson: per-package green != repo green — run the repo-wide extension-entry
  typecheck (typecheck:ext) whenever files move between packages with
  different tsconfigs; the pre-push hook caught what per-package tests missed.
- Harvest: next goal = 2026-08-17-develop-pipeline (map opened same day).

## Decisions so far
- Full-merge dedup depth: 6 wayfind skills deleted with content merged into
  superpowers counterparts; redirect stubs expire at 0.2.0.
- Relocate-to-archify for architecture-render (archify exposes the verb).
- Deliberate-upstream-divergence standing rule: do-not-re-port armor in README
  tables, UPSTREAM.ref LOCAL-DIVERGENCES, ADR prose.

## Not yet specified
<!-- none — closed -->

## Out of scope
<!-- none -->
