# Acceptance — knowledge-pipeline-polish (2026-08-17)

## Structure targets (spec 05)
1. Net non-test file count: **−4** (deleted loop.ts / merge.ts / kcard-loop cmd / embedder.ts / frontmatter-codec.ts; added embedding-leaf.ts) — target ≥ −3 **MET**.
2. Dead exports: sweep grep **0** (only the workflow negative-assertion guard remains, by design) — **MET**.
3. Docs drift: census-01 highs+meds fixed (hermes KNOWLEDGE-LAYER rewritten to seam reality; surreal DEFAULT stated; subagent ghost cleared; tools row corrected); test:adr 19/0 — **MET**.
4. Mirrors-must-hoist rule recorded (zk CONTEXT + hermes KNOWLEDGE-LAYER) — **MET**.

## Tickets
L1 ff4c442f (−1,716 LOC) · L2 ec3e8fe2 + 903c9007 + 69c73a70 · L3 678c7d06 · L4 d97e5ac8 · L5 this.

## Gates
core-interface 37/0 · zk 462/0 tsc clean · hermes 1620/0 tsc clean · test:adr 19/0 · pinned surfaces untouched (hermes 6-tool ≤2100 tok; zk 4 tools; hierarchy goldens green inside the zk suite).

## Behavior
Zero behavior change: deletions were CLI-tier-only + leaf hoists behind identical contracts; all suites green without golden changes.
