**ID:** `ADR-subagent-0005` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID. Index: `bun-apps/docs/adr/INDEX.md`

# 0005 — Dispatch budget architecture — tier ceilings, role envelopes, and direct-call parity

**Status:** accepted
**Date:** 2026-08-18
**Supersedes nothing. Amends the budget defaults shipped with the subagent extraction (ADR-subagent-0001), which bounded only the tool seam.**

## Context

A 200-run dispatch ledger showed a 17% child death rate, with turns the top
killer (31 runs) ahead of token exhaustion (23) and wall-clock timeout (6). The
starkest number: the done-run median sat at 71k tokens — **above** the old 60k
recon ceiling. Successful runs were starving by design; the ceiling was
calibrated to a cheaper past, not to what recon children actually cost today.

Two structural gaps made the ceilings worse than a mere miscalibration:

1. **Role bounds lived only at the subagent tool seam.** Any consumer calling
   `spawnSubagent` directly — zk, hermes, watchdog, file2md — ran completely
   envelope-less: no token budget, no turn cap, no timeout. The same dispatch,
   two protection regimes, depending on which entrypoint you happened to use.

2. **The abort-safety footer also lived only in the tool layer.** A capped child
   that hit its budget died with nothing written to its run log — the parent
   learned the child was dead but not what it had found. Empirics from the
   ledger: last words are not evidence. A budget death without as-you-go logs is
   unrecoverable; the work is simply gone.

## Decision

1. **Two-layer defaults.** Tier-calibrated token ceilings stay as the outer
   layer. On top of them, `ROLE_AWARE_DISPATCH_BOUNDS` (recon: 120k tokens /
   12 turns / 5 min; writer: 400k / 28 turns / 20 min) is applied **only when
   all three budget params are omitted**. Any explicit bound — any one of the
   three — opts the whole envelope out. Partial mixing is never allowed; an
   explicit value must mean the caller owns the envelope.

2. **Direct-call parity.** Direct `spawnSubagent` callers dispatch through the
   exported `roleAwareDirectCall(role, task, logId)`, which applies the caps
   **and** the abort-safety footer atomically at call time — the footer no
   longer depends on passing through the tool seam. `SUBAGENT_TOKEN_BUDGET_DISABLE`
   strips both, keeping one escape hatch for the whole architecture.

3. **Subprocess-seam leaves (obsidian distill/garden) carry wall-clock only.**
   The subprocess seam has no token or turn fields to bind, so those leaves get
   the timeout alone, aligned to the writer envelope (20 min).

4. **The workflow family is deliberately exempt.** `agent()`/`parallel()`
   children keep their own run-level aggregate budget model (budget closure +
   `throwIfAborted` + persisted resume). They are parallel by design; role
   envelopes don't apply.

5. **Bounds move only from runs-DB medians** (`bun scripts/runs-stats.ts`),
   never intuition, and only past a **≥100-post-merge-run re-measure gate** —
   enough new runs must accumulate after a merge before the numbers may be
   touched again.

## Alternatives considered

- **Per-caller hand-tuned budgets at each call site.** Rejected: drifts
  immediately, no single source of truth, and every new consumer re-learns the
  ledger's lessons from scratch.
- **A global fixed budget for every child.** Rejected: recon and writer
  archetypes differ ~3x in practice (71k vs ~200k+ medians); one number either
  starves writers or bankrupts the recon fleet.
- **Letting the footer stay tool-only.** Rejected: makes every budget death
  unrecoverable by construction — the exact failure mode the ledger documented.

## Consequences

- Children expected to exceed 12 turns cross the footer gate by design — that
  is the point: a turn-capped child must leave its findings on disk as it goes.
- Test pins include footer-boundary cases (cap applied / explicit-override /
  disable-env) so the opt-out semantics can't silently regress.
- The consumer census (tool-seam / direct / subprocess / workflow) must be
  re-run whenever a new spawn consumer appears; the grep audit is documented in
  the dispatch-recovery skill (Calibration section).

## Cross-references

- [ADR-subagent-0001](./0001-why-extracted.md) — the subagent extraction whose
  tool-seam-only bounds this ADR generalizes.
- The `dispatch-recovery` skill's Calibration section
  (`pi-agent-ext-superpowers/skills/dispatch-recovery/`, merged in from the
  former `dispatch-budget-rebalance` skill in #1699) — the re-measure
  procedure and grep audit this decision is operated through.
- `.planning/knowledge/dispatch-budget-rebalance.md` — the ledger analysis.
- PRs #1652, #1653, #1654, #1655, #1656, #1658, #1660, #1661, #1668 — the
  2026-08-18 rebalance series that landed this architecture.
