---
effort: 2026-08-15-subagent-dynamic-budgets
created: 2026-08-15
last: 2026-08-25
status: active
---

# Wayfinder map: 2026-08-15-subagent-dynamic-budgets

## Destination

Subagent budgets become self-calibrating and symmetric across tokens/turns/time — rolling p90 auto-recalibration from `~/.pi/subagents/runs` (tier×role buckets) replaces the frozen 2026-08-09 tier table; new `timeBudget` gains full parity with `tokenBudget` (tier defaults + 80% advisory warning + two-stage wrap-up grace); `timeoutMs` degrades to a backward-compat alias.

## Notes

- Current defaults frozen: `TIERED_TOKEN_BUDGET_DEFAULTS` small=500k/medium=1.2M/big=1.5M (p90 of 200 done runs, calibrated 2026-08-09); `ROLE_AWARE_DISPATCH_BOUNDS` recon 60k/8turns/5min, writer 400k/24/20min, all-or-nothing envelope (any explicit bound opts out whole).
- No elapsed-time budget exists: wall-clock = one-shot `timeoutMs` hard abort only (15min in-process default / 5min subprocess — divergent magic numbers); no warning, no grace, not persisted in `SubagentBudgetDetails`.
- Real usage (200 runs, 2026-08-15): done 140 (median 71k tok/87s), turns-aborts 31 (median 506k/281s), budget-aborts 23 (median 339k/352s), timedout 6 (median 958k/1223s); cost≡0 every run; `turnsUsed` persisted only on turns-aborts; cacheRead billed 1:1 dominates (96-97% of grace overshoot); budget deaths cluster at report-edge (1.21M/1.23M/1.5M ≈ ceilings).
- Philosophy arc documented in `.planning/specs/2026-08-15-subagent-budget-hardening.md` + `.planning/knowledge/subagent-dispatch-budget-protocol.md` (warn-only advisories never abort; protocol: no explicit budget below tier defaults — prose, unenforced).

## Decisions so far

