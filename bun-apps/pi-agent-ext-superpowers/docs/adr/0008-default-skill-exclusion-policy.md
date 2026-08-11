# ADR-0008: Default skill-exclusion policy

Date: 2026-08-10
Status: accepted
See: [ADR-0004](./0004-skill-fidelity-positive-pin.md) (unregister ≠ edit),
[ADR-0007](./0007-unconditional-artifact-home.md),
[spec](../../../../.planning/2026-08-10-superpowers-tighten-and-document/spec.md)

## Context

The package ships 14 fidelity-locked skills (ADR-0004). `resources_discover`
advertises the set pi registers at session start. Per advertised skill, pi core's
`formatSkillsForPrompt` (`dist/core/skills.js:257-279`) injects only `<name>` +
`<description>` + `<location>` (absolute filePath) in an XML `<skill>` wrapper —
the `Skill` type has no body field, and skill bodies are read on-demand, never
injected by advertisement. Two skills should not be advertised by default, for
distinct reasons, but until now only one was excluded and its rationale lived in a
code comment that drifted (it claimed "~139 tok/req saved"; the advertisement
actually costs ≈ 121 tok — the inflated figure came from `wc -c` of the 3,646 B
`SKILL.md` body, which is never injected by advertisement).

A measurement also found that `using-superpowers` was both **injected as the
bootstrap body** (`getBootstrapContent()` reads `skills/using-superpowers/SKILL.md`
and embeds it, with the instruction "Do not try to load using-superpowers again")
**and advertised** as one of the 13 skills — a redundant ~96 tok/req pointer (its
body is already present via the bootstrap) plus a confusing invokable skill the
agent is told not to use.

## Decision

`DEFAULT_SKILL_EXCLUDE = ["verification-before-completion", "using-superpowers"]`,
each excluded for a distinct reason:

| Skill | Advertisement removed | Reason | Class |
|-------|----------------------|--------|-------|
| `verification-before-completion` | 484 B ≈ 121 tok | Phase-3 clean-pass: the model resists confidence-escalation even without this skill, so excluding it costs ~zero behavior. Its 3,646 B body is never injected — only the 484 B advertisement is removed. | behavior |
| `using-superpowers` | 387 B ≈ 96 tok | Bootstrap dedup: its body (2,864 B ≈ 716 tok) is already injected as the bootstrap (`getBootstrapContent`), which tells the agent not to load it again. | redundancy |

Advertisement cost = the `<name>` + `<description>` + `<location>` (abs filePath) +
XML `<skill>` wrapper injected per advertised skill by pi core's
`formatSkillsForPrompt` (`dist/core/skills.js:257-279`); bodies are read on-demand,
never injected by advertisement. So the 3,063 B / 3,646 B `wc -c` body sizes are NOT
what advertising costs — the `using-superpowers` body is paid via the bootstrap
regardless of advertisement, and the `verification-before-completion` body is
never injected at all.

Neither skill's `SKILL.md` is edited — "unregister ≠ edit" (ADR-0004). Both files
stay on disk byte-identical; they are simply omitted from the
`resources_discover` advertisement.

**Override knobs:**
- `PI_SUPERPOWERS_SKILL_EXCLUDE` — additive comma-list of skill dir-names to also
  exclude (composed with the defaults).
- `PI_SUPERPOWERS_SKILL_EXCLUDE_DEFAULTS=0` (or `false`/`no`/`off`) — suppress the
  defaults entirely, re-advertising both (including the redundant
  `using-superpowers` advertisement pointer). Acceptable as an explicit opt-out,
  e.g. a probe fat-run that must load every skill.

## Consequences

- Advertised set: 13 → 12; ~96 tok/req saved (dropping the redundant
  `using-superpowers` advertisement; the `verification-before-completion`
  exclusion, ≈ 121 tok/req, predates this ADR).
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
- **Document only, don't exclude `using-superpowers`.** Rejected: a redundant
  ~96-tok/req advertisement pointer (body already in the bootstrap) plus a
  confusing invokable entry the agent is told not to use — pure waste with ~zero
  behavioral gain.

## Future work (efficiency targets)

Two further "reduce advertised-skill cost" approaches were considered for a later
effort. **Both premises are invalidated by the corrected cost model and are NOT
being pursued:**

- **Approach B — lazy-load the advertised set per turn.** Not feasible at the
  extension/hook level: `resources_discover` is a one-shot call at startup/reload,
  there is no mid-session add/remove API, and skill bodies are already read
  on-demand (only the ~1,181 tok advertised set — name+desc+location across all
  12 skills — is ever-present). True per-turn loading would require a pi-core
  change for ~negligible savings. Not pursuing.
- **Approach C — profile knobs to curate which skills are advertised.** The
  premise (need new code to hide skills) is false: pi core's
  `disable-model-invocation: true` frontmatter already un-advertises a skill at
  zero code cost (filtered in `formatSkillsForPrompt`; `/skill:name` still works
  via the unfiltered registry), and this extension's `DEFAULT_SKILL_EXCLUDE`
  path-filtering already does it policy-correctly without editing pinned skills
  (ADR-0004 — "unregister ≠ edit"). Not pursuing.
- **Real efficiency target (if per-session token cost becomes the goal):** the
  bootstrap payload injected eagerly every session/compaction until first
  `agent_end` — ~2,050 tok/session (`piToolMapping` ~765 tok +
  `piBoundaryOverrides` ~502 tok + `using-superpowers` body ~716 tok + intro
  ~62 tok), dominated by the non-skill `piToolMapping`+`piBoundaryOverrides`
  (~1,267 tok). Trimming that is a separate effort, not skill-advertisement
  shaping.

## Amendment: cost-model correction (2026-08-11)

The original cost figures in this ADR (merged in #1235) used `wc -c` of each
skill's entire `SKILL.md` body to "cost" the advertisement, which overstates the
advertisement cost ≈ 7.9× per skill. Verified against pi core's
`formatSkillsForPrompt` (`dist/core/skills.js:257-279`), which injects only
`<name>` + `<description>` + `<location>` (abs filePath) per advertised skill in
an XML wrapper — the `Skill` type has no body field and `loadSkillFromFile`
discards the body after parsing frontmatter, so **skill bodies are never injected
by advertisement** (they are read on-demand when a skill is actually invoked).

Corrected figures: `verification-before-completion` advertisement ≈ 121 tok
(484 B); `using-superpowers` advertisement ≈ 96 tok (387 B); whole advertised set
(12 skills) ≈ 1,181 tok. The **DECISION is unchanged** — both exclusions still
hold (`v-b-c` = Phase-3 auto-run behavior, not model-invoked;
`using-superpowers` = its body is already injected via the bootstrap, so the
advertisement is a redundant ~96-tok pointer + a confusing invokable entry). Only
the magnitudes and the mechanism description were corrected. The dominant eager
per-session cost is the bootstrap payload (~2,050 tok), not skill advertisement.
