# Plan — merge tool-gating-contract into core-interface

Single task, type-only consolidation. BASE = f87ae33d.

## Task 1 — Fold gating augmentation into core-interface; remove the standalone package
**commitScope:**
- `bun-apps/pi-agent-ext-core-interface/` (add `src/tool-gating.d.ts`; `package.json` exports; `src/index.ts` only if needed to wire the types entry)
- `bun-apps/pi-agent-ext-tool-gate/extensions/tool-gate.ts` (triple-slash)
- `bun-apps/pi-agent-ext-power-tool/src/index.ts` (triple-slash)
- `bun-apps/pi-agent-ext-core-task/extensions/core-task.ts` (remove dead triple-slash)
- `bun-apps/pi-tool-gating-contract/` (DELETE)
- `bun-apps/bun.lock` (workspace regen via `bun install` from `bun-apps/`)
- `.planning/<effort>/sdd/<plan>/report.md` (implementer report ONLY)

**Steps**
1. Create `bun-apps/pi-agent-ext-core-interface/src/tool-gating.d.ts` = verbatim content of `bun-apps/pi-tool-gating-contract/tool-gating.d.ts`.
2. Configure core-interface `package.json` `exports` so `/// <reference types="@repo/pi-agent-ext-core-interface" />` resolves + applies the augmentation, while `import {...} from "@repo/pi-agent-ext-core-interface"` still resolves the runtime symbols. VALIDATE empirically (a consumer's typecheck must accept `gating`). If pure triple-slash cannot resolve from a source-as-package, use the closest ambient equivalent that preserves zero-import-at-use-site semantics and document why in the report.
3. `pi-agent-ext-tool-gate/extensions/tool-gate.ts`: change the `/// <reference types="@repo/pi-tool-gating-contract" />` line -> `@repo/pi-agent-ext-core-interface`.
4. `pi-agent-ext-power-tool/src/index.ts`: same triple-slash change.
5. `pi-agent-ext-core-task/extensions/core-task.ts`: REWIRE the triple-slash `@repo/pi-tool-gating-contract` -> `@repo/pi-agent-ext-core-interface` (core-task is a LIVE consumer: `gating:{core:true}` on goal/todo/ask-user tools + `core-gating.test.ts`; do NOT remove).
6. Delete `bun-apps/pi-tool-gating-contract/` entirely.
7. From `bun-apps/`, run `bun install` to regen `bun-apps/bun.lock` (drops the workspace package).
8. Verify: `bun run --cwd bun-apps/<pkg> typecheck && bun run --cwd bun-apps/<pkg> test` for pi-agent-ext-core-interface, pi-agent-ext-tool-gate, pi-agent-ext-power-tool, pi-agent-ext-core-task. All must be GREEN.

**Acceptance**
- `/// <reference types="@repo/pi-agent-ext-core-interface" />` applies the gating augmentation (proven by tool-gate/power-tool typecheck accepting `gating`).
- core-interface, tool-gate, power-tool, core-task typecheck + test GREEN.
- `bun-apps/pi-tool-gating-contract/` deleted; `bun.lock` no longer references `@repo/pi-tool-gating-contract`.
- Diff is types + package.json + deletions + triple-slash line changes — NO runtime code changed.
