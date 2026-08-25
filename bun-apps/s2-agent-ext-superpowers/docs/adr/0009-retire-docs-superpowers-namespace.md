**ID:** `ADR-superpowers-0009` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: repo-root `CONTEXT-MAP.md`

# ADR-0009: Retire docs/superpowers namespace — .planning is the sole artifact home

Date: 2026-08-17
Status: accepted
See: [ADR-0007](./0007-unconditional-artifact-home.md) (amends: 0007's note that
the flat `.planning/{specs,plans}` layout is "surfaced via the
`docs/superpowers/{specs,plans}` symlinks" is withdrawn; the unconditional
no-upstream-write rule itself stands and is now trivially true of the dead path)

## Context

ADR-0007 kept `docs/superpowers/{specs,plans}` as git-tracked symlinks to
`.planning/{specs,plans}` so pinned upstream skills (ADR-0004 byte-fidelity,
whose prose names those literal paths) would still resolve. In practice the
aliases invited writes: write prescriptions pointed at the alias, coordinators
read through it, and prose had to keep explaining that one truth had two names.
That is a two-truths hazard — the canonical `.planning/` layout and its
`docs/superpowers/` alias could drift (a stale symlink after a repo reorg, a
write through the alias bypassing the canonical-home rule, a fallback that
resolves the alias instead of the canonical path and silently misses when the
alias is absent).

The mitigation run (branch `solution-extension-simplification`) removed every
write prescription to the namespace and re-pointed all readers at `.planning/`
directly, leaving the aliases as dead surface area.

## Decision

The `docs/superpowers/` namespace is retired outright — deleted from the tree,
not symlinked. `.planning/` is the sole artifact home.

- Write prescriptions (skills, bootstrap injection, coordinators) point only at
  `.planning/specs/` and `.planning/plans/` for the no-effort flat layout —
  never at an alias.
- The task-coordinator legacy fallback reads `.planning/plans` directly
  (commit a79d09ac), not through the former alias.
- The audit docket moved to `.planning/done/2026-07-18-workflow-pack-audit/` (re-homed from `.planning/audit/` in the 2026-08-23 planning-tree sweep)
  (`2026-07-18-workflow-pack-finding-docket.md`).
- The leak guard keeps guarding the dead path:
  `tests/artifact-leak.test.ts` enumerates `git ls-files` under the retired
  roots (stored as joined segments so the guard file itself never reintroduces
  the literal path) and fails on ANY tracked reintroduction — regular file or
  symlink.
- ADR-0007 is amended accordingly (see above); nothing else in it changes.

## Consequences

- `docs/superpowers/` no longer exists on disk; a script or agent following
  stale prose gets a missing path, not a silent alias write.
- Pinned upstream skills (ADR-0004) whose prose names the dead path are
  overridden by the bootstrap injection, which never names it.
- One truth: every durable artifact (specs, plans, audits, effort dirs) has
  exactly one home — `.planning/`.

## Alternatives considered

- **Keep the symlinks as a compatibility surface:** preserves stale-path
  behavior but keeps inviting alias writes and the two-truths drift. Rejected.
- **Delete the paths, guard by documentation only:** a note cannot fail CI;
  the leak-guard tripwire can. Rejected.
