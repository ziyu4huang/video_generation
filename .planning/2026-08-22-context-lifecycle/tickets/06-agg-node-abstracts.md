# 06 — agg-node abstracts: L1 summaries on LeanRAG aggregation nodes

- **Phase:** P1 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** open

## Problem

LeanRAG `agg-L*` MOC nodes are derived link-lists without a one-glance summary; the L1 tier
(D5) needs them to be readable without descending. The DI'd `summarizeFn` seam (leanrag D4)
already exists in `src/hierarchy-build.ts`.

## Approach

1. `hierarchy-build.ts`: stamp `summary:` on aggregation nodes via the existing injected
   `summarizeFn` (budget-gated per leanrag D6 — LLM only when raw relation text exceeds the
   layer budget); deterministic fallback = top-entity sentence composition (no LLM).
2. Bump the checkpoint format version so in-flight checkpoints resume correctly rather than
   half-match.
3. `aggregation-write.ts`: render `summary` into the derived card frontmatter; T2 guard
   (never overwrite user-authored files) unchanged.
4. Hierarchy goldens updated deliberately (pinned surface — cite D0 + leanrag D2/D6 in the
   regen commit).

## Acceptance

- `hierarchy*` + `aggregation-write` tests green with updated goldens; new test: budget gate
  (summarizeFn called only over budget), deterministic fallback path.
- Real-vault rebuild: every `agg-L*` node carries a non-empty `summary` or a recorded
  breaker reason; `zk-query --health` clean.

## Verification

Canonical kcard gates; `PI_HIERARCHY_DISABLED=0` rebuild run over the real vault with
receipt (node count, summarized count, LLM-call count).
