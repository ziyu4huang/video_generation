---
type: task
blocking:
---

## Question

(a) Wayfind test home: move `src/__tests__/{overlay,settings}.test.ts` → `tests/`, delete `src/__tests__/` (split-brain convention). (b) Superpowers pin friction: `rebaseline-upstream-skills.ts` gains `--divergence <skill>:<marker>` flags appending a machine-readable divergences table to UPSTREAM.ref; `skills-fidelity.test.ts` asserts each declared marker still occurs in the corresponding SKILL.md — turns the eroded "merged body" premise into a checked contract (an upstream re-sync that drops a local section goes red even after a legitimate rebaseline). Byte-pin itself stays intact.

## Resolution

Landed 2026-08-21 (phases W6+S6, branch feat/wayfind-s6-w6-housekeeping).

W6: `src/__tests__/{overlay,settings}.test.ts` → `tests/` (imports rebased); `src/__tests__/` deleted — one test home.

S6: `rebaseline-upstream-skills.ts` gains repeatable `--divergence <skill>:<marker>` writing machine-readable `divergence: <skill> | <marker>` rows into UPSTREAM.ref (validated against PORTED_SKILLS, deduped, idempotent); `skills-fidelity.test.ts` asserts every declared marker survives in the live SKILL.md — the byte-pin can no longer be satisfied by a naive re-sync that silently drops sanctioned local sections. Seeded rows: systematic-debugging (S1 pointer fix) + dispatching-parallel-agents (v2 rewrite).

Gates: superpowers 141/0 + typecheck; wayfind 469/0 + check + typecheck.

closed: (landed)
