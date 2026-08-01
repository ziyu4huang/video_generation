# Implement no-leak + regression guard

type: task

## Question

Land the hardening: (1) strengthen `piBoundaryOverrides()` in
`bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` so the "never write to
upstream paths" rule is **unconditional** and names the no-effort default
location chosen in ticket 01; (2) add the regression guard chosen in ticket 02;
(3) if ticket 03 resolved "ADR needed", ship ADR-0006 alongside.

Acceptance criteria:

- `piBoundaryOverrides()` output no longer contains the phrase "when an effort
  is active" as a *condition* on avoiding upstream paths — the avoidance is
  unconditional; the effort only chooses *which* `.planning/<effort>/` subdir.
- The no-effort case resolves to a concrete `.planning/` path (per ticket 01),
  never to `docs/superpowers/`.
- The ticket-02 guard passes in CI; manually provoking an upstream-path write
  fails it.
- Pinned `skills/*/SKILL.md` bodies are **untouched** (ADR-0004) — `git diff`
  shows no changes under `skills/`.
- ADR-0006 (if applicable) is linked from `map.md`.

Blocked by:

- [01 — No-effort artifact location](01-no-effort-artifact-location.md)
- [02 — Regression-guard form](02-regression-guard-form.md)
- [03 — ADR for unconditional redirect?](03-adr-for-unconditional-redirect.md)

## Notes

- Verify against both artifact families: prose-only (spec via brainstorming,
  plan via writing-plans) and script-backed (SDD workspace, visual companion) —
  the text fix covers prose; confirm the scripts still honor `PI_PLANNING_EFFORT`
  and now also have a sane no-effort fallback per 01.
- Run `bun test --cwd bun-apps/pi-agent-ext-superpowers` after the change.
