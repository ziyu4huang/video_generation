**ID:** `ADR-superpowers-0007` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# ADR-0007: Unconditional artifact home — never write to upstream paths

Date: 2026-08-02
Status: accepted
See: [ADR-0005](./0005-parallel-coexistence-boundary.md) (supersedes its "when an
effort is active" clause; 0005's wayfind↔superpowers disjoint-subpath layout
stands), [map](../../../../.planning/2026-08-02-hardening-to-resolve-problem-we-find-about-wrong/map.md)

## Context

ADR-0005 framed the no-upstream-path rule as conditional: "Never write to the
upstream paths **when an effort is active**." An ad-hoc brainstorm with no active
`/wayfind` effort therefore fell back to the pinned skill's literal
`docs/superpowers/specs/` default (ADR-0004 pins skills byte-identical to
upstream, so that prose was never corrected) — leaking an artifact outside the
`.planning/<effort>/` convention.

The bootstrap injection is unconditional (`session_start`/`session_compact`),
so the gap is the text's conditional language, not delivery.

Note (2026-08-02 amendment): `docs/superpowers/{specs,plans}` are git-tracked
symlinks to `.planning/{specs,plans}`, so the flat layout was already the
de-facto home for standalone specs; this ADR makes the boundary text say so
explicitly rather than pushing them to per-effort dirs.

## Decision

The no-upstream-path rule is **unconditional**: superpowers never writes any
artifact (spec, plan, SDD workspace, brainstorm mockup) to `docs/superpowers/`
or `.superpowers/`, with or without an active effort.

- `PI_PLANNING_EFFORT` set → resolve under `.planning/<effort>/` (unchanged).
- `PI_PLANNING_EFFORT` unset (ad-hoc) → specs land at
  `.planning/specs/<YYYY-MM-DD>-<topic>-design.md` and plans at
  `.planning/plans/<YYYY-MM-DD>-<topic>.md` — the flat layout
  `docs/superpowers/{specs,plans}` symlink to. The no-effort SDD workspace
  lands at flat `.planning/sdd/<plan-basename>/` (gitignored, local-only
  scratch); the effort SDD workspace stays committed under
  `.planning/<effort>/sdd/`. (Per-effort `.planning/<effort>/` is for
  multi-ticket wayfind efforts, set via `PI_PLANNING_EFFORT`.)

Guarded by (a) a unit test asserting the boundary text's rule is unconditional,
and (b) a repo lint failing on any file beyond the baseline under the upstream
paths.

## Consequences

- Ad-hoc artifacts persist as flat files under `.planning/specs/` + `.planning/plans/` (the layout `docs/superpowers/{specs,plans}` symlink to) instead of silently dropping under `docs/superpowers/` — a real, accepted trade-off (discoverability over nonchalance).
- A future `/wayfind seed` may adopt a spec-only (no `map.md`/`tickets/`) dir;
  that interaction is an implementation detail, not a decision (see map
  Not yet specified).
- Pinned `skills/*/SKILL.md` stay untouched (ADR-0004).

## Alternatives considered

- **Fixed default dir** (`.planning/adhoc/`): conflates unrelated ad-hoc
  artifacts; not adoptable by `/wayfind seed`. Rejected (ticket 01).
- **Require an effort** (error if unset): breaks lightweight ad-hoc
  brainstorming — the exact case that surfaced the bug. Rejected (ticket 01).
- **Amend ADR-0005 in place:** erodes the decision-record history. A new ADR
  with a pointer preserves the trail. Chosen (ticket 03).
