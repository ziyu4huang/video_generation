# Spec: subagent + workflow tsconfig strictness (`noUncheckedIndexedAccess`) + knowledge-card `LinkWeighting` export

**Status:** Approved design — pending implementation.
**Effort folder:** `.planning/2026-08-09-subagent-workflow-tsconfig-strictness/`.
**Date:** 2026-08-09.
**Origin:** Deferred follow-up named in `.planning/2026-08-09-subagent-tui-toolcall-pairing/spec.md` ("the pre-existing TS18048 narrowing cluster (separate follow-up)").

## Problem

`pi-agent-ext-subagent`'s own `bun run typecheck` passes, but three consumer packages FAIL their typecheck because they compile subagent's `.ts` source under `noUncheckedIndexedAccess`, which subagent's own `tsconfig.json` does not enable:

- `pi-agent-ext-movie-director` — FAIL (compiles subagent src)
- `pi-agent-ext-obsidian` — FAIL (compiles subagent src)
- `pi-agent-cli` — FAIL (compiles subagent + workflow src)

`pi-agent` additionally FAILs because `pi-agent-ext-knowledge-card/src/loop.ts` imports `LinkWeighting` from `./retrieve.ts`, which imports-but-does-not-re-export it (the type is exported from `entities.ts`).

## Root cause

- `bun-apps/pi-agent-ext-subagent/tsconfig.json` and `bun-apps/pi-agent-ext-workflow/tsconfig.json`: `strict: true` but no `noUncheckedIndexedAccess`.
- `pi-agent-ext-knowledge-card`: `entities.ts:282` exports `type LinkWeighting`; `retrieve.ts:48` imports it internally; `loop.ts:43` imports it `from "./retrieve.ts"` -> unresolvable.

## Goal

Make `bun run typecheck` GREEN for: pi-agent-ext-subagent, pi-agent-ext-workflow, pi-agent-ext-knowledge-card, pi-agent-ext-movie-director, pi-agent-ext-obsidian, pi-agent-cli, pi-agent. Zero runtime behavior change.

## Fix (type-only)

1. Enable `"noUncheckedIndexedAccess": true` in `pi-agent-ext-subagent/tsconfig.json` and `pi-agent-ext-workflow/tsconfig.json`.
2. Narrow every site the compiler then flags (type-only; preserve semantics).
3. Make `LinkWeighting` resolvable for `loop.ts`.

## Non-goals

- Touching any other package's tsconfig (only subagent + workflow).
- The standalone-result suppression (Task 4 of the pairing plan) — separate.
- Runtime gating / dispatch / render behavior.
