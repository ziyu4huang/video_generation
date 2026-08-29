# 03 — family-prefix convention

blocking: 01 (its naming outcome is a precedent input)

## What

Decide ONE convention for family prefixes on skills/commands (candidate:
flat by default, prefix only on collision/ambiguity), write it into the
devops `extension-naming` skill, and resolve the devops family's 9 unprefixed
skills under it.

## Decision (D5, 2026-08-29) — FLAT by default

Re-measured landscape (this branch, 62 skills): hyperframes 7/8 prefixed
(vendored upstream), devops 1/10, superpowers 0/16, wayfind 0/16 — flat was
already the de-facto convention. All-prefixed would rename ~50 skills,
including two vendored upstream families whose contract is "keep upstream
names", for zero behavior gain.

Prefix justified ONLY on: (1) collision with an existing skill name —
skills have NEITHER upstream suffixing NOR a dispatch patch, so a collision
is a silent shadow (unlike commands, cf. D3); (2) palette ambiguity
(`devops-workflow` keeps its prefix — bare `workflow` is a generic word);
(3) vendored upstream families (hyperframes-* untouched, both directions).

Devops family resolution: the 9 unprefixed skills are CONFORMANT under
flat-default — explicitly exempted, zero renames.

## Done when

- [x] Convention + rationale in extension-naming SKILL.md ("Family-prefix
  convention (D5)" section, citing the measured landscape + D3/D4
  precedents)
- [x] Devops family conformant (explicitly exempt under flat-default — the
  convention section names all nine and why no rename)
- [x] Naming test/lint (cheap): cross-package skill-name uniqueness test
  added to `bun-apps/tests/skill-frontmatter.test.ts` (CI-wired via
  `test:skill-frontmatter`) — turns the silent-shadow hazard into a red
