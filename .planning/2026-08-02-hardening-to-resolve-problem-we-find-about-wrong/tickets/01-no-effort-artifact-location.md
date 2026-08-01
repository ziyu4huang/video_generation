# No-effort artifact location

type: grilling
claimed: pi-agent (main session, 2026-08-02)

## Question

When `PI_PLANNING_EFFORT` is unset (an ad-hoc brainstorm / plan, not started via
`/wayfind`), where should superpowers artifacts resolve under `.planning/`? The
destination requires *some* `.planning/` home for the no-effort case — this
ticket picks which.

Candidate answers (grill one at a time, with a recommendation):

- **Auto-create a dated effort dir** — e.g. `.planning/<YYYY-MM-DD>-<slug>/`,
  derived from the brainstorm topic. Most consistent with the
  `/wayfind`-initiated layout (every effort is a dated dir); the model invents
  the slug. *Recommended* — it keeps ad-hoc and intentional efforts in one
  shape, and a later `/wayfind` can adopt the dir.
- **Fixed default dir** — e.g. `.planning/unsolicited/` or `.planning/adhoc/`.
  Simplest; no slug invention. But it conflates many unrelated ad-hoc artifacts
  into one bucket and can't be adopted by `/wayfind seed`.
- **Refuse and require an effort** — error/guard if no effort is active, forcing
  the user to name one. Strongest hygiene, but breaks lightweight ad-hoc
  brainstorming (the exact case that surfaced this bug).

Blocked by: _(none — frontier)_

## Notes

- The chosen location is consumed by ticket 04 (implementation) and shapes
  ticket 03 (whether the change needs an ADR).
- See map **Not yet specified**: the interaction between an auto-created dir and
  `/wayfind seed` / the goal coordinator — surface this when grilling.

## Resolution

**Decision: auto-create a dated effort dir** — `.planning/<YYYY-MM-DD>-<slug>/`
where `<slug>` is a short kebab-case of the topic, when `PI_PLANNING_EFFORT`
is unset. Rationale: the only option that preserves the `.planning` layout's
per-effort isolation for ad-hoc work, stays adoptable by `/wayfind seed`, and
doesn't impose the friction of requiring an effort for lightweight brainstorms.
The effort-active case is unchanged (redirect to `.planning/<effort>/`).

Implications:
- The injection text (`piBoundaryOverrides()`) must instruct the model to derive
  `<YYYY-MM-DD>-<slug>` from the topic when no effort is active — consumed by
  ticket 04.
- A spec/plan written ad-hoc lands at `.planning/<YYYY-MM-DD>-<slug>/{spec,plan}.md`
  (a "naked" effort — no `map.md`/`tickets/`), which is a valid layout (cf.
  `.planning/2026-07-19-goal-todo-handoff-stopgap/`).
- Surfaced for follow-up (stays in map Not yet specified): whether `/wayfind seed`
  can adopt a spec-only dir retroactively — implementation detail for 04.

Status: closed (2026-08-02)
