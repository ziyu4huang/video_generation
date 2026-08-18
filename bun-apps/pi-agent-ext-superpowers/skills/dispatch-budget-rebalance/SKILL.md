---
name: dispatch-budget-rebalance
description: Use when rebalancing subagent dispatch budgets — turns-aborts dominate the ledger, a role ceiling sits below the done-run median, an envelope-less spawn consumer appears, or a direct call site lacks the abort-safety footer. Median-driven bounds and a consumer census, not hand tuning.
---

# Dispatch budget rebalance

From the 200-run dispatch ledger: turns is the top killer (31/200 aborts) vs tokens (23) vs timeout (6). Raise turn ceilings before token ceilings; a ceiling below the done-run median starves typical successful runs (the old recon 60k ceiling vs done-median 71k). `ROLE_AWARE_DISPATCH_BOUNDS` applies ONLY at the subagent tool seam — bounds move from ledger medians, never intuition.

## When to use

- **Turns-aborts dominating** the runs ledger — turns killed more dispatches than tokens (31 vs 23 in the reference census).
- **Ceiling below done-median** — a role envelope's ceiling sits under the median of *successful* runs for that role: starvation by design.
- **Envelope-less spawn consumers** — any consumer calling `spawnSubagent` / `spawnSubagentSubprocess` directly (zk extension dispatches, hermes background sites, obsidian leaf) bypasses the envelope entirely.
- **Footer/recovery asymmetry** — a direct call site carries caps but not the abort-safety footer: a budget death there leaves no as-you-go log and is unrecoverable.

## Procedure

1. **Ledger medians** — run `bun scripts/runs-stats.ts` (pi-agent-ext-subagent; emits status counts + per-status token/turns medians straight from `~/.pi/subagents/runs`) plus `.planning/knowledge/` empirics; prioritize turns > tokens > time. `--trend` shows the snapshot trajectory + gate state; `--snapshot` appends one after every bounds change.
2. **Consumer census** — grep ALL consumers of `spawnSubagent` / `spawnSubagentSubprocess` / the subagent tools; disposition each as:
   - tool-seam — envelope applies, nothing to do;
   - direct-call — envelope-less, fix in step 3;
   - subprocess-seam — wall-clock is the only knob (no token/turn fields exist);
   - workflow-family — `agent()`/`parallel()` children use their own createAgentSession run-level aggregate budget model (budget closure, per-phase sub-budgets, persisted pause/resume): NO-GAP BY DESIGN — do not re-audit unless that runtime loses its budget closure.
3. **roleAwareDirectCall for direct sites** — classify recon vs writer from the effective toolset; spread `roleAwareDefaults(role)` / `roleAwareDirectCall` (exported from `@repo/pi-agent-ext-subagent`) so caps AND the abort-safety footer apply atomically at every direct `spawnSubagent` call site.
4. **Bounds only from medians** — adjust `ROLE_AWARE_DISPATCH_BOUNDS` so ceiling ≥ done-median; turns headroom to the turns-abort median; leave unindicted dimensions unchanged.
5. **Test pins** — update the budget-defaults test table pins AND tool tests pinning footer-gate interactions (`shouldInjectFooter` flips at maxTurns > 10; envelope changes can cross that boundary by design — pin both sides).
6. **Ship + re-verify** — devops local-ci + pr-finish; re-verify affected package suites green at the merged HEAD.

## Pitfalls

- **Explicit params opt the whole envelope out** — ANY explicit tokenBudget / maxTurns / timeout at a call site disables the role envelope for that dispatch; audit call sites for accidental explicit values.
- **Subprocess seam has no token/turn fields** — wall-clock is the only budget knob there; do not hunt for token knobs that do not exist.
- **Re-measure gate** — wait for ≥100 post-merge runs before touching bounds again; the ledger moves the table, not intuition (re-derive from the runs DB, never hand-tune).

## Verification

- Affected package suites green at merged HEAD — record the suite counts in the PR.
- Grep audit: zero uncapped `spawnSubagent(` callers outside the library's own definitions — every direct caller carries roleAware* bounds.
- Post-rebalance ledger snapshot (2026-08-18, ~2h after #1652/#1658 landed): **done 124 (62%) / turns-abort 64 / budget-abort 12 / timedout 0 / failed 0**. Caveats: most turns-aborts in that window were orchestrator-set explicit maxTurns (dispatch prompts pinning 3-8 turns), not rebalanced envelopes; sample depth was shallow (~12 recent runs, 9 done).

## Provenance

> Provenance: 200-run ledger + 2026-08-18 rebalance session (PRs #1652/#1653/#1654/#1655/#1656/#1658/#1660/#1661); candidate `.planning/knowledge/dispatch-budget-rebalance.md`; prior census consumed as dispatch-recovery (PR #1628).
