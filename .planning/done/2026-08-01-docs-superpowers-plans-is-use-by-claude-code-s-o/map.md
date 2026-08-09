---
effort: 2026-08-01-docs-superpowers-plans-is-use-by-claude-code-s-o
created: 2026-08-01
last: 2026-08-09
status: complete
---

# Wayfinder map: 2026-08-01-docs-superpowers-plans-is-use-by-claude-code-s-o

## Destination

Make the pi-agent and claude-code planning worlds share ONE canonical root (`.planning/`) without editing claude-code's uneditable superpowers plugin. A filesystem symlink bridge lets claude-code's stock skills (which still write flat files to `docs/superpowers/`) transparently land in `.planning/`, while pi-agent's nested `.planning/<effort>/` layout is untouched.

## Notes

- **Two skill sources (the crux):**
  - pi-agent fork `bun-apps/pi-agent-ext-superpowers/skills/` — the 14 upstream-ported SKILL.md are pinned byte-equal to fixtures by ADR-0004 (`tests/skills-fidelity.test.ts`); prose must stay upstream-faithful. An earlier attempt to repoint writing-plans/brainstorming prose to `.planning/<effort>/` (commit `db6f58bb`) was REVERTED — it broke the fidelity guard. Routing is runtime-only (system-prompt 'Pipeline routing' + `PI_PLANNING_EFFORT`).
  - claude-code official plugin `~/.claude-custom/plugins/cache/claude-plugins-official/superpowers/5.1.0/` — auto-managed cache (`.git`, `package.json`, `.in_use`), **uneditable** (plugin update overwrites); its writing-plans/brainstorming hardcode `docs/superpowers/{plans,specs}/`.
  - The symlink bridge below makes BOTH sources' flat `docs/superpowers/` writes land in `.planning/`, so upstream-faithful prose and correct routing coexist.
- Skills consulted: wayfinder (chart-the-map), grilling, domain-modeling.
- Standing preference: this repo is Apple-Silicon-only → symlinks are safe (no Windows concern).

## Decisions so far

- [Destination = filesystem bridge in this repo](#) — keep `.planning/` canonical, make `docs/superpowers/{plans,specs}/` symlinks. Chosen over "customize claude-code skills" (plugin cache uneditable) and "cross-repo unification" (too big). Verified claude-code plugin path with the user after the agent's first (wrong) guess (`~/proj/pi-ext-superpowers/`).
- [Layout = dedicated flat regions `.planning/plans/` + `.planning/specs/`](#) — chosen over "link directly to `.planning/` root" (claude-code `ls` would see all 69 effort dirs + memory/done — noise) and "1:1 link each file into an effort dir" (new files can't auto-resolve). Flat region for claude-code, nested `<effort>/` for pi-agent, both under one root.
- [Migration is forced, not a fork](#) — since the dirs become symlinks they must be emptied first, so all 98 tracked files (55 plans + 43 specs) `git mv` into `.planning/{plans,specs}/`.
- [Process = skip the ticket map](#) — fog cleared after destination + layout pinned (no code/script consumer breaks; only content self-refs, which the symlink keeps resolving). Small enough for direct execution.

## Outcome (direct execution — fog cleared, no tickets needed)

Executed on `video_generation__file2md` after rebasing onto `origin/main` (`c5b1b133`):
- `git mv` 55 plans → `.planning/plans/`, 43 specs → `.planning/specs/`.
- `docs/superpowers/plans` → symlink → `../../.planning/plans`; `specs` likewise.
- Verified: git mode `120000`; claude-code path resolves to same inode; pi-agent `<effort>/plan.md` intact; content self-refs resolve through link; nothing gitignored.

## Out of scope

- **D7 — two skill copies keep diverging** (pi-agent fork vs upstream plugin): the bridge makes this harmless; reconciling the skill text is a separate concern.
- **D8 — `.superpowers/sdd/` + brainstorm scratch**: claude-code (stock) writes SDD there; already gitignored + rerouted under `.planning/<effort>/{sdd,brainstorm}/` when `PI_PLANNING_EFFORT` is set. Same class, not addressed here.
- **`docs/superpowers/audit/`** (1 file): not plans/specs, left in place.
- **Other sibling repos** (`video_generation__director`, `__subagent`, `__archify`, …) and upstream `pi-ext-superpowers`: cross-repo unification is its own effort.
