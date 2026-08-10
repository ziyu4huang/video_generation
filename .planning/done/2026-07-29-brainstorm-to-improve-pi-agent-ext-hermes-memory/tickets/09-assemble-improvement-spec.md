# 09 — Assemble the prioritized Pi-native improvement spec

type: task
blocked by: 05 — Remnic eval/bench harness: adopt a retrieval-quality eval?, 06 — Verdict + port-design: retrieval improvements, 07 — Verdict + port-design: belief/supersession (Relay-style corrections), 08 — Verdict + port-design: extraction/distillation loop

## Question

Assemble the **destination artifact**: the prioritized Pi-native improvement
spec for `pi-agent-ext-hermes-memory`, ready for a Superpowers **writing-plans**
session to consume. This is the spec the whole map is finding its way to —
closing it closes the map.

Pull together:

1. **Ranked improvement list** from the verdicts (06 retrieval, 07
   belief/supersession, 08 extraction loop), ranked by the criteria in (01),
   each with its Pi-native port-design sketch.
2. **Evidence/eval note** from (05) — whether/how to measure each improvement,
   and the minimal eval shape if adopted.
3. **Explicit out-of-scope justifications** — cross-agent store, markdown-only
   store, capture, connectors/importers (from the map's Out of scope).
4. **Deferred fog** as named follow-ups — embedding source, vector/graph
   substrate, reranker feasibility, token-cost ceiling (from the map's Not yet
   specified), marked for a future effort once the first improvements land.
5. **One-line handoff framing** — what writing-plans should turn into plans
   first (the single highest-ranked IN item).

Sizing: this is a *synthesis* of already-resolved tickets, not new research —
it should fit one session. Output as `spec.md` under this effort dir (or per the
repo's planning convention) and link it from the map's Decisions-so-far.

## Resolution

_Closed (task) — 2026-07-29. **Spec written: [`../spec.md`](../spec.md).** Synthesized [01](01-ranking-criteria.md) (ranking) + [05](05-research-eval-harness.md) (eval) + [06](06-verdict-retrieval.md)/[07](07-verdict-belief-supersession.md)/[08](08-verdict-extraction-loop.md) (verdicts) into a phased, plan-ready spec: **Tier 1** (memory-worth + provenance `sources[]` + belief/supersession) → **Tier 2** (typed distillation + extraction-judge + LLM reranker + boost + event-trigger + scope tagging) → **Tier 3** (opt-in ≤500t hint); eval adopted; out-of-scope justified; phase-2 fog (vector/graph/model-pick) named. Reconciled with the current `config.ts` (post-rebase) and the parallel effort `2026-07-29-persistent-to-planning` (T01–T03 closed; **T04/T05 open = write-path dependency** for Tier 2 + phase-2 substrates). **Closing 09 closes the map.** Handoff: **writing-plans** plans Tier 1 first (memory-worth scoring + provenance `sources[]` in the same first plan — highest-ranked and foundational); gate graph/vector on the eval-measured retrieval gap._
