type: research
status: closed
claimed: chart-session (2026-08-04)
blocked by: —

## Question

How does a pi extension package expose a skill so the agent loads it on-demand? Does
`pi-agent-ext-devops` need the superpowers-style programmatic registration
(`resources_discover` + a `session_start`/`session_compact` bootstrap injection), or
does the bare package mechanism suffice?

## Resolution

**Bare package skills suffice; bootstrap is out of scope for v1.**

Pi auto-discovers skills from **package `skills/` directories or `pi.skills` /
`skills` entries in `package.json`** (verified in pi `docs/skills.md`): recursive
`SKILL.md` lookup, **progressive disclosure** (only the `description` is always in
context; the full body loads on-demand via `read`), and each skill registers as a
`/skill:<name>` command. Frontmatter requires `name` + `description`.

The superpowers extension does *more* — programmatic `resources_discover` + a
`using-superpowers` bootstrap **injected into context on `session_start`/`session_compact`
until the first `agent_end`** — but that exists because `using-superpowers` is a
**session-orientation** skill (it must steer the agent from turn one). `land-pr` is
**on-demand** (load it when actually landing a PR), so it needs no bootstrap.

**Decision**: ship `pi-agent-ext-devops/skills/land-pr/SKILL.md` and add to the
devops `package.json`: `"files": ["skills/", …]` and `"skills": ["./skills"]` (mirror
`pi-agent-ext-superpowers/package.json` lines 22 / 53–54).

**Build-time verification (deferred — couples to the build)**: confirm `/skill:land-pr`
actually loads when devops is registered as an extension in
`bun-apps/pi-agent/run-dir/manifest.json`. If an extension package does *not* auto-expose
`package.json` skills, fall back to a minimal `resources_discover` registration in
`extensions/devops.ts` (still no session-start bootstrap).
