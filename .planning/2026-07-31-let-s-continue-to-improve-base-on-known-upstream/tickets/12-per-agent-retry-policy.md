---
type: grilling
blocked by: []
status: closed
---

# 12 — Decide: per-agent retry policy (backoff + non-retryable)

**Source**: 03#3 · axis `ecosystem` · **Impact 4 / Effort 3 / score 12** (rank 8)
⚠ **verify-before-impl** (03 citations unverified — re-run queries at spec time)

**Gap**: peers expose per-call retry with backoff + non-retryable classification —
Temporal `RetryOptions{maximumAttempts,backoffCoefficient,maximumInterval,
nonRetryableErrorTypes}`; Airflow `retries`/`retry_delay`/
`retry_exponential_backoff`; LangGraph per-node retry. Ours: flat global
`agentRetries` count + `retryOnTransient` = **one** retry on the `subagent` tool;
transient detection classifies 429/timeout/network (`errors.ts:95`) but there's **no
exponential backoff/jitter, no per-call config, no non-retryable allowlist**.

**Improvement shape**:
`agent(prompt, { retry: { attempts, backoff: 'exp'|'fixed', maxMs, jitter, nonRetryable: [...] } })`,
honoring provider `retry-after` on 429.

## Question

**do / defer / skip?** **Prerequisite**: verify the Temporal/Airflow/LangGraph
retry surfaces via live search before locking the spec. If **do**: decide whether
per-call config supersedes the global `agentRetries` (recommend: keep global as
default, per-call overrides) and the backoff default (recommend exp, base 2, cap
30s).

> Closed 2026-08-16: fog — verify-before-impl citations need live web search (web-search key absent). Re-open when search available and citations re-verified; design leans preserved above.
