---
type: task
status: closed
resolution: "Fixed + merged via PR #1036 (mergeCommit 2de920e3) — removed dead migrations/unified-planning-dir.patch + scripts/apply-patches.sh + its call in update-superpowers.sh; ADR-0005 updated to note removal; divergence stays at the boundary layer (src/superpowers.ts piBoundaryOverrides); skills unchanged, skills-fidelity green"
---
# Dead unified-planning-dir.patch would mutate skills + break fidelity on sync

## Question

`scripts/apply-patches.sh` (run unconditionally by `update-superpowers.sh`) applies `migrations/unified-planning-dir.patch`, which rewrites 6 path strings across 5 skills. But the patch is currently NOT applied — skills hold the upstream strings (`skills/brainstorming/SKILL.md` still says `docs/superpowers/specs/...`). So running the documented sync would instantly fail `skills-fidelity.test.ts` (whose fixtures are the unpatched bytes); or, followed by `rebaseline-upstream-skills.ts`, it would re-inject exactly the repo conventions ADR-0004/0005 were created to prevent. ADR-0005 states the patch was "never applied" and divergence belongs at the boundary layer (already done in the bootstrap).

Resolve: delete `migrations/unified-planning-dir.patch` + `scripts/apply-patches.sh` + drop the call from `update-superpowers.sh`.
