# LTX-2.3 Voice/Audio Generation — Investigation & Findings

**Last updated:** 2026-06-07
**Status:** Lip sync ✅ fixed. Audio amplitude workaround ✅ (`--audio-volume 50`). Root cause confirmed: MLX transformer numerical divergence. New: `--audio-cfg-scale` flag added.

---

## Summary

LTX-2.3 generates audio+video jointly via a 48-layer DiT with audio-video cross-attention. Our MLX port (dgrauet/ltx-2-mlx) had a critical bug that zeroed the AV cross-attention gate, plus an audio VAE output shape mismatch. After fixes, lip sync is correct but audio amplitude remains extremely low (~100x quieter than expected).

**Root cause confirmed (2026-06-07):** The audio VAE decoder is correct (encoder→decoder round-trip works). The issue is that the MLX transformer produces audio latents in the wrong direction (not just scale) due to Metal bf16 numerical divergence over 48 layers. Evidence: encoder z.std=1.35 for real audio vs transformer z.std=0.97 (only 1.39x off — scale is not the issue). Amplifying the latent improves mel but not waveform (vocoder saturates at ~0.015 peak regardless of mel amplitude).

---

## Bugs Found & Fixed

### 1. `av_ca_timestep_scale_multiplier` = 1.0 instead of 1000.0 ✅ FIXED

**Impact:** AV cross-attention gate attenuated by 1000x, zeroing speech/lip-sync information from video→audio.

**Evidence:** Checkpoint metadata (`embedded_config.json`) specifies `1000.0`; MLX code defaulted to `1.0`.

```
av_ca_factor = av_ca_timestep_scale_multiplier / timestep_scale_multiplier
Current:  1.0 / 1000.0 = 0.001  ← gate near zero (WRONG)
Correct: 1000.0 / 1000.0 = 1.0  ← full cross-modal attention
```

**Fix:**
- `model/transformer/model.py`: Changed default `1.0` → `1000.0`; added `LTXModelConfig.from_checkpoint_config()`
- `utils/_orchestration.py`: `load_transformer()` now reads from `embedded_config.json`
- **Result:** Lip sync now works correctly. Visual lip movements match expected speech.

