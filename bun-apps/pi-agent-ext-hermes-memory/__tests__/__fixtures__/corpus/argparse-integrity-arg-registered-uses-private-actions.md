---
id: "argparse-integrity:arg-registered-uses-private-actions"
created: 2026-06-21
tags: [zettel, gotcha, argparse, private-attribute, fragile, dedup-helper, shared-parser, run.py-cli, load-bearing, argparse-integrity]
sources: ["workflow-knowledge-jsonl:gui-movie-director-review-optimize"]
source: "workflow-knowledge-jsonl:gui-movie-director-review-optimize"
source_id: "argparse-integrity:arg-registered-uses-private-actions"
record_type: gotcha
status: active
superseded_by: 
confidence: 0.85
dimension: argparse-integrity
---
# _arg_registered() helper inspects parser._actions — a CPython-private attribute that can break across argparse versions

## 核心想法
app/commands/_shared.py: the _arg_registered() / _option_registered() dedup-helpers iterate parser._actions to detect already-registered flags. parser._actions is a private attribute (leading underscore); CPython/argparse give no stability guarantee across versions, so the dedup logic that the entire unified-parser order-coupling pattern depends on is itself built on a fragile foundation. The load-bearing wall under the whole shared-flag skip architecture. Fix shape: prefer a parse_known_args probe or track registered dests in an explicit set rather than reaching into _actions.

## 證據 / 脈絡
- type: gotcha
- confidence: 0.85
- status: active
- occurrences: 5
- first_seen: 2026-06-21T02-22-56
- last_seen: 2026-06-22T13-51-05
- extracted_at: 2026-06-22T13-51-05
- provenance: workflow-knowledge-jsonl:gui-movie-director-review-optimize

## 連結
- 相關：[[argparse-integrity-order-coupled-shared-skip]]
- 相關：[[argparse-integrity-unguarded-default-none-overrides-shared]]
- 相關：[[gotcha-argparse-private-actions-attribute-fragile]]
- 相關：[[mlx-review-review-output-dest-conflict]]
- 相關：[[mlx-review-shared-flag-concrete-default-wins-cross-subaction]]
- 相關：[[mlx-review-dead-restore-registration-image]]
- 相關：[[correctness-help-text-default-mismatch]]
- 相關：[[gotcha-argparse-alias-required-dest-collision]]
