# Task 4 Report — unify triplicated 'Settled vocabulary' emitter

**Task label:** zk-spawn
**Branch:** `feat/wayfind-architecture-deepening`
**Base HEAD:** `bff08671`
**Commit:** `9bb61fd4a8dc89b5fcd1ada1c664c4f809469998`

## Summary

Collapsed the three byte-identical "Settled vocabulary" emitter blocks (one in
`buildPlanSeed` in `src/grill.ts`; two in `src/chain.ts` — `flattenTicketsToPlan`
and `seedFromDecisions`) into a single pure helper `appendSettledVocabulary`
exported from `src/grill.ts`.

## Changes

### `src/grill.ts`
- Added `appendSettledVocabulary(lines, glossary, heading = "## Settled vocabulary")`
  right after the `GlossaryTerm` interface. No-op on empty glossary; otherwise
  pushes `heading`, blank, one `- **term**: def` per term, trailing blank.
- Rewired `buildPlanSeed`'s `if (glossary.length > 0) { ... }` block to the single
  call `appendSettledVocabulary(lines, glossary, "## Settled vocabulary (from CONTEXT.md)")`.
  Byte-identical output.

### `src/chain.ts`
- Added `appendSettledVocabulary` to the grill import (biome reformatted the
  import to multi-line + alphabetical).
- Rewired `flattenTicketsToPlan` and `seedFromDecisions`'s identical blocks to
  `appendSettledVocabulary(lines, glossary)` (default heading). Byte-identical.

### `tests/grill.test.ts`
- Added `appendSettledVocabulary` + `type GlossaryTerm` to the grill import.
- Appended a new `describe("appendSettledVocabulary", ...)` with 3 tests:
  no-op on empty glossary; default-heading emission; custom-heading variant.

## Verification (gate)

```
( cd bun-apps/pi-agent-ext-wayfind && bun run check && bunx tsc --noEmit && bun test )
```

- `bun run check` (biome): clean (after auto-fix of import formatting on the 3
  touched files; no behavior change).
- `bunx tsc --noEmit`: clean.
- `bun test`: **311 pass, 1 skip, 0 fail** (630 expect calls, 20 files).

Characterization nets held (output byte-identical):
- `chain.test.ts` — `flattenTicketsToPlan` / `seedFromDecisions` still emit
  `## Settled vocabulary` + `**Foo**: a foo`.
- `plan-seed-contract.test.ts` — all `buildPlanSeed` output-token assertions pass.
- 3 new `appendSettledVocabulary` tests pass.

## Staging

Staged exactly the three target paths (no `-A`/`.`):
- `bun-apps/pi-agent-ext-wayfind/src/grill.ts`
- `bun-apps/pi-agent-ext-wayfind/src/chain.ts`
- `bun-apps/pi-agent-ext-wayfind/tests/grill.test.ts`

Left unstaged (correctly): `.agents/memory/MEMORY.md`, `.planning/...` (incl.
this report — local scratch, never committed).

## Concerns

None.
