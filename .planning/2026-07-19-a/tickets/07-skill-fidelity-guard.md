---
type: grilling
status: resolved
grilled: 2026-07-20
---

# 07 — Skill fidelity guard (prevent silent invariant violations)

## Question

Add a test that guards the refined invariant ("superpowers skills byte-identical to upstream EXCEPT necessary pi-port glue") so future convention injections **fail CI** instead of passing silently — as #664 / #676 / #678 did (`tests/skills.test.ts` checks structure only)? Decide WHAT to assert (snapshot the 6 core `SKILL.md` against the port? a denylist of repo-convention strings — `.planning/`, `goal_complete`, `ADR-`?) and HOW to handle legitimate upstream re-sync (so a real re-port doesn't false-fail).

Graduated from [01](01-revert-skill-edits-restore-fidelity.md)'s fidelity-test sub-decision.

### Context

- `tests/skills.test.ts` today asserts structure (frontmatter, skill-dir set, no stray files), NOT content — that's the hole the violations slipped through.
- After [01](01-revert-skill-edits-restore-fidelity.md): the 6 core `SKILL.md` are port-verbatim; `using-superpowers/references/pi-tools.md` is the one allowed pi-port-glue file (#639). A guard would pin exactly that shape.

## Resolution (grilled 2026-07-20)

**D1 — Mechanism: Positive content pin (not denylist).** A new test
`tests/skills-fidelity.test.ts` asserts each of the **14** upstream-ported
`pi-agent-ext-superpowers/skills/<name>/SKILL.md` is byte-equal to its baseline
fixture `tests/__fixtures__/upstream-skills/<name>.md`. Scope = all 14 (the risk
set — any skill can be injected — not the 6 that #664/#676/#678 historically
touched). `references/*.md` (#639 pi-port glue) is explicitly OUT of scope.

Rejected: denylist of convention strings — the repo's own dep-guard (ADR-0001)
showed regex/denylists miss things (subpath imports), caught only by a forced
RED-step. A positive pin catches ALL drift: convention injection, accidental
edit, upstream drift.

**D2 — Re-sync: explicit `scripts/rebaseline-upstream-skills.ts` + provenance.**
Re-baseline never runs automatically. The script copies the 14 SKILL.md →
fixtures AND writes `tests/__fixtures__/upstream-skills/UPSTREAM.ref` (upstream
commit SHA / version + date). A test asserts `UPSTREAM.ref` is present + non-empty
→ every re-port leaves a traceable source; a reviewer sees the ref change in the
PR diff, so a sneaky convention injection has nowhere to hide.

Rejected: convention-string dry-run scan (YAGNI — the pin already catches
everything at runtime; PR diff + provenance make re-baseline auditable).

**Status:** resolved → implemented. Guard in `tests/skills-fidelity.test.ts` +
fixtures + `scripts/rebaseline-upstream-skills.ts`. Invariant recorded as
ADR-0004.
