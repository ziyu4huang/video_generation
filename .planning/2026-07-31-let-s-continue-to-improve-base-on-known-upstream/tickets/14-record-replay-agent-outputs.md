---
type: grilling
blocked by: []
status: closed
---

# 14 — Decide: record-replay mode (pin agent outputs)

**Source**: 03#7 · axis `ecosystem` · **Impact 4 / Effort 3 / score 12** (rank 10)
⚠ **verify-before-impl** (03 citations unverified)

**Gap**: VCR/nock/Polly.js cassettes, LangSmith playground replay, Temporal
deterministic replay pin external outputs for hermetic test runs. Ours: the
**orchestration** is hermetic/deterministic (`SafeDate`, no `Math.random`/
`require`/`fs`/net in the vm, `workflow.ts:281`) but agent **outputs** are live and
non-deterministic — no mode to record a run's agent outputs and replay them
verbatim. This blocks reproducible eval fixtures (the deferred pack-eval north-star)
and hermetic CI.

**Improvement shape**: `record`/`replay` run flags that pin the journal as the
**output** source for matching `agent()` call-indexes during re-execution.

## Question

**do / defer / skip?** **Prerequisite**: verify VCR/nock/LangSmith replay shapes
via live search. If **do**: lock the match key (recommend: call-index +
`sha256(prompt+model+tier+schema)` so a changed prompt invalidates the cassette),
and decide cassette storage location (recommend `~/.pi/workflows/.../cassettes/`).
Pairs with the deferred journal-divergence detector — revisit that if this → do.

> Closed 2026-08-16: fog — verify-before-impl citations need live web search (web-search key absent). Re-open when search available and citations re-verified; design leans preserved above.
