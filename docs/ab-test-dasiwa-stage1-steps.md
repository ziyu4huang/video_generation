# A/B Test: dasiwa stage1_steps=8 vs 16

## Background

The current `run.py` default for `--transformer dasiwa` is `stage1_steps=16`, with this
help-text note:

> "For VOICE/speech quality use 16 (8 steps produces audio noise); see docs/ltx-voice.md."

**This claim is unverified.** The `docs/ltx-voice.md` file does not exist. The vendor
`ltx-2-mlx` documentation lists 30 as the standard default (15 for HQ). The "16 = speech
minimum" rule was written as a conservative assumption, not derived from measurement.

If 8 steps produces acceptable audio and video, the dasiwa default should drop to 8 —
matching the dev/distilled default and cutting generation time roughly in half
(~4.5 min vs ~9 min for a 10 s video at 704×448).

---

## Hypothesis

**H₀ (null):** stage1_steps=8 produces audio noise or detectably worse quality vs 16.
**H₁ (alternative):** stage1_steps=8 is equivalent — `lang_ok=True`, `content_match=True`,
visual sharpness within 20% of 16-step baseline.

If H₁ is confirmed across ≥3 seeds → update dasiwa default from 16 → 8.

---

## Protocol

### Fixed variables (identical across all runs)

| Variable | Value |
|----------|-------|
| Transformer | `dasiwa` |
| Audio fix | `--dev-audio` (4775 keys transplanted from dev) |
| Shared T2I base | single image generated once, reused via `--from-image` |
| Prompt | see below |
| Resolution | 448×704 (portrait, standard t2i2v default) |
| Frames | 49 (4 s @ 24 fps — minimum for meaningful speech) |
| stage2_steps | 3 (fixed) |
| cfg_scale | 5.0 (dasiwa A/B-optimum) |
| stg_scale | 1.5 (dasiwa A/B-optimum) |
| audio_modality_scale | 5.0 (dasiwa A/B-optimum) |
| Quality check | `--quality-check` (ASR + VLM + signal) |

### Independent variable

| Condition | stage1_steps |
|-----------|-------------|
| **A** | 8 |
| **B** | 16 (current default) |

### Seeds: 3 runs per condition (6 runs total)

Seeds: `42`, `100`, `200`

### Prompt (fixed)

```
一位年輕女性站在陽光明媚的花園中，她溫柔微笑，
輕聲說「你終於來了，我等你好久了。」Style: cinematic realism.
```

Expected speech (for content_match gate): `你終於來了，我等你好久了。`

---

## Commands

### Step 0 — Generate shared T2I base image (once)

```bash
python/venv/bin/python python/mlx-movie-director/run.py video t2i2v \
  --prompt "一位年輕女性站在陽光明媚的花園中，她溫柔微笑，輕聲說「你終於來了，我等你好久了。」Style: cinematic realism." \
  --transformer dasiwa --dev-audio \
  --frames 49 --seed 42 --quality-check
```

Note the output image path from `Stage 1/3: T2I` output (e.g.
`/output/t2i2v_YYYYMMDD_HHMMSS/output_*.png`). Use this as `BASE_IMAGE` in steps below.

### Step 1 — Condition A: stage1_steps=8 (3 seeds)

```bash
BASE_IMAGE=<path from Step 0>

for SEED in 42 100 200; do
  python/venv/bin/python python/mlx-movie-director/run.py video t2i2v \
    --from-image "$BASE_IMAGE" \
    --prompt "一位年輕女性站在陽光明媚的花園中，她溫柔微笑，輕聲說「你終於來了，我等你好久了。」Style: cinematic realism." \
    --transformer dasiwa --dev-audio \
    --frames 49 --seed "$SEED" \
    --stage1-steps 8 --stage2-steps 3 \
    --quality-check
done
```

### Step 2 — Condition B: stage1_steps=16 (3 seeds)

```bash
for SEED in 42 100 200; do
  python/venv/bin/python python/mlx-movie-director/run.py video t2i2v \
    --from-image "$BASE_IMAGE" \
    --prompt "一位年輕女性站在陽光明媚的花園中，她溫柔微笑，輕聲說「你終於來了，我等你好久了。」Style: cinematic realism." \
    --transformer dasiwa --dev-audio \
    --frames 49 --seed "$SEED" \
    --stage1-steps 16 --stage2-steps 3 \
    --quality-check
done
```

---

## Metrics to Collect (per run)

From `quality_report.json` in each output directory:

| Metric | Source | Description |
|--------|--------|-------------|
| `audio_lang_ok` | `audio_asr.lang_ok` | True if Whisper detects `zh` |
| `content_match` | `audio_asr.content_match` | True if ≥50% CJK char overlap |
| `content_ratio` | `audio_asr.content_ratio` | Exact overlap fraction |
| `transcript` | `audio_asr.transcript` | Raw Whisper transcript |
| `sharpness_mean` | `signal.sharpness_mean` | Laplacian variance (higher = sharper) |
| `snr_db_mean` | `signal.snr_db_mean` | Audio SNR in dB |
| `vlm_overall` | `vlm.overall` | VLM composite score 1–10 |
| `vlm_temporal` | `vlm.temporal_coherence` | Motion smoothness 1–10 |
| `time_s` | clock wall time | Measured manually or from log |

---

## Results Table (fill in after runs)

| Seed | Cond | stage1 | lang_ok | content_match | content_ratio | sharpness | snr_dB | vlm | time_s |
|------|------|--------|---------|---------------|---------------|-----------|--------|-----|--------|
| 42 | A | 8 | | | | | | | |
| 100 | A | 8 | | | | | | | |
| 200 | A | 8 | | | | | | | |
| 42 | B | 16 | | | | | | | |
| 100 | B | 16 | | | | | | | |
| 200 | B | 16 | | | | | | | |

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
