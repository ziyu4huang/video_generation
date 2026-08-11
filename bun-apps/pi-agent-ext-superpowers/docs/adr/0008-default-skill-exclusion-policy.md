# ADR-0008: Default skill-exclusion policy

Date: 2026-08-10
Status: accepted
See: [ADR-0004](./0004-skill-fidelity-positive-pin.md) (unregister ≠ edit),
[ADR-0007](./0007-unconditional-artifact-home.md),
[spec](../../../../.planning/2026-08-10-superpowers-tighten-and-document/spec.md)

## Context

The package ships 14 fidelity-locked skills (ADR-0004). `resources_discover`
advertises the set pi registers at session start — every advertised skill costs
its full `SKILL.md` in the system prompt every request. Two skills should not be
advertised by default, for distinct reasons, but until now only one was excluded
and its rationale lived in a code comment that drifted (it claimed "~139 tok/req
saved"; the skill is 3,646 bytes ≈ 900 tok).

A measurement also found that `using-superpowers` was both **injected as the
bootstrap body** (`getBootstrapContent()` reads `skills/using-superpowers/SKILL.md`
and embeds it, with the instruction "Do not try to load using-superpowers again")
**and advertised** as one of the 13 skills — a ~763 tok/req double-count plus a
confusing invokable skill the agent is told not to use.

## Decision

`DEFAULT_SKILL_EXCLUDE = ["verification-before-completion", "using-superpowers"]`,
each excluded for a distinct reason:

| Skill | Size | Reason | Class |
|-------|------|--------|-------|
| `verification-before-completion` | 3,646 B ≈ 900 tok | Phase-3 clean-pass: the model resists confidence-escalation even without this skill, so excluding it costs ~zero behavior. | behavior |
| `using-superpowers` | 3,063 B ≈ 763 tok | Bootstrap dedup: its full body is already injected as the bootstrap (`getBootstrapContent`), which tells the agent not to load it again. | redundancy |

Figures are `wc -c` on each `SKILL.md` divided by ~4 (chars-per-token heuristic).

Neither skill's `SKILL.md` is edited — "unregister ≠ edit" (ADR-0004). Both files
stay on disk byte-identical; they are simply omitted from the
`resources_discover` advertisement.

**Override knobs:**
- `PI_SUPERPOWERS_SKILL_EXCLUDE` — additive comma-list of skill dir-names to also
  exclude (composed with the defaults).
- `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0` (or `false`/`no`/`off`) — suppress the
  defaults entirely, re-advertising both (including the `using-superpowers`
  double-count). Acceptable as an explicit opt-out, e.g. a probe fat-run that must
  load every skill.

## Consequences

- Advertised set: 13 → 12; ~763 tok/req saved (the `verification-before-completion`
  exclusion predates this ADR).
- `using-superpowers` content remains ever-present via the bootstrap (injected on
  `session_start`/`session_compact` until first `agent_end`, re-armed on compact);
  only the redundant `/skill:using-superpowers` command + system-prompt entry is
  removed.
- Disabling defaults restores the historical "all 14 advertised" behavior.

## Alternatives considered

- **Strip `using-superpowers` from the bootstrap (keep it advertised).** Rejected:
  the bootstrap must be present before the agent's first response, so it cannot be
  deferred to on-demand skill loading.
- **Re-enable `verification-before-completion`.** Rejected: the Phase-3 finding
  (no behavioral cost to excluding it) still stands.
- **Document only, don't exclude `using-superpowers`.** Rejected: the
  double-count is pure waste with ~zero behavioral gain.
