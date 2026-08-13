---
type: build
blocked by: 03, 19
---

## Context

Deferred slice of LeanRAG concept ③ (redundancy-aware retrieval): the
**multi-signal frequency-vote**. Split from ticket 19 (see its Re-scope note)
because the vote needs ≥2 recall signals feeding `searchSemantic`, and today
only HNSW is wired (FTS is cold-fallback-only/memory-only; entity-tag recall
does not exist).

## What to build (when unblocked)

- **A knowledge-lexical recall seam** (e.g. `kp.retrieveRecords({semantic:false,
  bodyMatch:true})` or a local FTS) running ALONGSIDE HNSW on the warm path, so
  knowledge search has ≥2 signals to vote across.
- **Entity-tag recall** (from ticket 03's typed entities) as a third signal.
- **Frequency-vote across signals** inside `searchSemantic`: count how many
  independent signals reference each card id; re-rank by descending signal-count
  then per-signal score (the union formula).
- **`boostWeight` config knob** (deferred from ticket 19): the multi-signal
  boost weight, registered per lesson #06.

## Acceptance

- A card referenced by ≥2 independent signals ranks above one referenced by 1,
  holding per-signal score roughly equal.
- `boostWeight` is a registered config knob.

## Out of scope

- Near-dup cosine collapse → ticket 17.
- LeanRAG ①② aggregation/LCA → fog/future.

## Blocked by

- **03** (entity recall) and **19** (the dedup seam this vote layers onto).
