# Ticket 01 — verification matrix + source-leg execution, BOTH packages (T1)

Status: open · no blockers · first

## Work
1. Committed `bun-apps/s2-agent-ext-wayfind/tests/skills-integrity.test.ts`:
   golden 16-name set; per-skill frontmatter `name:` == dir name; non-empty
   description.
2. Committed `bun-apps/s2-agent-ext-superpowers/tests/skills-inventory.test.ts`:
   golden 16-name set; frontmatter `name:` == dir for repo-native skills
   (ported stay byte-pinned by skills-fidelity, not duplicated).
3. Source-leg receipt drivers (scratch, plain-bun, no @repo imports):
   run each package's `bun run test`, record named checks.

## Done when
`output/self-arc16-wayfind-src-<date>/receipt.json` and
`output/self-arc16-superpowers-src-<date>/receipt.json` PASS:
`unit-suite-green` (0 fail; record pass counts, no exact-count assert),
`probe-ext-surface` + `gate-zero-registrations` (wayfind),
`skills-integrity` (16), `skills-inventory` (16), `zero-citation-sweep`
(wayfind runnable, driver-invoked). Schema-cost +0 (tests only).
