---
type: task
status: open
---

# 01 — Extract backlog drain: chunked success path at real batch scale

## Question

Can the D28 single-LLM-call extraction loop succeed on the real ~101-entry journal — and stay inside budget for every future batch — via bounded input chunking with per-chunk cursor advance?

## What to build

An on-demand `zk_ingest` extract run that drains the real backlog to completion: the loop splits fresh survivors into measured-size chunks, one LLM call per chunk, cursor advancing per successfully-processed chunk (a mid-batch failure keeps prior chunks' progress). Shutdown-triggered runs process at most one chunk's worth of budget so the #1976 backoff guarantees stay intact. First-pass token budget sized so a reasoning model's parse succeeds without the guaranteed-truncation 2048 first attempt (or the budget ladder is re-measured and re-justified).

## Acceptance

- [ ] Real-vault backlog drained: receipts show the 101-candidate batch processed to `seenAfter` covering it, `llmFailed: false`, curated cards/supersedes written
- [ ] Deterministic chunking suite green: per-chunk cursor advance, partial failure mid-batch keeps prior chunks, backoff interplay (2 shutdown failures still arm; on-demand never skips)
- [ ] Shutdown budget proof: a shutdown-triggered run's wall time stays within the existing bounded timeout regardless of backlog size
- [ ] D14: A/B receipt (pre/post extraction state on the real vault) + independent reviewer pass
