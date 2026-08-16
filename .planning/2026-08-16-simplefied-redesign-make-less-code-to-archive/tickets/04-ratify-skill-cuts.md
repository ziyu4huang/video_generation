---
type: grilling
claimed: ratify-session 2026-08-16
blocking: 2
status: closed
---

## Question

Ratify the skill cuts: wayfind — which of the 16 ported extras actually drop (delete dirs + unregister; core 6 assumed keep unless census contradicts); superpowers — exclude which flagged skills via PI_SUPERPOWERS_SKILL_EXCLUDE defaults (unregister-only). Feature-count check: cuts keep each package ≥80% per ticket-01 census. Output: two ratified exclude/delete lists.

## Resolution

Ratified 2026-08-16 (ratify-session). Five decisions:

1. **wayfind: 0/16 ported skills cut.** All 16 KEEP per ticket-02 census (≥3 planning refs + live session exposure each); feature anchor stays 39/39; core 6 keep.
2. **superpowers verification-before-completion: DELETE FILES (−241).** Skill dir + fidelity fixture + `PORTED_SKILLS` entry (`skills-fidelity.test.ts:40`) + `skills.test.ts:41` expected-set entry + `rebalance-upstream-skills.ts:41` entry + CONTEXT.md count 14→13. KEEP the `DEFAULT_SKILL_EXCLUDE` entry (`superpowers.ts:46`) as-is. LEAVE dangling prose refs (`systematic-debugging` L189, `writing-skills` L401) untouched — body edits are ADR-out-of-scope; runtime exclude already made them dangling today. Features 14→13 = 93%.
3. **superpowers brainstorming: CUT companions** `visual-companion.md` (291) + `server.cjs` (723) = **−1,014**. SKILL.md byte-pin untouched (fidelity fixture compares SKILL.md only); accept the dangling conditional companion ref; landing-time check: sweep `spec-document-reviewer-prompt.md` + `scripts/` ONLY if the deleted companion was their sole referencer.
4. **Budget FIRM as ticket-03 ratified:** superpowers Δ ≤ −1,200 ✓ (−1,255), trio Δ ≤ −400.
5. **Framing shift vs ticket 04's original wording:** exclude-default changes are NOT needed (already exist); ratified action = file deletion.
