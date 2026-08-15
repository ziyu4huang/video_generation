---
type: task
status: closed
---

# 03 — Centralize the __piPlanPhases seam constant

## Question

`__piPlanPhases` is read as a raw magic string in `src/chain.ts:58` (`syncChainState`), while every other coordination key (`__piPlanIncomplete`, `__piPlanSummary`, `__piWayfindActive`, `__piWayfindGrill`) is centralized in `src/constants.ts`. Centralize it for consistency; confirm no other raw literals hide in `src/` or `tests/`.

## What to build

- Add `PLAN_PHASES_KEY = "__piPlanPhases"` to `src/constants.ts` (same doc-comment style as the sibling keys).
- Update `src/chain.ts` `syncChainState` to read via the constant instead of the literal.
- Grep `src/` + `tests/` for any other raw `__piPlanPhases` literal; route through the constant (tests asserting the exact string may keep a local literal, but prefer importing the constant).
- Add a contract test mirroring `tests/plan-seed-contract.test.ts`'s `WAYFIND_ACTIVE_KEY` shape so the canonical string is locked.

## Acceptance

- [x] `grep -rn "__piPlanPhases" src/` returns the literal only in `constants.ts` (the canonical definition); every read goes via `PLAN_PHASES_KEY` (`chain.ts` = 0).
- [x] `( cd bun-apps/pi-agent-ext-wayfind && bun test )` + `bun run build` green.
- [x] The constant's value is still exactly `"__piPlanPhases"` (consumer contract unchanged — pinned by the new contract test).

## Resolution

Centralized the `__piPlanPhases` magic string. TDD:

1. **RED** — added a `PLAN_PHASES_KEY` contract test to `tests/plan-seed-contract.test.ts` (mirrors the `WAYFIND_ACTIVE_KEY` shape); it failed with `SyntaxError: Export named 'PLAN_PHASES_KEY' not found`.
2. **GREEN** — added `export const PLAN_PHASES_KEY = "__piPlanPhases"` to `src/constants.ts` (doc comment notes the coordinator is designed-not-built / ADR-0003); the contract test now passes.
3. Updated `src/chain.ts`: imported `PLAN_PHASES_KEY`, changed `syncChainState`'s reader `?.__piPlanPhases` → `?.[PLAN_PHASES_KEY]`, and reworded the 3 doc comments (file header + `syncChainState` docstring) to reference the constant so the literal lives in exactly one place.

Verified: contract test RED→GREEN; full suite **148 pass / 0 fail**; `bun run build` (tsc) **exit 0**; `grep -rn __piPlanPhases src/` returns ONLY `constants.ts:44` (the canonical definition) — `chain.ts` = 0 (all reads via the constant). Value still exactly `"__piPlanPhases"` (consumer contract unchanged, pinned by the new contract test). `tests/` keep their local `PHASES_KEY` literals (acceptable per the ticket).