- 2026-08-25 (fog #2 resolved, ticket 02): the time side of the role envelope
  gains the token family's env surface — `SUBAGENT_TIME_BUDGET_{DISABLE,
  RECON, WRITER, MULTIPLIER}` resolved inside `roleAwareDefaults` (per-role
  absolute ms → multiplier, floor ≥1ms; DISABLE strips ONLY the wall, never
  the whole envelope — that stays `SUBAGENT_TOKEN_BUDGET_DISABLE`). Rejected:
  a global `SUBAGENT_TIMEOUT_MS` (third way to set the same wall), suffixed
  units ("300s"/"5m"), per-tier time knobs (no tier time defaults exist).
  Numeric bounds frozen (recon 5min / writer 20min) — policy-only ticket.

- 2026-08-25 (fog #1 resolved, ticket 01): budget accounting is cache-aware —
  the billable metric is input+output (ADR-subagent-0009). Rejected: separate
  cacheBudget (third knob), cache discount factor (arbitrary constant). The
  post-change `status:"budget"` ledger population is NOT comparable to
  pre-change snapshots (regime change noted in budget-history).

- Symmetric three-currency: `timeBudget` gets tier defaults + 80% warning + two-stage wrap-up (grace turn before hard stop); `timeoutMs` stays as alias for compat.
- Dynamic base: rolling p90 auto-calibration from the runs DB (tier×role buckets), written back to the defaults table at startup/periodically; env knobs keep override precedence.
- Persist `turnsUsed` on ALL runs (today only turns-aborts record it) — calibration needs the feedback data.
- `spendBudget` stays never-defaulted (cost≡0 on this stack).

## Not yet specified

- ~~cacheRead accounting policy~~ — RESOLVED 2026-08-25 (ticket
  `tickets/01-cache-aware-budget-accounting.md`, ADR-subagent-0009):
  tokenBudget enforces REAL tokens (input+output), cache excluded; fallback
  to inclusive `total` when a stats surface carries no breakdown. The
  2026-08-25 re-measure (rolling 200, gate ARMED) showed every envelope-recon
  budget death was 73–85% cacheRead with real usage 19k–49k — at/below the
  done-recon real p90 (29.8k): the cache-inclusive total was the false-kill
  mechanism, not consumption. Runaway stays bounded by maxTurns + timeoutMs
  + the grace ceiling (now also on the real metric).
- Role-model granularity beyond binary recon/writer
- All-or-nothing envelope mixing semantics
- ~~Env knob extension to time (`SUBAGENT_TIME_BUDGET_*`)~~ — RESOLVED
  2026-08-25 (ticket `tickets/02-time-budget-env-knobs.md`): the token
  family's knob shape mirrored onto the role wall (DISABLE/RECON/WRITER/
  MULTIPLIER) inside `roleAwareDefaults`; all seams inherit it for free.
- Grace ceiling ratio for time
- Batch soft-gate extension to time

## Out of scope

- spendBudget defaults
- Workflow-tool budget changes
- Rate-limiter/concurrency
- Display-layer work (effort `2026-08-15-subagent-tui-display`)

## Cross-effort links

Shares-decision-with: 2026-08-16-optimize-planning-pipeline-aka-extension — its dispatch-cost destination is absorbed into that effort's spec (which cites this map's 4 closed decisions and settles report-edge headroom + recalibration cadence). Revivable as its own effort; the 6 remaining Not-yet-specified items stay here.
2026-08-18 — ROLE_AWARE_DISPATCH_BOUNDS rebalanced from the 200-run ledger + leanrag-completion session dispatch deaths: recon 60k/8t → 120k/12t (done-median 71k sat above the old ceiling; turns = top killer 31/200), writer 24t → 28t (turns-abort median ≈28); timeouts unchanged (6/200). Shipped in the PR carrying this change.
2026-08-18 — footer-gate interaction resolved: recon 12t intentionally crosses shouldInjectFooter's maxTurns>10 gate (read-only recon now carries the abort-safety footer — empirics: turns-limit deaths are the top killer; as-you-go logs are what make janitor recovery work). Tests pin both sides of the boundary.
2026-08-18 — extraction-leaf alignment: OB_SUBAGENT_TIMEOUT_MS default 5→20 min (obsidian distill/garden children = writer archetype; subprocess seam has no token/turn fields so wall-clock is the leaf's only budget knob; env override + 0=no-gate unchanged). Companion to PR #1652.
2026-08-18 — final gap closed: knowledge-card's in-process zk_card/zk_ask dispatches now carry the role-aware envelope (zkRoleBounds → roleAwareDefaults writer/recon at the zk seam; SUBAGENT_TOKEN_BUDGET_DISABLE stays the global escape hatch), pinned by one bounds test on the seam double. Companion to #1652/#1653.

2026-08-18 (session close-out) — the second half landed and the effort's core question is answered end-to-end: PRs #1655/#1656 (hermes background-review + session-flush/auto-consolidate/correction-detector role caps), #1658 (roleAwareDirectCall — caps + abort-safety footer travel together on every direct spawnSubagent site), #1660/#1661 (watchdog L2 + file2md vision — repo-wide zero uncapped callers, final grep audit clean), #1663 (post-rebalance measurement: 124 done/64 turns/12 budget/0 timedout of 200; re-measure gate ≥100 post-merge runs before touching bounds), #1664 (workflow-family dispositioned no-gap by design), #1665 (candidate promoted to a real skill: bun-apps/pi-agent-ext-superpowers/skills/dispatch-budget-rebalance/SKILL.md). Full evidence chain: .planning/knowledge/dispatch-budget-rebalance.md. Status stays `paused` — the 6 fog items (cacheRead policy, role granularity beyond recon/writer, envelope mixing, SUBAGENT_TIME_BUDGET_* envs, grace ceiling ratio, batch soft-gate) remain parked and unpicked; resume from the skill's procedure, not from scratch.
