---
status: active
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

## Not yet specified

- wayfind's mermaid vendor step (`architecture:vendor` in its `build`) — is the vendored
  `vendor/mermaid.min.js` consumed from `src/` at dev time (making the vendor script
  still needed after the tsc build goes away), or only from `dist/`? Sharpens ticket 03.

## Out of scope

- Re-enabling remote GitHub Actions (deferred prize from next-goal-20260815_084136; rides
  along automatically if ever done — `test:dist` is already wired into regression-gates).
- The Bun-runtime `@repo/*` symlink-rewrite race (separate bug class; seam gate already
  immune, tracked in local-ci memory).
