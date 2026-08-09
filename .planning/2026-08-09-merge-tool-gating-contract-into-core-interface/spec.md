# Spec — merge tool-gating-contract into core-interface

## Problem Statement
The repo carries a standalone pure-type package `@repo/pi-tool-gating-contract` whose sole file (`tool-gating.d.ts`) globally augments pi's `ToolDefinition` with a `gating` field, declares the `Gating` interface, and types the `getAllToolDefinitions()` runtime patch. It exists to dedupe this augmentation (previously byte-identical across ~14 packages). It is consumed by only 2 real consumers (tool-gate, power-tool) + 1 dead reference (core-task), all via `/// <reference types="..."/>`. A whole package for one ambient `.d.ts` is overhead: an extra package.json/tsconfig, a workspace entry, and a name that diverges from the `pi-agent-ext-core-interface` contracts home. We want one contracts home: fold this augmentation into `pi-agent-ext-core-interface` and delete the standalone package.

## Solution
Move the gating augmentation into `pi-agent-ext-core-interface`, exposed so that `/// <reference types="@repo/pi-agent-ext-core-interface" />` applies it (ambient mechanism preserved). Switch the 2 real consumers' triple-slash directives from `@repo/pi-tool-gating-contract` to `@repo/pi-agent-ext-core-interface`. Remove core-task's dead triple-slash. Delete the `pi-tool-gating-contract` package and its workspace entry. Zero runtime change.

## User Stories
1. As a maintainer, I want the tool-gating type contract to live in the single contracts home (core-interface), so there is one package for cross-extension type contracts instead of two.
2. As a maintainer, I want `pi-tool-gating-contract` removed, so there is no standalone package for a single ambient declaration file.
3. As an extension author (tool-gate / power-tool), I want my `/// <reference>` to point at core-interface, so the `gating` augmentation keeps working with no behavior change.
4. As a maintainer, I want core-task's dead gating triple-slash removed, so there is no misleading reference to a contract it does not use.

## Implementation Decisions
- Fold `tool-gating.d.ts` content into core-interface as `src/tool-gating.d.ts` (verbatim augmentation: `declare module "@earendil-works/pi-coding-agent"` adding `ToolDefinition.gating?`, plus global `Gating` interface, plus `ExtensionAPI.getAllToolDefinitions?()` declaration).
- Configure core-interface `package.json` `exports` so the ambient `/// <reference types="@repo/pi-agent-ext-core-interface" />` resolves a types entry carrying the augmentation, while `import` of runtime symbols (`SEAM_KEYS`, `publishSeam`/`readSeam`, `KnowledgePipeline`) still resolves to `src/index.ts`. The exact condition structure is validated empirically by the implementer (acceptance = the triple-slash applies the augmentation + all packages typecheck green).
- Consumers: `pi-agent-ext-tool-gate` + `pi-agent-ext-power-tool` change their triple-slash `@repo/pi-tool-gating-contract` -> `@repo/pi-agent-ext-core-interface`; `pi-agent-ext-core-task` removes its dead triple-slash (no gating usage).
- Delete `bun-apps/pi-tool-gating-contract/` (package.json, tool-gating.d.ts, tsconfig.json) and drop it from the bun workspace (`bun install` from `bun-apps/` to regen `bun-apps/bun.lock`).
- No runtime code changes anywhere. Pure type-system consolidation.

## Testing Decisions
- The augmentation's correctness is proven by typecheck of consumers: tool-gate / power-tool must still accept `gating: {...}` on `defineTool` and the `Gating` type annotation; `getAllToolDefinitions()` must still typecheck in tool-gate.
- Run `bun run --cwd bun-apps/<pkg> typecheck` and `test` for: pi-agent-ext-core-interface, pi-agent-ext-tool-gate, pi-agent-ext-power-tool, pi-agent-ext-core-task. All must be GREEN.
- No new unit tests (type augmentation has no runtime behavior to unit-test); existing tool-gate / power-tool tests are the regression net.

## Out of Scope
- Folding `pi-agent-ext-subagent` (or any other extension) into core-interface — subagent is heavyweight runtime, not a contract; rejected by the grill.
- Renaming `pi-agent-ext-core-interface` for naming consistency (e.g. to `pi-core-contracts`) — noted, deferred.
- Changing the augmentation mechanism to explicit import-side-effect — ambient triple-slash is preserved.
- Any change to gating RUNTIME behavior (tool-gate's gate-matching logic) — untouched.

## Further Notes
- Redundancy check: ZERO overlap between the gating augmentation and core-interface's existing seam/knowledge contracts — pure consolidation, no dedup conflict.
- The `getAllToolDefinitions()` method is added at runtime by the repo's `ext-api-get-all-tool-definitions` monkey-patch; the augmentation only TYPES it. Behavior unchanged.
- Naming inconsistency (`pi-tool-*-contract` vs `pi-agent-ext-core-interface`) remains for core-interface; not addressed here.
