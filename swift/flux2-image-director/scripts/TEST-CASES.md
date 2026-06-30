# flux2-image-director — test cases

Reproducible test cases for the wave-2 features (`scene` multi-ref, `--regional`,
WS3, 12-LoRA stack). All verification uses the **local LLM** (`run.py caption`
→ gemma-4-26b, plus direct qwen3-vl-4b calls) — never MCP. Outputs land under
`test_cases/` (gitignored — regenerable via these scripts).

## What the python `run.py` self-test already covers

`python/mlx-movie-director/app/test_prompts_image.py` registers, for the
**python** flux2-klein path: `lora:multi-zimage` (stacked-LoRA plumbing),
`lora:anime2real` (I2I+LoRA), `lora:anime2real-ref` (Ref+LoRA identity), and A/B
sweeps (`-ref-strength`, `-ab`, `-pipeline`). The **Swift** `flux2` CLI had no
image-level test for the wave-2 scene features — these scripts fill that gap.

## Scripts

| script | what it tests | outputs |
|---|---|---|
| `regional-placement-test.sh` | closeup 2-person left/right placement, baseline vs `--regional` | `test_cases/regional/*` |
| `fullbody-stress-test.sh` | full-body refs (hands visible, small face), 3 baseline seeds + 1 regional | `test_cases/fullbody/*` |
| `verify-placement.py` | qwen3-vl-4b: who is L/R, hands ok?, framing | stdout table |
| `harsh-hand-check.py` | gemma-4-26b adversarial hand audit | stdout |

Run: `bash scripts/regional-placement-test.sh && bash scripts/fullbody-stress-test.sh`,
then `python/venv/bin/python scripts/verify-placement.py`.

## Key result (2026-06-30) — `--regional` is net-negative for clear prompts

Local-LLM verdict (gemma `--style score`):

| run | overall | artifacts | prompt_adherence |
|---|---|---|---|
| baseline s42 | 6 | 5 | 10 |
| baseline s77 | 6 | 4 | 9 |
| baseline s123 | **7** | **9** | 10 |
| regional | **4** | **3** | 5 |

- Baseline placed pink-LEFT / teal-RIGHT **correctly on all 3 seeds** → the
  "placement is non-deterministic" code caveat is too pessimistic when refs carry
  distinct visual cues.
- `--regional`: 2.5× slower, ghosting/duplication + fused fingers on crossed
  hands (the strip inpaint re-rolls the hand zone).
- Real ceiling = **hands** (artifacts 3–5 flat), a platform artifact — not
  fixable from `scene`. See README "Regional placement" + memory
  `flux2-regional-net-negative-tested`.

## Still open (not run this pass)

- **anime→real stack test**: the 12-LoRA stack is the "卡通转真人工场" (cartoon→real)
  pack, but these scripts feed it **photoreal** refs. A faithful stack test needs
  an **anime** source image (generate via an anime prompt, or download) →
  `flux2 scene --ref <anime> --lora anything2real-a …` → caption-verify the
  cartoon→real conversion. Identified; deferred.
- WS3 (`--ref-strength` / `--ref-gate-steps`): currently verified only by the log
  strings; no image-level A/B. Add a strength-sweep variant if finer ref control
  is exercised.

## Improvements shipped after the findings (2026-06-30)

The findings drove two improvements (knowledge: refs are global → placement is
prompt-driven & probabilistic → don't fight the arch with full-regen inpaint):

1. **`--regional-strength` (SDEdit partial denoise, default 0.45)** — fixes the
   net-negative `--regional`. The strip is now refined from a lightly-noised copy
   of the existing scene instead of pure noise, so identity is nudged **without
   re-rolling hands**. `Flux2EditPipeline.inpaint(denoiseStrength:)`. Verified:
   old strength-1.0 → overall 4 / artifacts 3 (ghosting + fused fingers); new
   strength-0.45 → overall 6 / artifacts 5 / adherence 10, issues back to the
   baseline plasticky-skin platform artifact (no structural hand damage). Also
   ~2× faster (127 s vs 259 s — fewer steps per strip).
2. **`multi-seed-autoselect.sh` + `autoselect-rank.py`** — the recommended path:
   run N seeds → verify each with the local LLM (placement correctness + hand
   quality) → keep the verified-correct best → `autoselect-report.html`. Tested:
   5/5 seeds placed correctly (pink-LEFT / teal-RIGHT), winner auto-selected.

Reproduce: `bash scripts/multi-seed-autoselect.sh 5`.

