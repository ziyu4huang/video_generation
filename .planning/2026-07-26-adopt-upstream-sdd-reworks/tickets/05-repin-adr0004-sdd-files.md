## Question

Execute the ADR-0004 re-pin: copy upstream's current SDD files into the fork's pinned set, add the new `re-review-prompt.md`, and update ADR-0004's pin record (hash/manifest) + `skills-fidelity.test.ts` so the pin tracks upstream-current.

**type:** task (AFK)
**claimed:** _(open)_
**blocked by:** —  *(UNBLOCKED 2026-07-26: origin/main's 13 commits touch zero SDD files; the rebase is not needed for this re-pin. The subagent-ext conflict is a separate workstream — see ticket 01.)*

## Acceptance

- `skills/subagent-driven-development/SKILL.md` ← upstream current (503 lines).
- `implementer-prompt.md` (+3), `task-reviewer-prompt.md` (−3) ← upstream current.
- `re-review-prompt.md` **ADDED** (new file).
- ADR-0004 pin record + `skills-fidelity.test.ts` updated to assert upstream-current (re-record the fidelity baseline).
- **Do NOT** edit the pinned files' paths — the re-pinned `SKILL.md` references upstream's `.superpowers/sdd/<plan-slug>/`; the pi-port glue (ticket 06) overrides those at runtime to the effort×plan layout. The pin is verbatim; the override is runtime.
- `skills-fidelity.test.ts` + full superpowers suite green after re-pin.
