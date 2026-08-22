**ID:** `ADR-superpowers-0004` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# Skill fidelity is guarded by a positive content pin, not a denylist

The 14 upstream-ported superpowers `SKILL.md` must stay byte-identical to upstream
EXCEPT sanctioned pi-port glue (`using-superpowers/references/*.md`, #639). After
#664/#676/#678 silently injected repo conventions into the skills (passing the
structure-only `tests/skills.test.ts`), we guard the invariant with a **positive
content pin**: `tests/skills-fidelity.test.ts` asserts each `SKILL.md` equals its
committed baseline fixture under `tests/__fixtures__/upstream-skills/`. A pin was
chosen over a denylist because the repo's own dep-guard (bun-apps/tests/dep-guard.test.ts) showed
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

## Amendment (2026-08-19) — the record must be tied to the bytes it describes

"A test asserts `UPSTREAM.ref` is present and non-empty" was the whole guard on
the provenance record, and present-and-non-empty is satisfied by a record that
describes a state which no longer exists. PR #1682 re-baselined five fixtures
(-708 lines of in-place local compression) without adding a line to
`UPSTREAM.ref`, and the suite stayed green — the byte-pin compares skills to
fixtures, and both had moved together.

Two changes:

- `UPSTREAM.ref` carries `fixtures-digest: sha256:<hex>` over the pinned fixture
  set, asserted by the same test. The record can no longer go stale in silence.
- `scripts/rebaseline-upstream-skills.ts` requires `--note "<why>"`, writes the
  digest, and appends the note to a dated log. Recording provenance stops being a
  step a human remembers and becomes one the tool refuses to skip.

Which skills are pinned now comes from `scripts/skill-provenance.ts` — one
declaration per skill directory carrying `upstream | repo-owned` — replacing
three hand-synced name lists (`skills.test.ts`, `skills-fidelity.test.ts`, and
the script). An upstream port is pinned *by declaration*, so it cannot ship
unguarded by being forgotten in a second list.

Scope of the pin, stated plainly: it guards the MERGED body — upstream v6.2.0
plus the sanctioned local sections plus the round-2 compression — not bare
upstream. What a re-port must preserve is listed in `UPSTREAM.ref`.
