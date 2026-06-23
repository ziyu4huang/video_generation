# Dynamic-Workflow Knowledge — MANIFEST

> Records the iteration history of the per-workflow knowledge system and the current
> coverage state. The matrix below is **generated** (do not edit by hand — run
> `node scripts/workflow-knowledge-manifest.mjs`); the iteration history above it is a
> **manual changelog** — append an entry each iteration.
>
> Three knowledge layers (do not conflate):
> - `history/<wf>/*.json` + `reflection.json` — gitignored, pruned, **ephemeral** raw runs.
> - `<wf>.knowledge.jsonl` (colocated, committed) — **distilled**, per-workflow, loaded at
>   Resolve (`loadKnowledge`) and rewritten at Persist (`extractKnowledge`).
> - `knowledge-base/code/records.jsonl` — committed, shared coarse bucket, Bun-only.
>
> See `.claude/workflows/_shared-patterns.md` ("Workflow Knowledge") for the contract.

## Iteration history

### Iteration 1 — 2026-06-18 (commit b865235)
Per-workflow colocated knowledge JSONL. Ported 8 workflows (load+extract), seeded 5
from real history (109 records); refactored `ltx` `Knowledge` phase off the broken
`~/.claude-glm` memory-file write path. Added the checker's hard rule (consumed
`extract-knowledge`/`load-knowledge` agents must carry `schema:`) + soft
`═══ knowledge snippet coverage ═══` section.

### Iteration 2 — 2026-06-18
Completed coverage so **every** dynamic workflow owns its knowledge base:
- Ported the 4 deferred workflows — `models-assistant` + `video-assistant` (full
  mirror, shared `saveHistory`); `schema-self-improve` + `coverage-self-improve`
  (light variant — inline persist, `!DRY_RUN`-guarded extract). All 12 now load ✓ /
  extract ✓ (verified by the checker).
- Created 0-byte placeholder `.knowledge.jsonl` for the 7 workflows with no history
  yet (ltx, lora-zimage-turbo, ux + the 4 just-ported) so every workflow literally
  has its knowledge base alongside — they fill organically on first real run.
- Added **this MANIFEST** + generator `scripts/workflow-knowledge-manifest.mjs`
  (the "records history" artifact): a manual iteration changelog + a generated
  coverage matrix (records/active/last-run per workflow).

### Iteration 3 — 2026-06-19
Consolidated the `mlx-*` family from 9 workflows down to **4** (run-self-improve-image,
run-self-improve-ltx, review-optimize, lora-review), keeping `run-*` as the core:
- **Removed 4 never/rarely-run workflows** — `image-review-optimize` (99% code duplicate
  of `review-optimize`; its 6 distilled records were folded INTO `review-optimize` —
  35→41 — so no knowledge was lost), `video-assistant`, `models-assistant`,
  `coverage-self-improve` (the latter three: 0 records, never run on disk).
- **Merged `lora-review-flux2-klein` + `lora-review-zimage-turbo` → unified
  `lora-review`**, parameterized by `args.arch` (`flux2-klein-9b` default = multi-lane;
  `zimage-turbo` = T2I-only). Carried flux2-klein's 16 records + 5-run history/reflection
  via the rename (the merge precondition held: both share the same `run.py t2i` shape).
- Gitignored `history/` raw runs for all removed workflows persist on disk (unchanged);
  matrix regenerated to 8 workflows · 140 records. See `_shared-patterns.md` port-checklist
  note 5 for the merge precondition rule.

### Iteration 4 — 2026-06-19
Retired `mlx-movie-director-lora-review` → the mlx-* family is now **3** workflows
(`run-self-improve-image`, `run-self-improve-ltx`, `review-optimize`).
- `lora-review` (102 KB) duplicated `run-self-improve-image` (94 KB) across ~9 of 11
  phases (Resolve/Knowledge/GPU-Wait/Generate/VLM-Check/Review/Report/Review-HTML/Persist);
  its only unique value was the multi-LoRA A/B harness (Discover + Scale Sweep +
  multi-lane routing + ceiling analysis). That line of work has concluded — every durable
  LoRA conclusion already lives in `MEMORY.md` + `knowledge-base/structured/lora-insights.jsonl`.
