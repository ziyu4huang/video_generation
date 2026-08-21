---
type: task
blocking: 4
---

## Question

Land the superpowers stage per ticket 04: DELETE verification-before-completion (skill dir + fidelity fixture + skills-fidelity.test.ts PORTED_SKILLS entry + skills.test.ts expected-set entry + rebalance-upstream-skills.ts entry + CONTEXT.md count 14→13); KEEP DEFAULT_SKILL_EXCLUDE entry (superpowers.ts:46); LEAVE systematic-debugging L189 + writing-skills L401 prose refs dangling (ADR: no upstream-body edits). CUT brainstorming companions visual-companion.md + server.cjs (−1,014; SKILL.md byte-pin untouched); sweep spec-document-reviewer-prompt.md + scripts/ only if landing-check shows the deleted companion was sole referencer. No PI_SUPERPOWERS_SKILL_EXCLUDE default change (already excludes v-b-c). Gates: fidelity tests green after edits; features 13/14 = 93%; superpowers Δ ≤ −1,200 (−1,255 expected). Devops chain: branch → PR → local CI → gh ship.

## Resolution

Landed 2026-08-21 (effort 2026-08-21-harness-streamline, phase S1). Per ratified ticket 04 + one AMENDMENT (user decision D2):

- DELETED `skills/verification-before-completion/` (dir + fixture + skill-provenance entry). `DEFAULT_SKILL_EXCLUDE` entry KEPT (inert by design — an exclude naming a deleted skill is a no-op); two skill-exclude tests updated to be existence-aware.
- CUT brainstorming companions: `visual-companion.md` + the whole `scripts/` dir (server.cjs, helper.js, frame-template.html, start/stop-server.sh) = −1,739 (the ratified −1,014 pair + the ticket's own conditional sweep: with visual-companion.md gone the scripts' sole instructor was deleted).
- AMENDMENT (D2): `spec-document-reviewer-prompt.md` KEPT (not swept) — it gets wired as the spec/plan reviewer second pass in phase S7 of the 2026-08-21 effort.
- Sanctioned divergence: `systematic-debugging` Phase-3 checklist pointer `superpowers:verification-before-completion` (would dangle + fail bun-apps/tests/skill-reference.test.ts) replaced with an evidence-first line; recorded as LOCAL-DIVERGENCES addendum 2026-08-21 in UPSTREAM.ref; fixtures re-baselined with note.
- CONTEXT.md: 14 → 13 upstream skills.

Gates: superpowers check + 131→133 tests / 0 fail + typecheck; skill-reference/adr-citation/routing-contract/seam-contract 32/0; loop status 30 skills, all rows PASS. Δsuperpowers content: −1,739 companion lines + skill dir.

closed: (landed)
