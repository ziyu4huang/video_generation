---
effort: 2026-08-20-develop-pipeline-v2
created: 2026-08-20
status: spec-draft
supersedes: .planning/done/2026-08-17-develop-pipeline/map.md (partially — execution leg)
tier: T3
---

# Spec — develop-pipeline v2

## Destination

The canonical agent development pipeline v2: workflow promoted from
"JUDGMENT layer only" to the primary execution engine, with an explicit
tier system, mechanical entry gates, and a unified dispatch record that
feeds learning back into memory.

```
        entry (tier router — mechanical size rules)
             |
   T1 small ─────────> bounded design (chat) → single executor → devops
   T2 medium ─> wayfind quick grill → thin spec → plan → workflow → devops
   T3 large  ─> wayfind full spine (map→spec) → superpowers plan
                     → workflow execute (fan-out: impl/verify/janitor) → devops
```

Pain points addressed (user, 2026-08-20): workflow under-used; dispatch
primitives fragmented; too many stages / too much ceremony; handoff
contracts have no teeth.

## 1. Tier system and entry routing

Mechanical size rules (recorded in the diagram of record; no judgement
calls at entry):

| Tier | Trigger (any hit upgrades) | Path |
|---|---|---|
| T1 | ≤3 files in one package, no new interface, no schema change | bounded design in chat (2-3 sentences) → single executor (direct subagent or single-stage workflow) → devops |
| T2 | 4-10 files in one package, OR crosses 2 packages, OR touches exports | wayfind quick grill (arch-level Qs only) → thin spec (≥5 lines of decisions) → plan → workflow → devops |
| T3 | ≥3 packages, new interface/extension, or runtime core nouns | full spine: wayfind map→spec → superpowers brainstorm+plan → workflow execute (fan-out impl/verify/janitor) → devops |

- The driver declares `tier: T<n>` in `.planning/<effort>/map.md`
  frontmatter at effort start; `pipeline-gate` later verifies the
  declaration against actual change size (anti-drift). T2's quick grill
  still produces a minimal map.md (open Qs + decisions, one line each
  is enough) — that is what the T2 gate checks.
- T1 has no map.md: the tier declaration is the `--tier` argument to
  `pipeline-gate` (or the `tier: T1` trailer in the commit message);
  the gate still verifies declaration-vs-size.
- Mid-effort hidden complexity forces a stop, re-tier, and backfill of
  left-side artifacts — existing "fog flows left" rule, now with an
  explicit tier knob.
- T1 does NOT create `.planning/<effort>/` (no folder ceremony for small
  changes); commit message must carry the rationale. T2/T3 keep the
  current `.planning/` standing rule.

## 2. Workflow as primary execution engine

Division: superpowers `executing-plans` stops dispatching subagents
ticket-by-ticket. It becomes driver + judgment (read plan, handle red,
decide redispatch vs systematic-debugging). Deterministic fan-out moves
to workflow scripts.

Three standard templates (version-controlled and tested, in
`bun-apps/pi-agent-ext-workflow/samples/` or workflow-pack):

```
execute-plan.tsw  (T2/T3 main template)
  phase('Gate')     entry-criteria check (every task has Run:/Expected:,
                    tier declaration consistent)
  phase('Execute')  pipeline(tickets,
                     t => agent(mission brief, {schema: exec report}),  // impl
                     r => agent(verify prompt, {schema: verdict}))      // verify per ticket
  phase('Janitor')  sweep budget-dead children → commit what is green
  phase('Report')   aggregate dispatch ledger (D8 fields:
                    task/tokenBudget/maxTurns/outcome/SHA)

execute-t1.ts      single-task template: 1 impl + 1 verify, no phase overhead
review-plan.ts     plan review panel (existing JUDGMENT use, unchanged)
```

Key mappings:

- Evidence base (150-260k tokenBudget, 6-14 maxTurns, mandatory final
  report, verify child, janitor) carries into the templates unchanged —
  validated parameters from the 2026-08-16 effort, not new inventions.
- superpowers `dispatching-parallel-agents` is rewritten as "how to
  write mission briefs for workflow + when to reclaim manual dispatch
  (red lights, cross-ticket judgement)". Single source of truth stays,
  content changes.
- The two-runtimes "JUDGMENT-only" gate is formally reopened: a wayfind
  map entry records the decision change (evidence: the four pain points
  above); old decision marked SUPERSEDED.
- Workflow `budget`/`resume` replace manual D8 ledger bookkeeping — the
  workflow journal IS the ledger; `progress.md` keeps only the summary.
- Manual dispatch via executing-plans is retained as fallback, not
  deleted.

## 3. Unified dispatch records and learning loop

Every dispatch (workflow-driven or manual subagent) lands one
isomorphic record, queryable afterwards and feedable to memory:

```
{ effort, tier, ticket, engine: workflow|manual, tokenBudget, maxTurns,
  outcome: green|red|budget-dead|skipped, commit SHA, gate result, ts }
```

