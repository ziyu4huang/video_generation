---
status: complete
---
# Src-entry migration — kill the stale-dist class at the root

## Destination

The four dist-entry packages (`pi-agent-ext-workflow`, `-superpowers`, `-wayfind`, `-webui`)
resolve their package root to `./src/` in this monorepo, so no `@repo/*` bare-specifier
consumer can ever load a stale gitignored `dist/` again. The whole stale-dist bug class
(NameTooLong boot failures, blank-symptom silent drift) becomes structurally impossible:
either the boot heal patch + `test:dist` gate retire outright, or they remain as no-op guards
by explicit decision. Landed per-package with canonical tests + cross-package typecheck green.

## Notes

- Domain: Bun monorepo packaging (`bun-apps/`), pi-agent extension registration, tsc.
- Skills every session should consult: superpowers:test-driven-development,
  superpowers:verification-before-completion. Devops tool chain for all git/PR phases.
- Standing rule: `.planning/` artifacts ride every PR of this effort.
- Verification bar per ticket: package's canonical `bun run test` (not a hand-assembled
  subset), cross-package typecheck green, `./pi-agent.sh -p` boots clean.
- Evidence verified at `origin/main` `48eb08a7` (2026-08-15, via Explore report).

## Decisions so far

- [Publish face: drop it](tickets/01-publish-face-decision.md) — (b) `private: true`; npm
  registry proof: all four 404 (never published, `@repo` scope unownable). Tickets 02–05
  delete publish fields with the root flip; ticket 05 may delete the heal machinery outright.
- [webui pilot](tickets/02-webui-pilot.md) — root → src/index.ts, build dropped; 373 tests
  green from src with dist/ deleted; recipe proven (PR #1391, squash `922664b6`).
- [superpowers + wayfind](tickets/03-superpowers-wayfind.md) — same flip; mermaid vendor
  survives as wayfind `pretest` (offline copy from node_modules); stale compiled `.test.js`
  in old dists were duplicates, real suites green from src.
- [workflow + consumers](tickets/04-workflow-consumers.md) — the blast-radius package
  flipped; postinstall heal deleted; all bare-spec consumers (pi-agent CLI, movie-director)
  green with dist/ deleted; mock-bypass deep import in workflow-command.test.ts correctly
  KEPT (it dodges mock.module, not dist). PR #1403, squash `aeff501b`. Consumer tail swept:
  boot-smoke prebuild, ci-matrix expectations, flux2's deep `dist/workflow.js` import (the
  last dist consumer anywhere).
- [Retire the machinery](tickets/05-retire-machinery.md) — boot heal patch + staleness
  walkers + env knob deleted; `distEntryMain` survives as the tripwire gate's predicate;
  `test:dist` keeps guarding zero-dist-roots. Effort complete.

## Not yet specified

(none — the mermaid-vendor fog resolved in ticket 03: src reads it at render time;
vendor survives as wayfind's `pretest`, an offline copy from node_modules)

## Out of scope

- Re-enabling remote GitHub Actions (deferred prize from next-goal-20260815_084136; rides
  along automatically if ever done — `test:dist` is already wired into regression-gates).
- The Bun-runtime `@repo/*` symlink-rewrite race (separate bug class; seam gate already
  immune, tracked in local-ci memory).
