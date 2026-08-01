# Wayfinder map: 2026-08-02-hardening-to-resolve-problem-we-find-about-wrong

## Destination

Superpowers **never writes any artifact** — spec, plan, SDD workspace, or
brainstorm mockup — to the upstream `docs/superpowers/` or `.superpowers/`
paths, **whether or not a `/wayfind` effort is active**. The no-effort case is
handled by a defined `.planning/` default, and a regression test guards against
future leakage. Skills stay pinned byte-identical to upstream (ADR-0004); all
divergence lives at the injection layer (`piBoundaryOverrides()`).

This is the gap that bit us: an ad-hoc brainstorm with no active effort fell
back to the pinned skill's literal `docs/superpowers/specs/` default.

## Notes

- **Domain**: `bun-apps/pi-agent-ext-superpowers/src/superpowers.ts` — the
  injection layer (`getBootstrapContent()` + `piBoundaryOverrides()`). The
  pinned skills under `skills/*/SKILL.md` are **read-only** (ADR-0004:
  unregister ≠ edit).
- **Skills every session should consult**: `wayfinder`, `grilling`,
  `domain-modeling`. ADRs: `pi-agent-ext-superpowers/docs/adr/0004` (skill
  fidelity positive pin) and `0005` (parallel coexistence boundary — the
  `.planning/<effort>/` layout + the effort-gated framing this effort reopens).
- **Standing preference**: respect ADR-0004 — never edit pinned `SKILL.md`
  bodies; express all local divergence at the injection layer only.
- **Key asymmetry** (closed research, ticket 00): specs/plans are pure prose —
  no script overrides their path — so enforcement = injected text + a test/lint
  guard. The SDD workspace (`scripts/sdd-workspace`) and the brainstorm visual
  server (`scripts/start-server.sh`) DO honor `PI_PLANNING_EFFORT`.

## Decisions so far

<!-- the index — one line per closed ticket -->

- [Frontier research findings](tickets/00-frontier-research-findings.md) — the
  bootstrap injection is unconditional (reaches ad-hoc sessions, so the gap is
  the text's effort-gated language, not delivery); specs/plans are prose-only
  (no script to override the path); wayfind is already leak-free (scope =
  superpowers-only).
- [No-effort artifact location](tickets/01-no-effort-artifact-location.md) —
  auto-create a dated `.planning/<YYYY-MM-DD>-<slug>/` when no effort is active
  (preserves per-effort isolation; adoptable by `/wayfind seed`; no friction for
  lightweight brainstorms).
- [Regression-guard form](tickets/02-regression-guard-form.md) — both: a unit
  test asserting the injected boundary text's no-upstream-path rule is
  unconditional + a repo lint failing on any new file under
  `docs/superpowers/`/`.superpowers/sdd/` (baseline the one allowed audit file).
- [ADR for unconditional redirect?](tickets/03-adr-for-unconditional-redirect.md)
  — yes: ADR-0006 supersedes ADR-0005's effort-gated clause (leaves 0005's
  disjoint-subpath layout intact with a pointer), recording the unconditional
  rule + the auto-dated no-effort default + the dual guard. (ADR-0006: docs/adr/0006-unconditional-artifact-home.md)

## Not yet specified

- **Interaction with the wayfind coordinator.** 01 settled on an auto-created
  dated dir; the open follow-up is whether `/wayfind seed` / the goal coordinator
  can adopt a *spec-only* dir (no `map.md`/`tickets/`) retroactively, or whether
  it needs scaffolding. Now an implementation concern for ticket 04 rather than
  a standalone decision — not yet ticketable.

## Out of scope

- **Editing pinned skill bodies** — ADR-0004 forbids it; divergence belongs at
  the injection layer. Any "fix the SKILL.md prose" approach is ruled out.
- **wayfind** — grep-confirmed leak-free; writes only to `.planning/`.
- **The semantic/embedding intent-matcher redesign** — separate effort,
  twice-rejected (superpowers ADR-0002-equiv + effort `2026-07-30`).
- **tool-gate savings-claim drift** — the paused effort that surfaced this bug;
  tracked separately under `bun-apps/pi-agent-ext-tool-gate`.
