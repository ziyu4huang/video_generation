# RunView Phase 2 — Agent Row (spec pointer)

> Governing spec: `bun-apps/pi-agent-ext-core-runtime/docs/adr/0001-runview-destructive-convergence.md` (accepted Dispatch-B end state) + `.planning/2026-08-14-subagent-workflow-arch-review/architecture-review-2026-08-14.md` (candidates C1/C2/C6).
> Goal: adopt RunView across all render surfaces (C1), complete Dispatch B destructive convergence (C2), sweep pass-through shims (C6). One effort, three waves.

- **Wave 0 (C6)** — sweep pass-through re-export shims in `pi-agent-ext-workflow` (`display.ts`, `workflow.ts`, `workflow-pack.ts` `model` alias).
- **Wave 1 (C2)** — migrate every remaining `registry.get()`/`registry.list()` consumer to `view()`/`views()`, then delete the legacy accessors and the `"completed"` status coercion from `pi-agent-ext-core-runtime`.
- **Wave 2 (C1)** — adopt `agent-row-display.ts` RunView renderers across render surfaces (Tasks 9–14, Part 2).

Plan: `plan.md` in this folder (Tasks 1–8 = Part 1; Tasks 9–14 appended as Part 2).
