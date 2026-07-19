---
type: grilling
status: open
---

# 07 — Skill fidelity guard (prevent silent invariant violations)

## Question

Add a test that guards the refined invariant ("superpowers skills byte-identical to upstream EXCEPT necessary pi-port glue") so future convention injections **fail CI** instead of passing silently — as #664 / #676 / #678 did (`tests/skills.test.ts` checks structure only)? Decide WHAT to assert (snapshot the 6 core `SKILL.md` against the port? a denylist of repo-convention strings — `.planning/`, `goal_complete`, `ADR-`?) and HOW to handle legitimate upstream re-sync (so a real re-port doesn't false-fail).

Graduated from [01](01-revert-skill-edits-restore-fidelity.md)'s fidelity-test sub-decision.

### Context

- `tests/skills.test.ts` today asserts structure (frontmatter, skill-dir set, no stray files), NOT content — that's the hole the violations slipped through.
- After [01](01-revert-skill-edits-restore-fidelity.md): the 6 core `SKILL.md` are port-verbatim; `using-superpowers/references/pi-tools.md` is the one allowed pi-port-glue file (#639). A guard would pin exactly that shape.
