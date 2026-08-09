# 01 — Capture moment + source layer

---
type: grilling
blocked by:   # root ticket
claimed: wayfinder-session
status: closed
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

- [x] Trigger moment(s) chosen, with rationale for rejecting the others.
- [x] Source layer chosen (L1-raw / L2-converged / both), with rationale.
- [x] The decision notes what it implies for the candidate's `evidence` field + the template's active-window (ticket 03 depends on this).

## Resolution

**Moment: main-session, agent-judged** — two fire conditions:
1. **On-save** — when the main agent writes a memory (via the `memory` tool) that meets the skill-worthy criteria, it captures a candidate in the same turn.
2. **On-recurrence** — when `memory_search` surfaces a recurring pattern (the same lesson ≥2×), the agent captures a candidate.

Background-review saves (the bulk of learning) are picked up via recurrence-search with acceptable lag — **no review-child coupling in v1**. The review child runs under its own `COMBINED_REVIEW_PROMPT` (fact-confirmed: `src/handlers/background-review.ts` dispatches via `spawnSubagent`), so it does not see the main session's injected template; pushing the skill-worthy criteria into it is a complete-but-coupled enhancement, deferred.

*Rejected moments:* periodic-review-pass (heavy, new infra); review-child capture (complete coverage but couples T03 to the review pipeline); pure undirected vigilance (too vague for a template trigger predicate — per writing-skills' SDO lesson, the trigger must be conditional on an observable).

**Source: L1-raw** — the candidate's `evidence` field = the L1 hermes memory id (just-written or search-hit). L2 converged graph-cards are an **auxiliary seed path only** (a skill-worthy card deliberately copied into `.planning/knowledge/`, the T02 path), NOT a live trigger. Keeps the bridge single-path; L2 stays the convergence sink; no trigger coupling to the graph.

**Implications for downstream tickets:**
- **T03 (template)** — the trigger predicate = "on your own memory write OR on memory_search recurrence"; active-window = the main session (NOT the review child). The recognition criteria (reusable + procedural + not-already-a-skill + not-noise) filter noise at judgment time.
- **T04 (dedup gate)** — recurrence already implies "seen as a memory," so the gate's job narrows to "already-a-SKILL / already-a-candidate," not "seen as a memory."
- Candidate `evidence` field = L1 memory id.

*(Resolves ticket 01; unblocks ticket 03 — frontier becomes {03, 05}.)*
