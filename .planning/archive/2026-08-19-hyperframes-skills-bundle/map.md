---
effort: 2026-08-19-hyperframes-skills-bundle
created: 2026-08-19
last: 2026-08-23
status: complete
---
# hyperframes-skills-bundle — vendor the HyperFrames skill family

## Destination

The 8-skill HyperFrames family lives inside the repo as `bun-apps/pi-agent-ext-hyperframes`
(renamed `s2-agent-ext-hyperframes` by the 2026-08-21 rename), and the ambient user-level
symlinks under `~/.pi/` are gone.

## Context (measured 2026-08-19 on this machine)

- The family was installed 2026-08-08 via `npx skills` from heygen-com/hyperframes and
  symlinked from `~/.claude-custom/skills/` — outside any package, invisible to gates.
- 8 skills total: 7 `hyperframes-*` + `media-use`; they cross-reference each other, so they
  must share one `skills/` root.
- Full verbatim vendor (~5.5 MB mp3/woff2 binaries into git) with a manual re-vendor
  procedure documented in the package README.
- `find-skills` discarded outright, not vendored.

## Tickets

Single-shot PR (no ticket decomposition):
- vendor 8 skill trees + no-op extension entry + registration — **closed** (#1713)
- purge the 8 `~/.pi/` symlinks + find-skills remnants; `~/.claude-custom/` otherwise untouched — **closed**

## Decisions

- **D1 — standalone package**, not folded into movie-director: skills cross-reference each
  other (one shared `skills/` root), and HyperFrames is a different domain than movie direction.
- **D2 — full verbatim vendor** including binaries; re-vendor is a manual documented procedure.
- **D3 — deliberate no-op extension entry**: the package exists to carry skills, not tools;
  it became the reference pattern for skill-carrier packages alongside power-tool.

## Frontier

cleared — merged 2026-08-19 as #1713 (`feat(hyperframes): vendor the HyperFrames skill
family as pi-agent-ext-hyperframes — purge ~/.pi skills`). All 8 skill trees verified on disk.

Note: this folder predates the effort-folder convention — `spec.md` status read "implementing"
until corrected here; acceptance checkboxes were never ticked though the work landed same day.

## Fog of war

- Upstream re-syncs are manual (D2); a drifted vendored copy is only detectable by diffing
  against the upstream repo. No automated freshness gate — charted, deliberately unbuilt.

## Cross-effort links

- **Renamed-by**: `.planning/2026-08-22-ultracode-rename` — package became
  `s2-agent-ext-hyperframes` in the pi-agent→s2-agent rename (#1755, 2026-08-21).
