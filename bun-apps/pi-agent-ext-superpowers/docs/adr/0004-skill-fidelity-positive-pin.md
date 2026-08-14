**ID:** `ADR-superpowers-0004` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# Skill fidelity is guarded by a positive content pin, not a denylist

The 14 upstream-ported superpowers `SKILL.md` must stay byte-identical to upstream
EXCEPT sanctioned pi-port glue (`using-superpowers/references/*.md`, #639). After
#664/#676/#678 silently injected repo conventions into the skills (passing the
structure-only `tests/skills.test.ts`), we guard the invariant with a **positive
content pin**: `tests/skills-fidelity.test.ts` asserts each `SKILL.md` equals its
committed baseline fixture under `tests/__fixtures__/upstream-skills/`. A pin was
chosen over a denylist because the repo's own dep-guard (ADR-monorepo-0001) showed
denylists/regex miss things; a pin catches all drift — convention injection,
accidental edit, and upstream drift alike.

Legitimate upstream re-sync goes through an explicit, never-automatic
`scripts/rebaseline-upstream-skills.ts` that copies the skills into the fixtures
AND writes a `UPSTREAM.ref` provenance record (upstream commit SHA / version +
date), which a test asserts is present and non-empty — so every re-port is
traceable and a sneaky convention injection has nowhere to hide.

Related: ADR-wayfind-0003 (plan-coordinator designed-not-built) — the #678 skill edits it
records are precisely the incident this guard prevents from recurring. See
`.planning/2026-07-19-a/tickets/07-skill-fidelity-guard.md` for the grilled
decision.
