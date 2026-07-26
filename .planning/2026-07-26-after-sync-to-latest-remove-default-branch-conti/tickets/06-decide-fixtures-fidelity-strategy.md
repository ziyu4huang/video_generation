---
type: grilling
status: closed
resolved: 2026-07-26
blocked by:
  - 04-decide-skill-compression-plan
---

# 06 — Decide the fixtures / fidelity strategy under active divergence

## Question

Now that skill content is being actively edited (ticket 04), what should happen
to `tests/__fixtures__/upstream-skills/*.md` — the ~2.4k-line frozen upstream
snapshots that `skills-fidelity.test.ts` pins local skills against?

The tension (ticket 03): pinning *diverging* local skills to *upstream* snapshots
is semantically contradictory, and every skill edit forces a fixture rebaseline
— so the maintenance burden scales with the compression work.

The decisions to grill (after 04 sets the compression posture):
1. **Keep fidelity pinning** — rebaseline fixtures after each compression pass,
   accepting the upkeep (preserves ADR 0004's "positive pin" guarantee).
2. **Slim it** — pin only a canonical subset (e.g. the bootstrap +
   `using-superpowers`), drop per-skill snapshots for skills we're diverging.
3. **Rework** — replace upstream-snapshot pinning with a local "golden" snapshot
   of our *diverged* skills (pin-to-self), so edits are intentional and
   reviewed rather than auto-rebaselined.
4. **Retire** — drop fidelity testing entirely if divergence makes it moot
   (risk: silent skill drift).

Blocked by 04 because the fixture burden depends on how aggressively and how
often skills are edited.

## Resolution (2026-07-26) — moot under the conservative posture

**No change to the fidelity machinery.** The ticket-04 pilot edited only
`anthropic-best-practices.md` — which is **not** pinned (ADR-0004 pins
`SKILL.md` only). No `SKILL.md` was touched, so every ported skill is still
byte-equal to its fixture and the guard stays green as-is. The positive-pin
(ADR-0004) is retained unchanged.

The "drop writing-skills from the fidelity-fixture set" clause from ticket 04
is **dormant**: it only activates if a *future* Phase-2 (aggressive `SKILL.md`
rewrite) actually edits a pinned file. That escalation is deferred (see the
map's harvested prizes), not part of this conservative audit's route. If/when
it happens, reopen this ticket to execute the fixture drop.
