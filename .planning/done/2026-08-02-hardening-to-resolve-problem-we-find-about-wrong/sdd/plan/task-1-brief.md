## Task 1: Record the decision — ADR-0006

**Files:**
- Create: `bun-apps/pi-agent-ext-superpowers/docs/adr/0006-unconditional-artifact-home.md`
- Modify: `bun-apps/pi-agent-ext-superpowers/docs/adr/0005-parallel-coexistence-boundary.md` (add a pointer line)

**Interfaces:** none (documentation). Produces the decision record Tasks 2–3 implement.

- [ ] **Step 1: Write ADR-0006**

Create `docs/adr/0006-unconditional-artifact-home.md`:

```markdown
# ADR-0006: Unconditional artifact home — never write to upstream paths

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

## Decision

The no-upstream-path rule is **unconditional**: superpowers never writes any
artifact (spec, plan, SDD workspace, brainstorm mockup) to `docs/superpowers/`
or `.superpowers/`, with or without an active effort.

- `PI_PLANNING_EFFORT` set → resolve under `.planning/<effort>/` (unchanged).
- `PI_PLANNING_EFFORT` unset (ad-hoc) → the model derives a dated effort dir
  `.planning/<YYYY-MM-DD>-<slug>/` (`<slug>` = short kebab of the topic).

Guarded by (a) a unit test asserting the boundary text's rule is unconditional,
and (b) a repo lint failing on any file beyond the baseline under the upstream
paths.

## Consequences

- Ad-hoc artifacts persist as dated `.planning/` dirs instead of silently
  dropping under `docs/superpowers/` — a real, accepted trade-off (isolation +
  discoverability over nonchalance).
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
```

- [ ] **Step 2: Add the pointer to ADR-0005**

In `docs/adr/0005-parallel-coexistence-boundary.md`, append to the final
paragraph:

```
**Superseded clause:** the "when an effort is active" qualifier on the
no-upstream-path rule is removed by [ADR-0006](./0006-unconditional-artifact-home.md);
this ADR's disjoint-subpath layout is unchanged.
```

- [ ] **Step 3: Link ADR-0006 from the map**

In `.planning/2026-08-02-hardening-to-resolve-problem-we-find-about-wrong/map.md`,
append to the ticket-03 Decisions-so-far line: `(ADR-0006:
docs/adr/0006-unconditional-artifact-home.md)`.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-superpowers/docs/adr/0006-unconditional-artifact-home.md \
        bun-apps/pi-agent-ext-superpowers/docs/adr/0005-parallel-coexistence-boundary.md \
        .planning/2026-08-02-hardening-to-resolve-problem-we-find-about-wrong/map.md
git commit -m "docs(superpowers): ADR-0006 — unconditional artifact home (supersede 0005 clause)"
```

---

