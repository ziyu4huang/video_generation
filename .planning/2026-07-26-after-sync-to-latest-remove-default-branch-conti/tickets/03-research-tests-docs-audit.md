---
type: research
status: closed
---

# 03 — Tests & docs audit: redundancy, staleness, duplication

## Question

What redundancy, staleness, or structural duplication exists across `tests/`
and `docs/`?

## Findings (charted 2026-07-26)

**`tests/` — 3993 lines, but ~60% is fixture duplication.**

The bulk is `tests/__fixtures__/upstream-skills/*.md` — frozen snapshots of every
upstream skill (writing-skills 679, subagent-driven-development 503,
test-driven-development 320, systematic-debugging 283, … total ~2.4k lines).
These feed `skills-fidelity.test.ts` (ADR 0004 "skill-fidelity-positive-pin"):
the local skills are diffed against the frozen upstream snapshots.

➡️ **This is the structural duplication worth a decision.** The fixtures are a
*frozen copy* of the skill content. Every skill edit (ticket 04) forces a
fixture rebaseline (`scripts/rebaseline-upstream-skills.ts`), so the maintenance
burden scales with how aggressively we diverge. Under active divergence, pinning
local skills to *upstream* snapshots is semantically contradictory anyway.

Actual test logic is lean (~1.6k lines): `bootstrap.test.ts` (215),
`skill-exclude.test.ts` (179), `skills.test.ts` (130), `sdd-workspace.test.ts`
(97), `binary-mode.test.ts` (80), `skills-fidelity.test.ts` (68) — these are
healthy, not redundant.

**`docs/` — already lean**: 3 ADRs / 223 lines (0004 skill-fidelity-pin, 0005
parallel-coexistence-boundary, 0006 subagent-cooperation). Not a simplification
target.

➡️ The one decision worth making is the **fixtures/fidelity strategy** under
active divergence (ticket 06), not test-logic or doc cleanup.