**Upstream issue:** [dgrauet/ltx-2-mlx#37](https://github.com/dgrauet/ltx-2-mlx/issues/37)

### 2. AudioVAEDecoder missing `_adjust_output_shape` ✅ FIXED

**Impact:** Off-by-3 time frames in mel spectrogram. Upstream crops output to `target_frames = T * 4 - 3` (causal conv offset); MLX returned raw network output.

**Fix:** Added output cropping/padding in `AudioVAEDecoder.decode()` matching upstream reference.

**Upstream issue:** [dgrauet/ltx-2-mlx#36](https://github.com/dgrauet/ltx-2-mlx/issues/36)

### 3. Audio noise detection false positive ✅ FIXED (previous session)

**Impact:** Downsampling to 16kHz before spectral analysis destroyed high-frequency content, inflating spectral flatness from 0.128 → 0.416 and causing false noise detection.

**Fix:** Analyze at native 48kHz sample rate. Restored thresholds to 0.55/0.40.

---

## Active Issues (Unfixed)

### 4. Audio Amplitude ~100x Too Low 🔴 ACTIVE

**Impact:** All generated audio has RMS ~0.002, Peak ~0.013 — about 100x quieter than expected. **Independent of prompt, CFG, STG, frame count, and stage selection.**

**A/B test results (all 49 frames, 12 steps, seed 42):**

| Config | Frames | CFG | STG | audio-stage1-only | Peak | RMS |
|--------|--------|-----|-----|-------------------|------|-----|
| short-default | 49 | 5.0 | 1.0 | No | 0.0119 | 0.0021 |
| short-high-cfg | 49 | 7.0 | 1.0 | No | 0.0114 | 0.0021 |
| short-no-stg | 49 | 5.0 | 0.0 | No | 0.0115 | 0.0021 |
| short-cfg3 | 49 | 3.0 | 1.0 | No | 0.0118 | 0.0021 |
| ultra-short | 25 | 5.0 | 1.0 | No | 0.0116 | 0.0021 |
| stage1-only | 49 | 5.0 | 1.0 | **Yes** | 0.0121 | 0.0021 |
| frog-yoga prompt | 49 | 5.0 | 1.0 | No | 0.0139 | 0.0026 |

**Traced through decode pipeline:**

| Stage | Shape | Range | Notes |
|-------|-------|-------|-------|
| Audio latent (from transformer) | (1,8,51,16) | [-7.7, 5.5] | std~0.97 — looks reasonable |
| **Mel (after VAE decode)** | (1,2,201,64) | **[-11.1, 0.05]** | **Very negative — should be [-5, +2]** |
| Waveform (after vocoder+BWE) | (1,2,96480) | [-0.01, 0.014] | Faithful to quiet mel |

**Root cause (confirmed 2026-06-07):** The audio VAE decoder itself is correct (encoder→decoder round-trip works). The issue is that the **audio latent from the transformer is in the wrong distribution** — not primarily scale, but direction (numerical divergence).

**Diagnostic results (2026-06-07):**

| Measurement | Value | Notes |
|-------------|-------|-------|
| `per_channel_statistics.mean_of_means` | [-1.9, +2.7], mean=0.018 | Correctly loaded ✅ |
| `per_channel_statistics.std_of_means` | [0.74, 2.05], mean=1.17 | Correctly loaded ✅ |
| Encoder z.std() for real 16kHz audio | **1.35** | Expected std for real speech |
| Transformer audio z.std() | **0.97** | 1.39x smaller — small scale mismatch |
| VAE round-trip (real audio) | mel max=-0.46 ✅ | Decoder works correctly |
| VAE decode with z.std()=0.97 random | mel max=-0.48 | Similar to transformer output |

**Conclusion:** The 1.39x scale difference (encoder produces z.std=1.35, transformer produces z.std=0.97) is too small to explain the amplitude issue. The root cause is **MLX numerical divergence** — the transformer produces audio latents in the wrong DIRECTION (not just wrong scale), causing the decoder to produce near-silent mel.

**Hypotheses confirmed/ruled out:**
1. ~~Per-channel statistics mismatch~~ — Stats are correctly loaded and reasonable ✅ RULED OUT
2. ~~Audio latent scale too small~~ — Scale mismatch is only 1.39x, not 50x ✅ RULED OUT  
3. **MLX numerical divergence** — Audio latents in wrong direction (layer 0 cosine sim=0.135, output=0.186 vs PyTorch) 🔴 CONFIRMED ROOT CAUSE

### 5. MLX vs PyTorch Numerical Divergence 🟡 ONGOING — Text Encoder Fix Identified

**Impact:** Even with all fixes, MLX speech is ~60% intelligible vs near-perfect in PyTorch/ComfyUI. The 48-layer transformer accumulates precision differences between Metal (bf16) and CUDA/MPS.

**Evidence (from Acelogic):**
- Exported ComfyUI text embeddings → fed to MLX → still garbled speech (rules out text encoder)
- MLX mel spectrogram → PyTorch vocoder → speech very quiet (rules out vocoder)
- Layer-by-layer: cosine similarity starts at 0.135 (layer 0), converges to 0.945 (interior layers), diverges again at output (0.186)
- MLX std consistently lower than PyTorch (0.56 vs 0.79) — MLX output is compressed/muted

**Proposed fix (from Acelogic — NOT YET APPLIED to our pipeline):**

The [Acelogic/LTX-2-MLX](https://github.com/Acelogic/LTX-2-MLX) fork (local: `/Users/huangziyu/proj/acelogic-ltx-2-mlx/`) identified and fixed the root cause in the **text encoder** — specifically Gemma RoPE configuration and the connector. Their investigation is documented in `AUDIO_ISSUES.md`.

| # | Fix | File | Impact |
|---|-----|------|--------|
| 1 | **Gemma per-layer RoPE** — 40 sliding layers (theta=10k, no scaling, 1024 window) + 8 full layers (theta=1M, scaling=8.0) | `LTX_2_MLX/model/text_encoder/gemma3.py` | Cosine sim **0.05 → 0.934** at final text encoder layer |
| 2 | **Gemma boolean attention masks** — float masks caused NaN for all-padded rows | `LTX_2_MLX/model/text_encoder/gemma3.py` | Stable attention computation |
| 3 | **Connector register handling** — append registers (extend to 1024) instead of replacing padding | `LTX_2_MLX/model/text_encoder/connector.py` | Correct sequence length |
| 4 | **Double-precision RoPE for connector** | `LTX_2_MLX/model/text_encoder/connector.py` | Precision fix |

**The Gemma per-layer RoPE fix (#1) is the biggest lever** — it takes text encoder cosine similarity from 0.05 to 0.934. Our current `vendor_patches.py` patches the transformer and audio pipeline but does NOT touch the text encoder. These fixes should be ported as new patches targeting `vendor/ltx-2-mlx/packages/ltx-core-mlx/src/ltx_core_mlx/model/text_encoder/`.

**Active issue (both repos):** Duration-dependent amplitude — 5s clips are loud/healthy, 10s clips are 5× quieter. Not yet fixed.

### 6. Amplification Experiments ✅ TESTED

**Amplifying the audio latent before VAE decode does NOT fix the waveform amplitude:**

| Latent multiplier | Mel max | Mel mean | Waveform Peak | Waveform RMS |
|-------------------|---------|----------|---------------|--------------|
| 1x (original) | +0.05 | -4.64 | 0.014 | 0.0026 |
| 5x | +5.88 | -5.23 | 0.015 | 0.0024 |
| 10x | +7.16 | -4.38 | 0.016 | 0.0024 |
| 20x | +7.63 | -3.24 | 0.016 | 0.0025 |
| 50x | +7.84 | -2.45 | 0.016 | 0.0026 |

The mel dynamic range increases (max goes from +0.05 to +7.8) but the **waveform stays at ~0.015 peak**. The vocoder saturates — it cannot produce louder output from louder mel input.

**The base vocoder output (before tanh) is already 0.014 peak**, meaning tanh is not the bottleneck. The vocoder weights or architecture limit the output amplitude.

### 7. Post-Processing Volume Boost ✅ WORKS (integrated as `--audio-volume`)

**Amplifying the final audio with ffmpeg restores normal levels:**
```bash
# Built-in flag (recommended):
run.py video generate --test-prompt frog-yoga --audio-volume 50

# Manual ffmpeg equivalent:
ffmpeg -i input.mp4 -af "volume=50" -c:v copy output_loud.mp4
```

**Result with `--audio-volume 50`:** Peak 0.58, RMS 0.10 — normal speech levels.

| Metric | Raw output | After `--audio-volume 50` |
|--------|-----------|--------------------------|
| Peak | 0.014 | 0.58 |
| RMS | 0.0026 | 0.10 |
| Quality | Audible but whisper-quiet | Normal speech volume |

**The audio content is there, just ~50x too quiet.** Post-processing recovers it. This is now integrated into the CLI.

---

## Audio Pipeline Architecture

```
Text prompt → Gemma 12B → dual projections (video 4096-d, audio 2048-d)
                                    ↓
              Audio text embeds → Embeddings1DConnector (8 blocks, 128 registers)
                                    ↓
              Transformer (48 blocks, joint audio+video attention)
                 ├── Self-attention (video tokens + audio tokens separately)
                 ├── Text cross-attention (video↔text, audio↔text)
                 └── AV cross-attention (video↔audio, gated by av_ca_timestep_scale)
                                    ↓
              Audio latent (B, 8, T, 16)  ← AudioPatchifier.unpatchify()
                                    ↓
              AudioVAEDecoder → mel (B, 2, T', 64)
                 ├── Per-channel denormalize
                 ├── Conv2d stack (causal padding)
                 ├── 3 upsample levels (512→256→128)
                 └── Output crop to T*4-3 (causal)
                                    ↓
              BigVGAN vocoder → waveform @ 16kHz (stereo)
                 ├── 6 upsample stages [5,2,2,2,2,2] = 160x
                 ├── SnakeBeta activation (log-scale alpha/beta)
                 └── Must run in fp32 (108 convolutions accumulate errors)
                                    ↓
              BWE (bandwidth extension) → waveform @ 48kHz
                 ├── Hann-sinc 3x resampler (16→48kHz)
                 ├── MelSTFT (causal, hop=80)
                 ├── BWE generator (separate BigVGAN)
                 └── Residual add: resampled_base + bwe_residual
                                    ↓
              Save WAV → mux into MP4 via ffmpeg
```

### Key Parameters

| Parameter | Video | Audio | Notes |
|-----------|-------|-------|-------|
| `cfg_scale` | 3.0 (default) / 5.0 (our setting) | **7.0 (hardcoded)** | Audio CFG is fixed, not affected by `--cfg-scale` |
| `stg_scale` | 1.0 | 1.0 | Same |
| `rescale_scale` | 0.7 | 0.7 | Same |
| `modality_scale` | 3.0 | 3.0 | Same |
| `stg_blocks` | [28] | [28] | Same |
| Token count | F × H × W | `round(frames/fps * 25)` | ~25 audio tokens/second |
| Dimensions | 4096 (32 heads × 128) | 2048 (32 heads × 64) | Audio is half video dim |

---

## Prompting Best Practices (from official LTX + community)

### For Voice/Speech
- Put dialogue in **quotation marks**: `She says, "Hello world."`
- Include **"talking"** or **"speaking"** explicitly in the prompt
- Describe voice qualities: "warm and clear", "low gravelly voice", "quiet whisper"
- Use **close-up headshot** framing for lip sync (avoid full-body shots)
- Keep prompt **short** (< 100 tokens) — short prompts produce better speech
- **5-second clips produce best speech** (49-57 frames at 24fps)
- Do NOT use negation like "no music" — the model interprets "music" as a cue

### For Ambient Audio
- Interleave sound descriptions with visual events (not appended at end)
- Use material + acoustic descriptors: "echoing footsteps on stone", "crackling fire with distant wind"
- Describe the soundscape explicitly: what surfaces, what materials, what acoustic properties

### Negative Prompt (from DiffSynth-Studio community)
```
"mismatched lip sync, silent or muted audio, distorted voice, robotic voice,
echo, background noise, off-sync audio, incorrect dialogue, added dialogue,
repetitive speech"
```

---

## Investigation Sources

| Source | Key Finding |
|--------|-------------|
| [Acelogic/LTX-2-MLX AUDIO_ISSUES.md](https://github.com/Acelogic/LTX-2-MLX/blob/main/AUDIO_ISSUES.md) | Comprehensive MLX audio debugging log; confirmed av_ca bug, duration amplitude bug, numerical divergence |
| [dgrauet/ltx-2-mlx#37](https://github.com/dgrauet/ltx-2-mlx/issues/37) | Our upstream issue for av_ca_timestep_scale_multiplier fix |
| [dgrauet/ltx-2-mlx#36](https://github.com/dgrauet/ltx-2-mlx/issues/36) | Upstream issue for _adjust_output_shape (off-by-3 frames) |
| [Lightricks/LTX-2](https://github.com/Lightricks/LTX-2) | Official upstream; audio CFG=7.0 confirmed in constants |
| [embedded_config.json](../models/text_encoder/ltx-2.3-connector/embedded_config.json) | Checkpoint metadata with correct av_ca_timestep_scale_multiplier=1000.0 |

---

## Action Items

- [ ] **Port Acelogic text encoder fixes** — Add Gemma per-layer RoPE, boolean attention masks, connector register handling, and double-precision RoPE as monkey-patches in `app/vendor_patches.py`. The Gemma RoPE fix alone takes cosine sim from 0.05 → 0.934 — this is likely the biggest remaining lever for speech clarity. Source: `/Users/huangziyu/proj/acelogic-ltx-2-mlx/AUDIO_ISSUES.md` and `LTX_2_MLX/model/text_encoder/gemma3.py`.
- [ ] **File text encoder fixes upstream** on dgrauet/ltx-2-mlx once we verify the Acelogic patches work with our pipeline.
- [ ] **Investigate duration-dependent amplitude** — 5s clips loud, 10s clips 5× quieter (Acelogic also seeing this). Likely in noise generation, denoising step, or MultiModalGuider normalization.
- [x] ~~Try `--audio-cfg-scale 1.0`~~ — Tested: no effect. CFG=1.0 vs CFG=7.0 produces identical amplitude. *(resolved 2026-06-07)*
- [x] ~~Compare with ComfyUI (PyTorch)~~ — Done (Acelogic). Layer-by-layer comparison confirms divergence starts at text encoder output (cosine sim 0.135 at layer 0). *(resolved 2026-06-07)*
- [x] ~~Investigate the audio patchifier~~ — Superseded: the audio patchifier is NOT the first divergence point. The text encoder (Gemma RoPE misconfiguration) is. *(resolved 2026-06-07)*

---

## Test Prompts for Voice

All voice prompts now use default `--audio-volume 50` (auto-applied). No manual flags needed.

### Optimal Step Counts (A/B tested 2026-06-07)

Same prompt, same seed=42, varying steps:

| Config | stage1 | stage2 | Time | Rating | Notes |
|--------|--------|--------|------|--------|-------|
| A | 8 | 1 | 37s | 1/5 | Pure noise — unusable |
| B | 12 | 1 | 54s | 1/5 | Still noise — unusable |
| **C** | **16** | **3** | **84s** | **5/5** | **Winner — coherent, clear** |
| D | 20 | 3 | 104s | 4/5 | Good but not better than C |
| E | 30 | 3 | 151s | 3/5 | Worse than C — oversmoothed? |

`stage2_steps=1` is insufficient (fails regardless of stage1). `stage1_steps=16` is optimal — more steps degrade quality with the dynamic shift schedule.

### `voice-test` — Close-up speaking, short clip
```
run.py video generate --test-prompt voice-test --audio-volume 50
```
Close-up of woman's face, says "The weather is beautiful today." 49 frames (2s). Best case for speech clarity.

### `frog-yoga` — Narrative dialog with multiple voices
```
run.py video generate --test-prompt frog-yoga --audio-volume 50
```
Frog yoga studio with instructor speaking "We are one with the pond" and class responding "Ommm...". Narrative style with multiple voice interactions.

### `dialog-test` — Two-person conversation
```
run.py video generate --test-prompt dialog-test --audio-volume 50
```
Café scene with two people exchanging lines. Tests dialog + ambient audio.

### Effective Prompt Patterns for Voice

From Acelogic investigation + official LTX guidance, the best prompts for voice generation use:

1. **Narrative scene-setting** — describe the environment first, then introduce dialog
2. **Quoted dialog** — put speech in quotes: `"We are one with the pond."`
3. **Voice descriptors** — describe HOW the voice sounds: "voice deep and calm", "warm and clear"
4. **Response sounds** — include non-speech vocalizations: `"Ommm..."`, chuckles, sighs
5. **Explicit "talking"/"speaking"** — the model needs to know the character is vocalizing
6. **Close-up framing** — face visible for lip sync conditioning

Example template:
```
The camera opens in [setting]. [Ambient sounds described].
[Character] [action], [voice description]. "[Dialog line]."
[Response/ambient sounds]. [Character] [continues action]. "[Next dialog line]."
```
