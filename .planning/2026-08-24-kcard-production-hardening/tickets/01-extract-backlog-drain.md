---
type: task
status: complete
---

# 01 — Extract backlog drain: chunked success path at real batch scale

## Question

Can the D28 single-LLM-call extraction loop succeed on the real ~101-entry journal — and stay inside budget for every future batch — via bounded input chunking with per-chunk cursor advance?

## What to build

An on-demand `zk_ingest` extract run that drains the real backlog to completion: the loop splits fresh survivors into measured-size chunks, one LLM call per chunk, cursor advancing per successfully-processed chunk (a mid-batch failure keeps prior chunks' progress). Shutdown-triggered runs process at most one chunk's worth of budget so the #1976 backoff guarantees stay intact. First-pass token budget sized so a reasoning model's parse succeeds without the guaranteed-truncation 2048 first attempt (or the budget ladder is re-measured and re-justified).

## Acceptance

- [x] Real-vault backlog drained: receipts show the 101-candidate batch processed to `seenAfter` covering it, `llmFailed: false`, curated cards/supersedes written — measured 2026-08-24: PRE seenIds 0 / cf 2 / 0 cards → POST seenIds 101 / cf 0 / 7 runs; receipt chain `run-extract-20260824211225…212956` (final full run 68→101, 5/5 chunks clean, 31 writes; +52 writes cumulative this drain; idempotent no-op confirmation run after)
- [x] Deterministic chunking suite green: per-chunk cursor advance, partial failure mid-batch keeps prior chunks, backoff interplay (2 shutdown failures still arm; on-demand never skips) — `__tests__/extract-loop.test.ts` §7 (5 tests); full package 607 pass / 0 fail, `tsc --noEmit` clean
- [x] Shutdown budget proof: a shutdown-triggered run's wall time stays within the existing bounded timeout regardless of backlog size — `trigger:"shutdown"` pins `chunksPlanned=1` (test: 40-entry backlog → exactly 1 call, progressive drain across runs); live one-shot wall 6.2–6.7s post-drain
- [x] D14: A/B receipt (pre/post extraction state on the real vault) + independent reviewer pass — receipts above; review APPROVE (inline, reviewer subagent unresponsive; findings: per-chunk ingest→supersede→cursor ordering is crash-safe via canonical-id idempotency, killedPending rides only the first successful chunk, backoff bookkeeping matches receipts)
