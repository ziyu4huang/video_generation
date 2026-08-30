# 06 — agg-node abstracts: L1 summaries on LeanRAG aggregation nodes

- **Phase:** P1 · **Package:** `s2-agent-ext-knowledge-card` · **Status:** closed 2026-08-23 (agg `summary:` L1 + top-entity composition + checkpoint v2 + filename child links; first real build 326 nodes / 10 LLM calls; recall-audit unchanged 17/20; vault PR ziyu4huang/pi-agent-vault#21)

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

## Resolution

Closed 2026-08-23 (vault PR ziyu4huang/pi-agent-vault#21): agg `summary:` L1 +
deterministic top-entity composition + checkpoint v2 + filename child links; first real
build 326 agg nodes / 4 layers / 10 LLM calls over 1921 cards; recall-audit unchanged
(17/20, MRR 0.688), graphHealth deadLinks 34 == baseline.
