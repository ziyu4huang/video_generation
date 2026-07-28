# 01 — Capture moment + source layer

---
type: grilling
blocked by:   # root ticket
status: open
---

## Question

The prompt-injected template tells the agent a lesson is skill-worthy — but **at what moment** does the capture fire, and **from which layer** does it draw? Two coupled decisions:

1. **Trigger moment(s)** — one or more of: (a) on each memory save (correction detection / background-review save); (b) when `memory_search` surfaces a *recurring* pattern (the same lesson ≥2 times); (c) on-demand (agent notices mid-task); (d) a dedicated periodic review pass for skill-candidates.
2. **Source layer** — L1 hermes raw (the freshly-saved memory, pre-convergence) vs L2 converged knowledge-graph card (post-distill). The distill pipeline already flows L1→L2; does the bridge draw upstream (fresh) or downstream (converged)?

## What to build

A grilled decision on the moment(s) + source, each with a recommended answer. The choice cascades: it determines when the template's guidance is "active" and what the candidate's `evidence` field points at (a raw memory id vs a graph card id). Candidate moments to grill, with trade-offs:

- **on-save (correction / background-review)**: freshest, but most lessons are NOT skill-worthy (noise risk → needs ticket 04's dedup gate).
- **on recurring-pattern (`memory_search` ≥2 hits)**: higher signal (recurrence ⇒ reusability), but requires a recurrence check at capture time.
- **on-demand**: lowest noise, but depends on the agent noticing (the template's job).

## Acceptance

- [ ] Trigger moment(s) chosen, with rationale for rejecting the others.
- [ ] Source layer chosen (L1-raw / L2-converged / both), with rationale.
- [ ] The decision notes what it implies for the candidate's `evidence` field + the template's active-window (ticket 03 depends on this).