- **Knowledge:** folded the 2 general-purpose scoring records (prompt-adherence
  differentiator, baseline-collapse on hard prompts — generalized, tagged
  `migrated-from-lora-review`) into `run-self-improve-image.knowledge.jsonl` (20→22).
  The other ~14 were harness-mechanics (ceiling escalation, regression roster, lane
  defaults, per-LoRA baselines) — dead on retirement; recoverable via git history.
- **Deleted:** `lora-review.js`, its `.knowledge.jsonl` + `.knowledge.manifest.json`, and
  the two `history/mlx-movie-director-lora-review*` dirs (gitignored ephemeral).
- Matrix regenerated to 7 workflows · 126 records. See `_shared-patterns.md` port-checklist
  note 5 for the new retire-vs-merge rule (distinct purpose → fold knowledge + retire).

### Iteration 8 — 2026-06-20
Added the **missing MLX code-health orchestrator** `mlx-movie-director-self-improve` — the MLX
analog of `gui-movie-director-self-improve` (parent → child co-work). Two lanes, ONE knowledge
base, ONE history, ONE persist:
- **review lane = CHILD workflow** `workflow("mlx-movie-director-review-optimize", …)` — the
  parent-child relationship the GUI side already had; review-optimize was child-ready but had
  no caller. Forwarded knobs: effort/fix/resume/focus/files.
