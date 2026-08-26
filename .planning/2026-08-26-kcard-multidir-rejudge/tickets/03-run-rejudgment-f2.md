# 03 — Run the re-judgment (recursive vs flat vs generic ×2) + F2 knob adjudication

Status: open · Blocks: 04 · Blocked by: 02

## What

The D9 re-judgment on the multi-dir corpus: same 4-arm discipline as
2026-08-25 (recursive / flat-resource / generic-card baseline ×2 identical
runs, bge-m3 @ LM Studio, throwaway ns), plus the F2 per-knob verdicts
(`DIRECTORY_DOMINANCE_RATIO`, `GLOBAL_SEARCH_TOPK`, `RetrieverMode`) per map
D3. The t03 α-re-identification (0.3/0.5/0.7 sweep) and the L0/L1-vs-L2-only
ablation ride along — both were "re-open only with the multi-dir corpus".

## How

1. Confirm LM Studio bge-m3 up (canonical embedding, per CLAUDE.md).
2. Run resource-eval ×2 runs on the family corpus; save both receipts under
   `output/resource-eval/` (scratch) with numbers recorded here.
3. Split metrics: directory-discriminating vs within-doc questions (the
   battery's classes) — the recursive lane's advantage, if any, lives in the
   first split.
4. F2: for each knob, PORT (trivial env-gated sweep moved the metric) /
   KEEP-UNPORTED (no effect on this corpus, or effect not worth the surface).
   Implementation only if trivial; the verdict is the deliverable.
5. Independent reviewer subagent on the receipts before the verdict is
   recorded (watchdog OFF per CLAUDE.md dispatch rules).

## Done when

- [ ] Both runs' receipts exist; determinism check across runs recorded
- [ ] Per-class metrics table (dir-discriminating vs within-doc) in this
      ticket for all arms
- [ ] F2 verdict per knob with evidence line
- [ ] α sweep + L0/L1 ablation numbers recorded (ride-along fog items)
- [ ] Reviewer pass receipt; map `last` touched
