# Dasiwa Hyperparameter Sweep: stage1_steps, teacache, audio knobs

## Background

The current `run.py` default for `--transformer dasiwa` is `stage1_steps=16`, with this
help-text note:

> "For VOICE/speech quality use 16 (8 steps produces audio noise); see docs/ltx-voice.md."

**This claim is unverified.** The `docs/ltx-voice.md` file does not exist. The vendor
`ltx-2-mlx` documentation lists 30 as the standard default (15 for HQ). The "16 = speech
minimum" rule was written as a conservative assumption, not derived from measurement.

If 8 steps produces acceptable audio and video, the dasiwa default should drop to 8 —
cutting generation time roughly in half (~4.5 min vs ~9 min for a 10 s video at 704×448).

This document expanded from a simple 8-vs-16 A/B test into a full parameter sweep
covering four axes: `stage1_steps`, `teacache`, `audio_stage1_only`, and `audio_cfg_scale`.

---

## Automation

```bash
# Step 0: generate shared base image (once)
python/venv/bin/python python/mlx-movie-director/run.py video t2i2v \
  --prompt "一位年輕女性站在陽光明媚的花園中，她溫柔微笑，輕聲說「你終於來了，我等你好久了。」Style: cinematic realism." \
  --transformer dasiwa --dev-audio --frames 49 --seed 42 --yes
# Note the output image path (e.g. .../t2i2v_*/image.png) → BASE_IMAGE

# Step 1: run the full 7-condition sweep
BASE_IMAGE=<path from Step 0> bash python/mlx-movie-director/scripts/sweep_dasiwa_params.sh

# Step 2: analyze results
python/venv/bin/python python/mlx-movie-director/scripts/analyze_dasiwa_sweep.py \
  <SWEEP_ROOT> --frames 8 --voice --csv
```

**Multi-seed run** (3 seeds for statistical confidence):
```bash
BASE_IMAGE=<path> SEEDS="42 100 200" bash python/mlx-movie-director/scripts/sweep_dasiwa_params.sh
```

---

## Condition Matrix

| Cell | stage1_steps | teacache | audio_stage1_only | audio_cfg_scale | Est. time |
|------|-------------|----------|-------------------|-----------------|-----------|
| s1_8 | 8 | off | off | 7.0 (default) | ~4.5 min |
| s1_16 | 16 | off | off | 7.0 | ~9 min |
| s1_30 | 30 | off | off | 7.0 | ~17 min |
| s1_8_tc | 8 | **on** | off | 7.0 | ~3 min |
| s1_16_tc | 16 | **on** | off | 7.0 | ~6 min |
| s1_8_ao | 8 | off | **on** | 7.0 | ~4.5 min |
| s1_8_acfg3 | 8 | off | off | **3.0** | ~4.5 min |

Held constant: `cfg_scale=5.0`, `stg_scale=1.0`, `audio_modality_scale=5.0`, `stage2_steps=3`,
`frames=49`, `seed=42`, resolution `448×704`, `--transformer dasiwa --dev-audio`.

---

## Hypotheses

**H_steps:** stage1_steps=8 produces audio noise or detectably worse quality vs 16.
→ If disproved across ≥3 seeds: update dasiwa default 16 → 8.

**H_tc:** teacache degrades audio intelligibility or video sharpness.
→ If disproved: enable teacache by default (free ~1.46× speedup).

**H_ao:** audio_stage1_only degrades content_match.
→ If disproved (or improves): test upstream LTX-2 issue #126 hypothesis.

**H_acfg:** audio_cfg_scale=3.0 produces worse content_match than 7.0.
→ If disproved: consider lowering default for more natural audio.

---

## Metrics (auto-collected)

`quality_report.json` is written by `--quality-check` after every run. `analyze_dasiwa_sweep.py` reads it.

| Metric | Source | Description |
|--------|--------|-------------|
| `lang_ok` | `audio_asr.lang_ok` | Whisper detects `zh` (not `ja`) |
| `content_match` | `audio_asr.content_match` | ≥50% CJK char overlap with expected speech |
| `content_ratio` | `audio_asr.content_ratio` | Exact overlap fraction |
| `sharpness_mean` | `signal.sharpness_mean` | Laplacian σ² averaged over ALL frames |
| `snr_db_mean` | `signal.snr_db_mean` | Luminance SNR averaged over ALL frames |
| `flicker_mean` | `signal.flicker_mean` | Inter-frame MAD (motion proxy) |
| `vlm_overall` | `vlm.overall` | VLM score 1–10 |
| `vlm_coherence` | `vlm.temporal_coherence` | Motion smoothness 1–10 |
| Per-frame sharpness | sampled by analyzer | min/P25/median/P75/max distribution |
| `snr_db` (audio) | `voice_metrics` | Audio SNR (signal vs noise floor) |
| `f0_st_std` | `voice_metrics` | Pitch variation in semitones (naturalness) |

## Results Table (fill in after running sweep)

<!-- paste output of analyze_dasiwa_sweep.py here -->

---

## Pass/Fail Criteria

Condition A (stage1=8) **passes** if ALL of the following hold across all 3 seeds:

1. `audio_lang_ok = True` (zh detected, not ja) — hard requirement
2. `content_match = True` (≥50% speech overlap) — hard requirement
3. `sharpness_mean` within 20% of Condition B mean — visual acceptability
4. `snr_db_mean` ≥ 15 dB — audio is not noise-dominated

A single `ja` detection on any seed → **FAIL** (confirms the 16-step minimum claim).

---

## Expected Outcome and Action

| Outcome | Action |
|---------|--------|
| A passes all criteria | Update dasiwa default `stage1_steps`: 16 → 8. Remove "audio noise" claim from help text. Update README benchmarks (~4.5 min for 10s video). |
| A fails audio (lang_ok=False on any seed) | Keep stage1_steps=16. Document empirical evidence. Create `docs/ltx-voice.md` with findings. |
| A fails sharpness only | Keep stage1_steps=16 for default; document 8-step as "fast draft" option. |

---

## Prior Art (existing data points)

The following runs used `stage1_steps=16` and passed:

| Date | Frames | lang_ok | content_ratio | sharpness | Notes |
|------|--------|---------|---------------|-----------|-------|
| 2026-06-22 | 49 | ✓ zh | 0.727 | 849 | seed=42, 448×704, dasiwa+dev-audio |
| 2026-06-22 | 361 | ✓ zh | 0.69 | — | 15s run, full transcript captured |

No 8-step data exists yet — this test fills that gap.

---

## Notes

- `--from-image` skips Stage 1 (T2I) and Stage 2 (VLM) — only Stage 3 (LTX I2V) varies.
  This isolates the stage1_steps effect from T2I and prompt-expansion variance.
- If the shared base image produces a static-video warning (`static_flag=true`), try
  a different seed for the base image and re-run. The static flag does not affect audio.
- The distilled transformer already uses 8 steps by default and passes audio checks with
  zh prompts when `--dev-audio` is applied — this is supporting evidence for H₁.
