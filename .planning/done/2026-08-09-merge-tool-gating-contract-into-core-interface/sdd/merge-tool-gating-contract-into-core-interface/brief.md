# Task 1 — Fold gating augmentation into core-interface; remove the standalone package

See `../../spec.md` and `../../plan.md`. Pure type-only consolidation; ZERO runtime change.

## commitScope
- bun-apps/pi-agent-ext-core-interface/ (src/tool-gating.d.ts; package.json; src/index.ts if needed)
- bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts (triple-slash -> core-interface)
- bun-apps/pi-agent-ext-power-tool/src/index.ts (triple-slash -> core-interface)
- bun-apps/pi-agent-ext-core-task/extensions/core-task.ts (remove dead triple-slash)
- bun-apps/pi-tool-gating-contract/ (DELETE)
- bun-apps/bun.lock (regen via `bun install` from bun-apps/)
- .planning/2026-08-09-merge-tool-gating-contract-into-core-interface/sdd/merge-tool-gating-contract-into-core-interface/report.md (your report ONLY — do NOT commit other sdd scratch)

## Steps
1. Create `bun-apps/pi-agent-ext-core-interface/src/tool-gating.d.ts` = verbatim `bun-apps/pi-tool-gating-contract/tool-gating.d.ts`.
2. Make `/// <reference types="@repo/pi-agent-ext-core-interface" />` apply the augmentation while `import` of runtime symbols (SEAM_KEYS, publishSeam/readSeam, KnowledgePipeline) still resolves. VALIDATE empirically. If pure triple-slash cannot resolve from a source-as-package, use the closest ambient equivalent preserving zero-import-at-use-site semantics and document why.
3. tool-gate `extensions/tool-gate.ts`: triple-slash `@repo/pi-tool-gating-contract` -> `@repo/pi-agent-ext-core-interface`.
4. power-tool `src/index.ts`: same triple-slash change.
5. core-task `extensions/core-task.ts`: REMOVE the dead triple-slash (grep-verify no gating usage first).
6. Delete `bun-apps/pi-tool-gating-contract/` entirely.
7. From `bun-apps/`: `bun install` to regen `bun-apps/bun.lock`.
8. Verify GREEN: `bun run --cwd bun-apps/<pkg> typecheck && bun run --cwd bun-apps/<pkg> test` for core-interface, tool-gate, power-tool, core-task.

## Acceptance
- triple-slash on core-interface applies the augmentation (typecheck proves it).
- core-interface + tool-gate + power-tool + core-task typecheck + test GREEN.
- `pi-tool-gating-contract/` deleted; `bun.lock` no longer references it.
- NO runtime code changed.
- Return the SDD status block (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED) stating the EXACT packaging approach used (exports condition structure).
