# Wayfinder map: 2026-07-26-after-sync-to-latest-remove-default-branch-conti

## Destination

A leaner `bun-apps/pi-agent-ext-superpowers/`: less redundancy, dead weight and
structural duplication across **skills + src + tests + docs**, smaller surface
area, higher maintainability. Skill content **is** editable (upstream divergence
accepted — continues the prior compression sweep, commit `30773d5d`).
Genuinely redundant or provably-unused skills **may** be retired/merged, but
every capability currently relied on is preserved. No single quantitative
metric — prompt-weight reduction is a welcome side-effect, not the gate.

## Notes

- **Domain**: pi extension package `@repo/pi-agent-ext-superpowers`
  (`bun-apps/pi-agent-ext-superpowers/`). Vendored from upstream Superpowers
  (currently v6.2.0-aligned), maintained via `scripts/rebaseline-upstream-skills.ts`
  + `migrations/`. Active divergence is already a supported mode.
- **Skills every session should consult**: `wayfinder` (this map),
  `grilling`, `domain-modeling` when working the decision tickets.
- **Standing preferences** (zh-TW conversation, English artifacts).
- **Research baseline (charted 2026-07-26)**: weight is overwhelmingly in skill
  *markdown* (~8.5k lines / 15 skills; `writing-skills` alone ≈2589 = 30%). The
  TS code is already minimal (~346 LOC across `src/`) — deep code audit is
  effectively out of scope. `tests/__fixtures__/upstream-skills/*.md` (~2.4k
  lines) duplicates the skills as frozen fidelity snapshots — the rebaseline
  burden scales with skill edits, so the fixture strategy is coupled to the
  compression decision. A skill-exclusion mechanism already exists
  (`DEFAULT_SKILL_EXCLUDE` + `PI_SUPERPOWERS_SKILL_EXCLUDE` env), so retiring a
  skill is reversible and low-risk.

## Decisions so far

<!-- the index — one line per closed decision ticket -->

- [04 — Decide the skill-content compression plan](tickets/04-decide-skill-compression-plan.md) — pilot `writing-skills`; a behavior-preserving trim of `anthropic-best-practices.md` was **proposed then reverted on inspection (net 0)** — mixed redundant + unique access-model guidance; in-place-fork posture chosen but **dormant** (no pinned file edited → ticket 06 moot).
- [05 — Decide which skills to retire / merge](tickets/05-decide-skill-retirements.md) — retire **nothing**: under the strict "fully subsumed" bar every loaded skill earns its place (set is complementary, not redundant); `executing-plans` was the lone borderline but kept.
- [06 — Decide the fixtures / fidelity strategy](tickets/06-decide-fixtures-fidelity-strategy.md) — **moot**: no pinned `SKILL.md` was edited, so ADR-0004 positive-pin stays intact; the 04 "drop writing-skills from fixtures" clause is dormant unless a future Phase-2 SKILL.md rewrite happens.

## Not yet specified

<!-- All decisions resolved (04, 05, 06 closed). Remaining levers harvested as -->
<!-- deferred prizes at effort close — see the closing next-goal file. -->

_None — the conservative audit's route is clear and complete._
- **Execution & verification handoff**: once the cut decisions (04-06) land,
  the doing is plannable → hand off to `writing-plans` / SDD with a verify gate
  (`bun run check && bun run build && bun test`, prompt-weight delta). The map
  is decisions-by-default; execution is not a map ticket unless Notes override.

## Out of scope

- **Deep `src/` code simplification** — the TS code is already lean (~346 LOC,
  no meaningful dead code found in research ticket 02). Surface-area reduction
  here is negligible; not worth a decision ticket.
- **docs/ cleanup** — only 3 ADRs / 223 lines, already lean (research ticket 03).

## Post-close probe (2026-07-26): the bootstrap lever

Probed the `using-superpowers` bootstrap (the one deferred prize that is
genuinely per-request). **Finding: it too is mostly load-bearing.** The
injected payload is ~1.3k tok/session — **not** the inventory's "192 lines"
(that counted the whole dir; only the 62-line `SKILL.md` + two helper fns are
injected, the `references/` are on-demand):

- `SKILL.md` body (~640 tok) — anti-rationalization enforcement
  (EXTREMELY-IMPORTANT + Red Flags table); trimming defeats its purpose.
- `piToolMapping()` (~370 tok) — the **one lever**: inlines subagent
  operational gotchas (commitScope to catch the `.planning/sdd`-scratch-in-commit
  bug; tier portability; concurrency = `workflow` not subagent-batch) largely
  duplicated by the on-demand `references/pi-tools.md`. Compressing could save
  ~250 tok/session BUT moves bug-prevention to on-demand → re-introduction risk.
- `piBoundaryOverrides()` (~240 tok) — Superpowers-vs-Wayfind pipeline routing;
  load-bearing repo convention.

➡️ Under the conservative posture the safe net win on the bootstrap is also
marginal (~250 tok with real re-introduction risk); the "192 lines" framing was
inflated by the dir-vs-injection confusion. All three audit faces — content
(pilot net 0), skill-set (no retirements), per-request bootstrap — converge: the
extension is lean; remaining trims are load-bearing or risky. To get real cuts
you must **escalate posture** (aggressive Phase-2 rewrite) — a deliberate
risk/reward choice, not part of this conservative audit.
