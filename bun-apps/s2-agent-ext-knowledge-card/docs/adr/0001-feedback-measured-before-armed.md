**ID:** `ADR-knowledge-card-0001` — ADR numbers restart per context, so this number alone is ambiguous; cite this ID.

# 0001 — The retrieval feedback loop is measured-before-armed: used ≠ served, and every lever defaults OFF

**Status:** accepted
**Date:** 2026-08-30
**Plan:** `.planning/2026-08-22-context-lifecycle/` (tickets 08–12, 16; D11/D12/D13)

## Context

The context-lifecycle effort ported OpenViking's memory-lifecycle feedback machinery:
an auto-recall injector (per-turn budgeted card injection), a `RecallLedger` cross-turn
cooldown, a used-detection ledger (`<vault>/.knowledge-usage.jsonl`), and a hotness
multiplier (`m(h) = 1 + 0.1·h`) replayed from that ledger. Every piece shipped green —
and every piece shipped **OFF by default**, because each measurement said the same
thing: the mechanism works, but the cost/precision evidence does not yet earn arming it.

- Injection (t10 probe, D11): cache-transition 1.156× warm > 1.05× target; injection
  rate 2/20 at floor=2 (near-perfect retrievals already score `sharedTags=1`, so the
  floor kills exactly the retrievals that need it least); cold-start silent no-op.
- End-task payoff (t16): Δ+40pct armed-vs-unarmed **under floor=0** — the payoff is
  real, but floor=0 precision on off-topic prompts is unmeasured, and the
  converge×semantic-cache interaction (53 s re-embed bursts) is an unfixed blocker.
- Hotness (t12, D13): the seeded battery proves the mechanism (targets-ON 15/17 vs
  baseline 11/16), but a seeded run is circular by construction and the production
  used-ledger is EMPTY — an unseeded on/off battery has nothing to feed on yet.

Alongside: two "usage" stores exist and must not be conflated. The t08 SurrealDB
`usage` table records SERVED-side access; the t11 jsonl used-ledger records USED
cards (three provenance sources, cross-source monotonicity). The RecallLedger records
only post-budget KEPT cards — retrieved ≠ served ≠ used. OpenViking's poisoning bug
(recording `no_relevant` lookups as usage) is exactly what this triple distinction
exists to prevent.

## Decision

1. **Default OFF is the shipped posture for both levers** (auto-recall injection and
   the hotness multiplier), and flipping either requires a recorded unseeded
   measurement first — never a circular seeded run. Triggers: injection flips only
   after the converge×cache fix + floor=0 precision probe + D11 cache re-probe (D12);
   hotness re-evals when the production used-ledger is populated (D13), via
   `scripts/retrieval-eval.mjs --hotness on|off`.
2. **The used/served/accessed distinction is load-bearing vocabulary**, not
   duplication: served = post-budget kept (RecallLedger), used = demonstrably
   consumed (jsonl ledger), accessed = raw zk_card reads (Surreal table). New
   feedback code must name which one it writes.

## Consequences

- The loop's value is deferred by design until production data exists; the harnesses
  (retrieval-eval, recall-audit, injection-endtask) are the standing re-arm path.
- Storage choices are sticky: the vault-side jsonl needs vault-PR gitignore entries
  (t11/t14 fold-back SOP), and the Surreal table rides the served lane — reversing
  either means a data migration, which is why the distinction is decided here.
