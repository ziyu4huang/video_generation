# Planning-Pipeline Cost Optimization Spec

Effort: `2026-08-16-optimize-planning-pipeline-aka-extension` · Status: decided (spec assembly) · Quality bar: metrics-bounded

## Problem Statement

Getting one idea from charting to landed code in this repo costs far more agent spend and far more agent sessions than the work justifies, and almost none of that waste sits where the process polices it.

The baseline audit (200-run subagent window, 2026-08-16 02:01–05:41 UTC, ~3.7 h retention) measured **34.3M tokens** across 200 dispatches (cacheRead 29.08M = 85% of spend). The single dominant line: **limit-truncated dispatches consumed 76% of measured spend (25.98M tok) while producing only 39% of output tokens** — 36 budget-aborts plus 53 turns-aborts (and 1 failed) out of 200 runs, most of them re-reading big cached contexts in dispatches that never complete. Dispatch waste dwarfs every planning-stage overhead this effort originally targeted.

On top of that, three structural multipliers:

- **One ticket per session.** The blanket rule (`procedures/wayfinder.md:131`) multiplies sessions per effort — the knowledge-pipeline effort alone sprawled across ~9–15 sessions over 9 calendar days, 21 tickets, 3 SDD dirs, and 51 planning-dir commits (30 planning-side vs 14 impl-side). Meanwhile the two cheapest audited efforts (tool-gate-qa-harness-generalization: 4/4 tickets resolved in 1 session, 0 subagent runs; view-notifications: 1 PR, 1 run) prove a whole effort can land in one session with ~0 subagent spend.
- **SDD per-task freight.** Across 12 audited SDD workspaces: fixed per-task overhead ≈ 250–350K tok (brief + package + verdict + preamble) regardless of task size; ~1.2M/task average (btw-panel 1.18M, planning-sync 1.24M); one unbatched per-finding fix wave cost **1.06M tok for a single finding**; one NEEDS_CONTEXT round (brief's verbatim code drifted from real symbols) wasted **~858K**; one pivot caught only after `reset --hard` lost **~2.5M** across 3 dropped commits; ~15 of 21 btw-panel parked minors were **plan-mandated verbatim** — the reviewer re-litigating the plan, not implementer defects.
- **Budget ceilings that kill finished work at the report edge.** Budget deaths cluster at the report boundary (1.21M / 1.23M / 1.5M ≈ ceilings), and turns-aborts (53 in the window, median 506K tok / 281s) burn a full implementer's context and produce nothing.

Coverage caveats that shape the currency: `usage.cost` is `$0.00` on every run (no pricing wired for the zai/glm models — dollars are unrecoverable), and **main-session tokens are invisible to the runs DB** (only subagent dispatches are measured, so planning cost is under-represented). Token share is therefore the working currency, and session count is the second axis.

## Solution

Cut cost per effort (tokens + sessions) at equal output quality, via three workstreams:

- **A. Session count** — replace the blanket one-ticket-per-session rule with an amended **cluster + envelope batching rule** (draft carried verbatim below): research and task tickets batch freely in one session; grilling/prototype stay one-per-session except trivially-related small clusters; the envelope trips on three named conditions instead of a numeric cap.
- **B. SDD loop** — five quantified levers: (1) mechanical tasks skip the per-task reviewer; (2) plan-slice briefs ~30× smaller than hand-written ones; (3) one-fix-wave batching extended to task rounds; (4) mandatory pre-SDD plan review; (5) glue-task merge guidance in writing-plans.
- **C. Dispatch cost** — calibrate subagent budgets on real usage: cite the paused `2026-08-15-subagent-dynamic-budgets` map's 4 closed decisions (p90 self-calibration, symmetric timeBudget, turns-on-all-runs, spendBudget never-defaulted), and settle the two open items this effort owns: **report-edge headroom** (proactive wrap-now injection at 85% of token budget or maxTurns−3) and **recalibration cadence + persistence** (calibration table at `~/.pi/subagents/budget-calibration.json`, recalibrate at session start when the runs DB grew ≥50 runs, precedence env > calibrated > frozen).

Equal output quality is not a vibe — it is a **metrics-bounded bar**: the whole-branch final review stays mandatory in every configuration; first-review-clean rate ≥ 77.5% (baseline 31/40); fix-loop depth ≤ 1 median; parked-minor rate not worse than baseline; verified by a one-shot re-audit after the changes land, same method as the baseline audit.

## User Stories

1. As a **repo owner**, I want fewer agent sessions and fewer tokens per idea-to-landed-code effort, so that each shipped feature costs a bounded, measurable amount of agent spend instead of sprawling across a day of dispatches.
2. As a **repo owner**, I want output quality held to explicit metrics (first-review-clean ≥ 77.5%, fix-loop depth ≤ 1 median, parked-minor rate not worse), so that cost cuts can never silently become quality cuts.
3. As a **planning session** (wayfinder chart/grill work), I want to batch small, related research and task tickets within one session under an envelope with named trip-wires, so that I stop paying per-ticket session bootstrap and context re-orientation for work that shares one context.
4. As a **planning session**, I want the batching envelope to break loudly when a resolution opens new fog or I catch myself re-reading the map to re-orient, so that batching never reintroduces the context pollution the one-per-session rule existed to prevent.
5. As an **SDD controller**, I want plan tasks labeled `mechanical` (≤2 files, complete spec in the brief) to skip the per-task reviewer dispatch, so that ~200K × N tokens (~2.4M at a 12-task btw-scale workspace) stop being spent on reviews that never catch anything the final review wouldn't.
6. As an **SDD controller**, I want every fix round to batch all scoped findings into one fix dispatch plus one scoped re-review, so that a single finding never again costs a full 1.06M-token wave.
7. As an **SDD controller**, I want a mandatory plan-critique review before Task 1 dispatches, so that plan-mandated defects (~15/21 of parked minors) and pivot-class port-contract violations (one observed: ~2.5M lost to `reset --hard`) are caught while they are still cheap to fix.
8. As an **implementer subagent**, I want task briefs generated by slicing the plan's task section verbatim, so that my brief is ~30× smaller, carries no hand-written symbol drift, and I never burn a ~858K round discovering that my instructions referenced code that doesn't exist.
9. As an **implementer subagent**, I want small glue steps merged into task-sized chunks by the plan author, so that I stop paying ~250–350K of fixed per-task freight (brief + package + verdict + preamble) on work that is a fraction of a task.
10. As a **reviewer subagent**, I want findings from one review round delivered as one batched list, so that I re-review a fixed set once per round instead of once per finding.
11. As the **final (whole-branch) reviewer**, I want the whole-branch final review to remain mandatory in every configuration — including when all tasks are mechanical — so that the one gate that actually caught the highest-severity bugs (planning-sync's CRITICAL mass-deletion, btw's only Important) is never optimized away.
12. As a **dispatcher**, I want report-edge headroom — a proactive wrap-now instruction injected when a child crosses 85% of its token budget or maxTurns−3 — so that a child who has finished implementing stops dying at the report boundary and loses its work (the #1 observed death pattern: budget deaths clustered at 1.21M/1.23M/1.5M ≈ ceilings).
13. As a **dispatcher**, I want budget defaults calibrated as rolling p90s from the real runs DB, recalibrated at session start when the DB grew ≥50 runs and persisted at `~/.pi/subagents/budget-calibration.json` with env-override precedence, so that ceilings track actual usage instead of a frozen 2026-08-09 tier table while explicit operator overrides always win.
14. As a **human operator**, I want a one-shot re-audit after these changes land (same method as the baseline audit), so that I can see measured token share and session counts move against the 2026-08-16 baseline without standing up permanent cost instrumentation.

## Implementation Decisions

### A. Batching rule (session count)

Replace the blanket one-ticket-per-session rule with the amended **cluster + envelope** rule. The rule text, drafted and settled in ticket 04, carried verbatim for execution:

> Two modes. Either way, resolve tickets in **cluster batches**: research and task tickets may batch freely within one session; grilling and prototype tickets resolve one per session unless the remainder of a small, pre-specified, same-decision cluster is trivially related. The batch envelope breaks — close what's resolved and stop the session — when (a) a resolution opens new fog worth charting, (b) you catch yourself re-reading the map to re-orient (context pollution), or (c) a grilling ticket needs the human mid-cluster. The envelope replaces the old blanket one-per-session rule; it is the same guardrail against context pollution, stated as a trip-wire instead of a cap.

- **Edit site**: direct edit of `bun-apps/pi-agent-ext-wayfind/procedures/wayfinder.md` line ~131 (the sentence `Two modes. Either way, **never resolve more than one ticket per session** — with the exception of research tickets.`) plus the surrounding chart/work-mode prose.
- **Provenance**: repo-authored — confirmed during ticket 04: no pin manifest (`docs/upstream/` absent for this file), not listed among README "Ported skills" batches, single text site. ADR-superpowers-0004/0005 does not apply; no bootstrap-layer override needed.

### B. SDD levers (loop cost)

All five levers from ticket 05, with their numbers and guards. The whole-branch final review stays mandatory in every case (see Quality bar).

1. **Mechanical-task review drop** — plan tasks labeled `mechanical` (≤2 files, complete spec in the brief) skip the per-task reviewer dispatch; the whole-branch final review covers them. Expected ~200K × N saved (~2.4M at btw's 12-task scale). Guard: classification is stated in the plan task header; misclassification surfaces at final review.
2. **Plan-slice briefs** — task briefs generated by slicing the plan's task section verbatim, replacing hand-written prose with verbatim code. ~30× smaller (leanrag: 2.6KB of briefs for 3 clean tasks vs btw's 88.5KB for 12); eliminates the symbol-drift NEEDS_CONTEXT class (one observed event wasted ~858K).
3. **One-fix-wave at task rounds** — every fix round batches ALL scoped findings into one fix dispatch + one scoped re-review. Extends the proven final-wave policy to task rounds; one observed per-finding wave cost ~1.06M for a single finding.
4. **Mandatory pre-SDD plan review** — a plan-critique pass before Task 1 dispatches. Kills the parked-minor plan re-litigation (~15/21 of btw's parked minors were plan-mandated verbatim) and pivot-class contract violations (one observed `reset --hard` pivot lost ~2.5M).
5. **Glue-task merge guidance** — writing-plans guidance merges small glue steps into task-sized chunks (~1M saved per merged pair at observed dispatch costs; fixed per-task freight ≈ 250–350K regardless of task size).

- **Edit sites**: `bun-apps/pi-agent-ext-superpowers/skills/subagent-driven-development/SKILL.md` + `writing-plans/SKILL.md` flow guidance.
- **Provenance precondition** (from the map Notes): clear provenance against upstream pins BEFORE editing skill bodies — the repo adapted these skills heavily (sdd-workspace / task-brief / review-package scripts are repo-native), and ADR-superpowers-0004/0005 forbids patching upstream-verbatim bodies; divergence would land in the injection/bootstrap layer instead. Verify against `bun-apps/pi-agent-ext-superpowers/docs/adr/` + `docs/upstream/` pins during execution, per lever, before each edit.

### C. Dispatch budget & waste

From tickets 01 + 03. The paused map `2026-08-15-subagent-dynamic-budgets` (status: paused, Shares-decision-with this effort both ways) holds the grounding; its four closed decisions are **cited, not re-decided**:

- **CITED (paused map, closed)** — p90 self-calibration: rolling p90 auto-recalibration from `~/.pi/subagents/runs` (tier×role buckets) replaces the frozen 2026-08-09 tier table.
- **CITED (paused map, closed)** — symmetric `timeBudget`: tier defaults + 80% advisory warning + two-stage wrap-up grace (grace turn before hard stop); `timeoutMs` degrades to a backward-compat alias.
- **CITED (paused map, closed)** — `turnsUsed` persisted on ALL runs (today only turns-aborts record it) so calibration has feedback data.
- **CITED (paused map, closed)** — `spendBudget` stays never-defaulted (cost ≡ 0 on this stack).

Two items this effort settles (ticket 03):

- **SETTLED — Report-edge headroom.** Reserve a wrap slice: when a child crosses **85% of its token budget OR (maxTurns − 3)**, the runner injects a wrap-now instruction (stop implementing, emit the report). This extends the existing two-stage wrap-up grace from reactive (fires at the warning) to proactive (fires before the edge). Calibration measures report-edge deaths via the newly persisted `turnsUsed`. Grounding: truncated dispatches = 76% of spend / 39% of output; budget deaths cluster at the report edge (1.21M / 1.23M / 1.5M ≈ ceilings).
- **SETTLED — Recalibration cadence + persistence.** The recalibrated p90 table persists at **`~/.pi/subagents/budget-calibration.json`**; recalibrate at **session start when the runs DB grew ≥ 50 runs** since the last calibration. Precedence: **env override > calibrated table > frozen defaults**.

Brief sizing linkage: plan-slice briefs (lever B2) are the turns-abort countermeasure — smaller input means fewer turns re-orienting in a bloated brief, and verbatim plan slices eliminate the symbol-drift re-dispatch class entirely.

### Quality bar (metrics-bounded)

Verbatim from the human grilling decision (2026-08-16), carried unchanged:

- Whole-branch final review stays **mandatory always** — no lever may remove or weaken it, including all-mechanical task sets.
- First-review-clean rate **≥ 77.5%** (baseline: 31 of 40 reviewed tasks clean on first review).
- Fix-loop depth **≤ 1 median**.
- Parked-minor rate **not worse than baseline**.
- Verification: a **one-shot re-audit after the changes land**, same method as the ticket-01 baseline audit (runs-DB aggregation over the retention window; session counts as commit-session proxies).

## Testing Decisions

- **Affected packages' suites stay green**, run from each package dir under `bun-apps/`:
  - wayfind: `bun run check && bun run typecheck && bun test`
  - superpowers: `bun test`
  - subagent: `bun run check && bun test`
- **Prose-pin sweep BEFORE editing** `procedures/wayfinder.md` or the SDD skill bodies: grep each package's tests for pinned prose on the changed sentences (e.g. `one ticket per session`, `never resolve more than one`, `review-package`) and update any pinned fixtures in the same change. Do this as **execution task 0** and record findings in the plan.
- The batching rule and the SDD levers are **prose/process changes — no new parser code expected**. If execution touches `src` (the headroom wrap-now injection), that change carries its own unit tests per the subagent package's test conventions.

## Out of Scope

- Route-clarity / hygiene doc-code debt of the trio (REVIEW-2026-08-15 findings: phantom manifest entry, stale glossary, dual parser, missing superpowers CONTEXT.md, subagent TUI issues) — per-package hygiene, not cost.
- Stalled-effort hygiene automation / `.planning/` housekeeping.
- Persistent cost-measurement infrastructure (this effort audits one-shot only).
- Deferred prizes (decided out of the spec cut, harvested later): **ledger enforcement** (SDD progress-ledger mandate), **worktree parallelism** (parallel independent SDD tasks), **artifact dedup** across the chain, **per-session fixed cost** (bootstrap injection, 22+14 skill-description surface), **grilling compression** (AFK pre-recon), **forward seam** (`/goal`/`/loop` single-driver coordination).
- The paused map's **6 remaining fog items**: cacheRead accounting policy, role granularity beyond recon/writer, all-or-nothing envelope mixing, time env knobs (`SUBAGENT_TIME_BUDGET_*`), grace-ceiling ratio for time, batch soft-gate extension to time.

## Further Notes

- **Coverage caveats (from the ticket-01 audit — read before reusing its numbers)**: runs DB holds only the last 200 dispatches (~3.7 h window, 2026-08-16); anything earlier has no measured token data (commit proxies only); attribution is best-effort keyword matching (±fuzz at hermes/power-tool boundaries); `usage.cost` = $0.00 everywhere (dollars unrecoverable — token share is the currency); main-session tokens are invisible to the runs DB, so planning-pipeline cost is under-represented, not over.
- **Handoff**: this spec routes to superpowers `writing-plans` (plan authoring, glue-merge guidance) → `subagent-driven-development` (levers B1–B4, final-review mandate) per the standing pipeline; the batching rule and dispatch-budget items route to wayfind / subagent respectively.
- The paused `2026-08-15-subagent-dynamic-budgets` map holds the revivable fog; its destination (self-calibrating symmetric budgets) is partially absorbed here — headroom and cadence settled, 6 items still fog.