- Storage: no new store. Workflow side extends `run-persistence.ts`
  with an aggregation export; manual side reads existing
  `subagent_runs` (pi-agent-ext-subagent). A small normalizer merges
  both into the schema above, written to `.planning/<effort>/`
  (human-readable).
- Query: `pi-agent cli dispatch-log` subcommand (same commands/ home as
  pipeline-gate) — filter by effort/tier/outcome; answers "what did
  this class of ticket cost last time, what death rate".
- Learning loop:
  1. Effort close: `devops_retrospect` reads dispatch-log and writes
     anomaly patterns (ticket classes with repeated budget-death, engine
     losses) as hermes-memory facts — via the existing hermes path, no
     new mechanism.
  2. Entry consult: wayfind grill / tier routing may query dispatch-log
     baselines (replacing the single 2026-08-16 150-260k baseline), so
     tokenBudget/maxTurns calibrate against accumulated history.
- T1 records too: no effort folder, but the dispatch record still lands
  (flat file or native subagent_runs) — learning data is tier-agnostic.

## 4. `pipeline-gate` — mechanical teeth

`bun-apps/pi-agent/src/cli/commands/pipeline-gate.ts`, wired via
`src/cli/extensions/registry.ts`, following the existing cli pattern
(JSON output, exit 0/1/2).

Checks by tier:

| Check | T1 | T2 | T3 |
|---|---|---|---|
| tier declaration matches actual change size | ✓ | ✓ | ✓ |
| map.md zero open Qs (wayfind frozen) | — | ✓ | ✓ |
| spec zero open decisions | — | ✓ | ✓ |
| every task has `Run:`/`Expected:` | — | ✓ | ✓ |
| dispatch ledger exists, every entry has outcome + SHA | — | ✓ | ✓ |

- Two call sites:
  1. Workflow template opening: `execute-plan.tsw` Gate phase invokes
     the same check (host-fn or cli spawn) — red stops entry and prints
     "which stage to return to".
  2. Standalone CLI: `pi-agent cli pipeline-gate --effort <name>` any
     time. NOT wired into `local_ci`/pre-push (local_ci keeps its ≤5 min
     budget; this check is a pure text scan, milliseconds — hook it in
     later only if needed).
- Implementation is mechanical scanning, no agents: open-Q count =
  lines in map.md open-question block; `Run:/Expected:` = grep over
  ticket files; tier size = `git diff --stat origin/main...HEAD`
  against section-1 rules. No LLM, no network, testable
  (`pipeline-gate.test.ts`).
- Red output: not just exit 1 — prints which contract broke, which
  stage to return to, what to backfill (concrete "fog flows left"
  guidance).
- D5 revision: the original "no tool-gate linter unless drift proves we
  need one" premise is overturned by the user (2026-08-20, pain point:
  handoffs have no teeth). New decision recorded in this effort's
  wayfind map.

## 5. Migration and change list

| Package | Change |
|---|---|
| `.planning/2026-08-20-develop-pipeline-v2/` | wayfind map (reopen two-runtimes, tier system, D5 revision) → spec → tickets |
| `bun-apps/pi-agent/src/cli/commands/` | `pipeline-gate.ts` + tests; `dispatch-log.ts` + tests; registry wiring |
| `bun-apps/pi-agent-ext-workflow/` | `execute-plan` / `execute-t1` templates (samples or workflow-pack); `run-persistence.ts` aggregation export |
| `bun-apps/pi-agent-ext-subagent/` | dispatch-log normalize read side (`subagent_runs` source; possibly a small adapter) |
| `bun-apps/pi-agent-ext-superpowers/` | `dispatching-parallel-agents` rewrite (mission briefs for workflow + when to reclaim manual dispatch) |
| root docs | CONTEXT-MAP.md Pipeline section points to v2 diagram; CLAUDE.md unchanged (points at CONTEXT-MAP) |

Execution order (this effort itself runs the T3 path — dogfooding):

1. wayfind: grill → map (reopen two-runtimes, freeze tier rules) → to-spec
2. superpowers: brainstorming done (this conversation; harvest into
   brainstorm/) → writing-plans produces tickets
3. workflow: once `execute-plan` template lands, this effort's
   remaining tickets dispatch through it (first real data point)
4. gate: `pipeline-gate` implemented first (ticket 01); all later
   tickets run under it
5. close: dispatch-log produces this effort's ledger →
   `devops_retrospect` writes the first learning facts → old map.md
   (2026-08-17) marked SUPERSEDED-by pointing at v2

## Risks and boundaries

- First workflow-template version may hit runtime limits
  (budget/resume behavior) — templates carry tests; executing-plans
  manual dispatch stays as fallback.
- `subagent_runs` vs workflow journal schema gap may be larger than
  expected — the normalize layer is its own small module; if the gap is
  too wide, normalize only the workflow side first.
- Remote CI stays disabled by design; all gates are local.

## Out of scope

- Restructuring wayfind/superpowers skills themselves (methodology
  ownership unchanged).
- Remote CI enablement — permanently disabled by design.
- The MLX movie pipeline (python/mlx-movie-director) — a different
  pipeline.