- **lint lane = INLINED** (MLX-specific, read-only, complementary to review-optimize's semantic
  review): pyflakes real-bug hunt + `run.py check-model` manifest integrity + `test_selftest_integrity.py`.
  Always runs parallel (never edits code → never collides with review's git-stash fix).
- Harness (`saveHistory`/`loadKnowledge`/`extractKnowledge`) copied VERBATIM from
  `_shared-patterns.md`; dirty-tree guard refuses fix on a dirty tree. **Independent from GUI** —
  no imports, no `bun/` paths (GUI is a pattern reference only); MLX does NOT append to the
  Bun-only `knowledge-base/code/` bucket.
- **Scope clarification:** `run-self-improve-image` reviews IMAGE quality (VLM), review-optimize
  reviews CODE — different domains, deliberately NOT coupled. This orchestrator is the third MLX
  workflow TYPE (code-health), leaving the image/ltx generation loops untouched.
- **Knowledge-schema normalization (this commit):** first run's `extractKnowledge` emitted
  `severity`/`files` keys absent from the canonical 12-key schema → checker drift. Stripped them,
  folded severity into `sev:*` tags. Also normalized upstream `lora-quality-gate.knowledge.jsonl`
  (run-specific `*_scales_runN` top-level keys → stable `failing_scales`/`passing_scales` arrays;
  per-run detail preserved in `note`) + hand-wrote its non-canonical sibling manifest, and taught
  `kb-manifest-gen.mjs` to skip manifests whose `kind` is not `workflow-knowledge` so regen no
  longer clobbers hand-maintained non-canonical schemas.
- Matrix regenerated to 7 workflows · 151 records.

### Iteration 7 — 2026-06-20
Ensemble voting (3 VLM votes per scale) + non-monotonicity warning in `lora-quality-gate`:
- **Root cause of noise**: Second run showed non-monotonic lora_activation (0.5→7, 0.65→1, 0.8→8)
  — adjacent same-LoRA scales swinging by >6 points is pure VLM randomness, not real LoRA behavior.
- **Fix: ENSEMBLE_VOTES=3** sequential VLM calls per non-baseline variant; aggregate with
  majority-gate + majority-activation_level + median numeric scores. Variants still run in parallel
  with each other; votes within each variant are sequential (caption.py writes to same .caption.json).
- **Non-monotonicity check**: warn if any adjacent scale pair has |Δlora_activation| > 3 after ensemble.
- **Report**: shows vote confidence (`3/3`, `2/3`) and all individual lma scores per scale.
- **Baseline**: still 1 vote (deterministic: lora_activation=1, gate=fail).

### Iteration 6 — 2026-06-20
New standalone `lora-quality-gate` workflow for LoRA scale sweep + VLM gate review:
- Targets LoRA quality issues specifically: over-activation (watercolor wash, plastic skin),
  under-activation (invisible LoRA), standard AI defects (hands/face/skin via _DEFECT_BLOCK).
- New `lora_quality` VLM style added to caption.py — accepts {lora_name}, {lora_description},
  {scale} template variables; returns gate="pass|marginal|fail", activation_level="under|correct|over",
  over_symptoms[], under_symptoms[], lora_activation score (1-10).
- Workflow: Resolve (locate LoRA manifest) → Knowledge → GPU Wait → Generate sweep → VLM Check →
  Gate Score (parallel caption --style lora_quality) → Analysis (rank scales, find optimal) →
  Review HTML (A/B across scales) → Manifest update (optional) → Persist → Report.
- Standalone (not merged into run-self-improve-image — LoRA gate is a targeted diagnostic,
  merge is TBD after the quality issue is resolved).
- Initialized lora-quality-gate.knowledge.jsonl placeholder.

### Iteration 5 — 2026-06-19
Consolidated the gui self-improve family from 4 workflows down to **2** (the mirror of
Iterations 3–4 on the mlx side, now applied to gui):
- **Merged `gui-movie-director-schema-self-improve` + `gui-movie-director-ux-self-improve`
  → unified `gui-movie-director-self-improve`** (inlined as lanes, no longer orchestrated
  via `workflow()` children). `review-optimize` stays a separate child. The merge
  precondition held: both children already ran as lanes of that orchestrator and shared
  identical harness infra (`saveHistory`/`loadKnowledge`/`extractKnowledge`, args + phase
  tracking).
- **Full consolidation (decided):** ONE knowledge base, ONE history, ONE persist per run
  (previously 4). Dropped per-lane persists (ux `saveHistory`/`extractKnowledge`; schema
  `iterations.jsonl` + `reflection.json`). Schema's counter-based runId / dead-end resume
  moved onto the orchestrator's timestamp `RUN_ID` + the merged KB digest.
- **Knowledge:** folded ux's 10 active records into `gui-movie-director-self-improve.knowledge.jsonl`
  (20→30; ids were already namespaced `gui-ux:` vs `gui-selfimprove:` — no collision). Schema's
  KB was empty (0 records). Total records unchanged at 126 (the 10 moved, none lost).
- **Deleted:** both child `.js`, their `.knowledge.jsonl` + `.knowledge.manifest.json`.
- Matrix regenerated to 5 workflows · 126 records. See `_shared-patterns.md` port-checklist
  note 6 for the merge-precondition shape (orchestrated-as-lane + shared harness contract —
  distinct purposes are OK when already unified at the orchestration layer).

<!-- BEGIN KNOWLEDGE MATRIX -->

> _Generated by `scripts/workflow-knowledge-manifest.mjs` — do not edit by hand. Run after porting/seeding a workflow._

| Workflow | Family | load | extract | saveHistory | kb file | records | active | last run |
|---|---|:---:|:---:|:---:|:---:|---:|---:|---|
| gui-movie-director-review-optimize | gui | ✓ | ✓ | ✓ | ✓ | 73 | 40 | 2026-06-23T22-35-42 |
| gui-movie-director-self-improve | gui | ✓ | ✓ | ✓ | ✓ | 52 | 40 | 2026-06-23T22-34-02 |
| lora-quality-gate | — | ✓ | — | — | ✓ | 3 | 0 | — |
| mlx-movie-director-review-optimize | mlx | ✓ | ✓ | ✓ | ✓ | 70 | 40 | 2026-06-23T21-29-09 |
| mlx-movie-director-run-self-improve-image | mlx | ✓ | ✓ | ✓ | ✓ | 22 | 22 | 2026-06-20T04-24-28 |
| mlx-movie-director-run-self-improve-ltx | mlx | ✓ | ✓ | ✓ | ✓ | 21 | 20 | — |
| mlx-movie-director-self-improve | mlx | ✓ | ✓ | ✓ | ✓ | 31 | 31 | 2026-06-23T22-40-15 |

**Totals:** 7 workflows · 7 load / 6 extract wired · 7 knowledge files · 272 records (193 active)

<!-- END KNOWLEDGE MATRIX -->
