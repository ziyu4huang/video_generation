---
type: grilling
blocked by: []
status: closed
---

# 13 — Decide: rate-limit-aware (RPM/TPM token-bucket) concurrency scheduler

**Source**: 03#4 · axis `ecosystem` · **Impact 4 / Effort 3 / score 12** (rank 9)
⚠ **verify-before-impl** (03 citations unverified)

**Gap**: LiteLLM router applies per-model RPM/TPM budgets; provider SDKs surface
`retry-after` / `x-ratelimit-remaining-*` headers; LangGraph/CrewAI route through
rate-aware queues. Ours: concurrency = `hwConcurrency-2` naive count
(`workflow.ts:325`); 429 is caught and retried **once** (`retryOnTransient`) but
the scheduler **doesn't read rate headers / apply a per-model token bucket** → heavy
fan-out to a rate-limited provider just 429s repeatedly.

**Improvement shape**: a per-(provider,model) token-bucket limiter injected into the
parallel runner that backs off on `retry-after` / `x-ratelimit-remaining-tokens`.

## Question

**do / defer / skip?** **Prerequisite**: verify LiteLLM/langgraph rate-limit
patterns via live search. Note this **pairs naturally** with the deferred run-wide
`$` cap + global concurrency governor — decide whether to scope this ticket to just
the token-bucket, or fold all three into one "concurrency & cost control" effort
(recommend: token-bucket here; ledger + global governor as a follow-on effort).

> Closed 2026-08-16: fog — verify-before-impl citations need live web search (web-search key absent). Re-open when search available and citations re-verified; design leans preserved above.
