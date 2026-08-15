> STATUS: DONE — archived 2026-08-15 (shipped in main; see git history / PR references in map)
# wayfind skill-content quality review (2026-07-26)

**Scope:** the 7 fork-authored skills in `bun-apps/pi-agent-ext-wayfind/skills/`
(domain-modeling, grill-me, grill-me-with-docs, grilling, to-spec, to-tickets,
wayfinder). The 14 superpowers skills are ADR-0004-pinned to upstream v6.2.0
(byte-equal, compression-swept, at-latest) → out of editable scope; defects
there would need an ADR-0004 re-pin, not a free edit.

**Method:** read all 7 `SKILL.md` (+ their referenced siblings) against six
criteria — clarity, accuracy, redundancy, consistency, actionability, economy.
Verified the `skill-weight` + `skills` test constraints stay satisfied.

## Strengths (the skills are already strong)

- **Trigger-faithful descriptions** — every `description:` starts "Use when …",
  ≤150 chars where gated, trigger nouns intact (`skill-weight` gate green).
- **Well-layered grill family** — grill-me (pointer) → grilling (discipline) →
  grill-me-with-docs (fuse grill + domain-modeling); each states its place in
  the layering without confusion.
- **Concrete, checkable rules** — grill-me-with-docs' "It's working if" list +
  domain-modeling's 3-criteria ADR gate are crisp success criteria.
- **Accurate references** — domain-modeling's `CONTEXT-FORMAT.md` +
  `ADR-FORMAT.md` siblings exist; commands (`/wayfind`, `/goal`, …) are real;
  to-tickets' "/goal has no agent-side tool" caveat is correct.
- **Fact-freshness discipline** — the `git rev-list --count HEAD..origin/<default>`
  guard appears where it matters (grilling, wayfinder), keeping decisions off
  stale-tree premises.

## Fix applied this iteration

**grilling — removed an internal redundancy.** "The discipline" bullet 5 fully
restated the "Facts vs decisions" section directly above it (both: look up facts
in the environment + confirm branch currency). Trimmed bullet 5 to a one-line
cross-reference so the checklist stays scannable without the duplicated
branch-currency prose (which now lives once, in Facts vs decisions). No
information lost.

## Surfaced for a decision (NOT auto-changed — these are design questions)

### 1. [Headline] Decision-tickets vs build-tickets share one `tickets/` dir

`wayfinder` writes **decision-tickets** — body shape `## Question` + a `type:`
line (research/prototype/grilling/task); the "Plan, don't do" artifact.
`to-tickets` writes **build-tickets** — YAML frontmatter (`type: task`,
`blocking:`, `status: open`) + `## Question` + `## What to build` +
`## Acceptance`; the execution-slice artifact.

Both land in the SAME `.planning/<effort>/tickets/NN-slug.md` namespace. If an
effort runs wayfind (decide) AND then to-tickets (execute) into the same effort
dir, the two shapes coexist: numbering can collide, and `/wayfind status`
(which scans `tickets/`) would see build-tickets it doesn't model. This may be
safe by convention (decision-tickets close before to-tickets runs, or they use
separate effort slugs) — but it's undocumented. **Decision needed:** is the
coexistence safe by convention, or should build-tickets live under a separate
subdir (e.g. `.planning/<effort>/build-tickets/`) or a shape marker so wayfind's
status scan ignores them?

### 2. domain-modeling — embedded anchor-check script (optional extraction)

domain-modeling inlines a ~20-line `python3 - <<'PY'` block to verify
`_Source_:` anchors resolve. It works + is self-contained, but it's
language-narrow (`.ts`/`.py` only) and heavy in the skill body. Optional:
extract to `skills/domain-modeling/scripts/check-anchors.sh` and reference it,
mirroring how `sdd-workspace` / `task-brief` are script-backed. Low priority —
the skill is on-demand, so the body weight is paid only when invoked.

### 3. Economy notes (on-demand skills — lower weight priority)

- `wayfinder` (136 lines) is the longest. It's thorough (the orchestrator);
  its fact-freshness appears once in full + twice as deferring step-references
  (not redundant). Aggressive trimming risks losing useful detail → left as-is.
- All 7 skills are on-demand (body loaded via `read`, not every request), so
  body length costs far less than always-on description weight (already gated).

## Constraints preserved

- `tests/skills.test.ts` — 7 skills discovered; frontmatter valid YAML; `name`
  lowercase-hyphen; `description` "Use when"-prefixed, >20 chars; frontmatter
  ≤1024 chars; body has H1. ✅ (the grilling edit is body-only.)
- `tests/skill-weight.test.ts` — domain-modeling + grilling descriptions ≤150
  chars + trigger nouns present. ✅ (the edit touched grilling's BODY, not its
  description.)
