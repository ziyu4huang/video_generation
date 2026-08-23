---
effort: 2026-08-20-devops-hardening
created: 2026-08-20
last: 2026-08-23
status: partial
---
# devops-hardening — trustworthy verify_merge verdicts first

## Destination

A devops tool chain whose verdicts can be trusted without re-checking by hand: scope
matching that cannot produce CONTAMINATED false positives, sync that never destroys
unmerged index state, and pr-finish UX that refuses to strand work.

## Context (measured 2026-08-19/20 on this machine, incident-evidenced)

Incidents that motivated each phase:

- PRs #1737/#1739 clean merges flagged **CONTAMINATED** by `verify_merge_landed` — glob-ish
  scope semantics were matching sibling directories.
- MEMORY.md stash conflict (`UU`): sync's preserve flow stashed against a conflicted index.
- Phase 4's SKILL.md tool-name drift was later mooted wholesale by the pi-agent→s2-agent
  rename (#1755, 2026-08-21).

## Tickets

Phase 1 — correctness (shipped FIRST; verdicts gate everything else)
- `plans/phase-1-correctness.md` — tasks 1a/1b ticked mid-execution — **closed** (#1748,
  2026-08-20): `matchesScope()` in `bun-apps/s2-agent-ext-devops/src/scope-match.ts`
  (`x/**` dir prefix, `x/*` direct children only, bare `x` exact-or-prefix, never
  sibling dirs), sync preserve pre-flight (`git ls-files -u` → abort `unmerged_index`),
  loud pop-conflict reporting (`warnings[]` + `preserveConflict`, exit stays 0).

Phase 2 — pr-finish UX guards — **never ran as planned**; detached-HEAD stranding was
later fixed by other work (#1844, 2026-08-23, sync rebase/pull detached-HEAD recovery).

Phase 3 — local_ci cross-run lockfile + obsidian vault byte-baseline — **superseded in
approach**: the local_ci budget was instead reworked end-to-end (#1864, 2026-08-23,
591s→219s); no cross-run lock exists and none is currently wanted.

Phase 4 — SKILL.md alignment + coverage parser fix — **absorbed/mooted** by rename #1755.

## Decisions

- **D1 — entry semantics tightened explicitly** (`x/**` / `x/*` / bare `x` as above);
  documented in spec §Phase 1 because both false-CLEAN and false-CONTAMINATED are worse
  than an explicit table.
- **D2 — never stash against a conflicted index.** Pre-flight then abort; conflicts are
  reported loudly, never auto-resolved (advisory exit 0).
- **Out of scope:** subagent dispatch death-rate (#1681), remote CI re-enable, deeper
  preserve-semantics changes beyond diagnostics.

## Frontier

No live ticket. Remaining phase 2–4 concerns either shipped via other efforts or lost their
premise; reopen only if a new verify/sync incident recurs.

## Fog of war

- The obsidian vault byte-baseline idea (phase 3) was never charted in detail; if vault
  drift ever corrupts a merge again, start from the spec §Phase 3 sketch.

## Cross-effort links

- **Followed-by**: `.planning/2026-08-23-deploy-platform-neutral-core` — cites this effort
  under Builds-on: the single pipeline, six-gate structure, `.cores` cache and Gate 6
  relocation smoke it modifies are theirs. (Reciprocal link added 2026-08-23.)
