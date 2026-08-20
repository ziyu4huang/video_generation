---
id: "gui-selfimprove:review-finds-skewed-low-severity"
created: 2026-06-14
tags: [zettel, metric, review, severity, distribution, fix-targeting, low-volume, medium-dominant, critical, w4-post-filter, full-scope, info-bucket, empty-byseverity, high-survivor, double-high-same-root, volume-mix-tracks-raw, code-quality-dominant, no-adversarial]
sources: ["workflow-knowledge-jsonl:gui-movie-director-review-optimize"]
source: "workflow-knowledge-jsonl:gui-movie-director-review-optimize"
source_id: "gui-selfimprove:review-finds-skewed-low-severity"
record_type: metric
status: active
superseded_by: 
confidence: 0.89
dimension: review
---
# Verified review findings severity is run-dependent; medium dominates incremental high-volume runs, low+code-quality dominates full-scope scans, critical is volume-orthogonal, a tiny scan's survivors can be ALL HIGH, and a high-volume run's verified mix tracks the raw mix

## 核心想法
Severity distribution varies per run. 2026-06-18T13:32: high=5, medium=12, low=4. 2026-06-18T15:22: high=6, medium=13, low=2. 2026-06-19T18:35: high=2, medium=3, low=4 (lowest total=9, low-dominant). 2026-06-19T21:01: high=3, medium=15, low=4 (total=22, MEDIUM-dominant). 2026-06-19T21:56: critical=1, high=4, medium=8, low=6 (total=19). 2026-06-19T22:46: critical=1, high=1, medium=4, low=4 (total=10, low TIES medium). 2026-06-20T03:22: medium=1 (total VERIFIED=1). 2026-06-20T04:11 (effort:medium FULL scope): high=2, medium=6, low=16, info=2 (total VERIFIED=26) — first run with an `info` bucket, LOW dominates because full-scope surfaces many low-severity style/quality nits. 2026-06-20T06:07: VERIFIED=0. 2026-06-20T11:19: VERIFIED=0 (bySeverity map EMPTY). 2026-06-20T13:08: review lane NOT requested. 2026-06-20T19:03: VERIFIED=2, bySeverity={low:2}. 2026-06-20T19:44: VERIFIED=1, bySeverity={medium:1}. 2026-06-20T23:11: VERIFIED=1, bySeverity={high:1}. 2026-06-21T02:18 (effort:low, FULL-scope 156 files): VERIFIED=2, bySeverity={high:2} — FIRST run where ALL survivors were HIGH (caption reader/writer asymmetry, lib/knowledge-extractor.ts). 2026-06-21T03:52 (effort:low+fix:true, FULL-scope clean tree): VERIFIED=33, bySeverity={high:2, medium=12, low=19} (newFindings=48, ~0.31 rejection) — largest verified count, verified mix tracks raw mix (low-dominant at volume). 2026-06-23T22:34 (effort:medium, FULL-scope 36 files/6262 lines, NO adversarial run): VERIFIED=23, bySeverity={medium:9, low:13, info:1}, byDimension={code-quality:13, correctness:5, security:3, error-handling:1, type-safety:1} — code-quality nits dominate (13/24) exactly as the full-scope low-dominant pattern predicts; correctness=5 and security=3 are the actionable minority. Pattern sharpens: medium is the modal bucket on incremental high-volume runs (>=12); on a FULL-scope run LOW+code-quality dominates (style nits); high stays in a narrow 1-6 band on volume runs but can be the SOLE or ENTIRE survivor set of a small-scope scan (23:11 single-high, 02:18 double-high-same-root-cause); critical is rare (2 in 20+ runs) but highest-priority when it appears; a rejection_rate=1.0 run always yields an EMPTY bySeverity map.

## 證據 / 脈絡
- type: metric
- confidence: 0.89
- status: active
- occurrences: 20
- first_seen: 2026-06-14T22-47:40
- last_seen: 2026-06-23T22-34-02
- extracted_at: 2026-06-23T22-34-02
- provenance: workflow-knowledge-jsonl:gui-movie-director-review-optimize

## 連結
- 相關：[[gui-selfimprove-review-volume-jumps-on-wider-scope]]
- 相關：[[gui-selfimprove-openissues-174-spike-three-lane]]
- 相關：[[gui-selfimprove-latest-run-is-baseline-clean]]
- 相關：[[gui-selfimprove-openissues-converges-to-zero]]
- 相關：[[gui-selfimprove-gotcha-medium-fix-zero-when-no-adversarial]]
- 相關：[[gui-selfimprove-gotcha-verified-neq-newfindings]]
- 相關：[[gui-selfimprove-openissues-21-spike-post-clean]]
- 相關：[[gui-selfimprove-review-only-does-not-clear-openissues]]
