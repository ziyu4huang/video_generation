# LTX-2.3 Video Pipeline — Architecture & Usage

**Last updated:** 2026-06-07

---

## Overview

LTX-2.3 is a 22B-parameter joint audio-video diffusion model running on Apple Silicon via the [dgrauet/ltx-2-mlx](https://github.com/dgrauet/ltx-2-mlx) vendored submodule. It generates video with synchronized audio from text prompts, reference images (I2V), or audio clips (A2V).

| Mode | Input | Output | Pipeline Class |
|------|-------|--------|----------------|
| **T2V** | Text prompt | Video + audio | `TI2VidTwoStagesPipeline` |
| **I2V** | Text + image | Video + audio | `TI2VidTwoStagesPipeline` |
| **A2V** | Text + audio | Video | `A2VidPipelineTwoStage` |

```bash
# Basic text-to-video
run.py video generate --prompt "A frog meditating at sunrise" --audio-volume 50

# Image-to-video with reference
run.py video generate --prompt "Character waves" --input-image ref.png --audio-volume 50

# Audio-to-video
run.py video generate --prompt "Person dancing" --audio music.wav

# A/B test with parameter variations
run.py video generate --test-prompt frog-yoga --audio-volume 50 \
  --variations 3 --ab-params '{"cfg_scale":[3,5,7]}'
```

---

## Two-Stage Denoising

LTX-2.3 uses a **two-stage pipeline** — two sequential denoising passes that produce progressively higher quality output.

### Stage 1 — Coarse Generation (many steps)

- Runs `guided_denoise_loop` with many steps (default ~30) at **lower spatial resolution**
- Produces a rough video structure: composition, motion, timing
- **Also generates `audio_latent`** as a byproduct — the audio representation is entangled with video at this stage
- This is the "rough cut": the model figures out overall motion and the corresponding audio structure

### Stage 2 — Refinement (few steps)

- Takes stage-1 output and runs a **second denoising pass** with fewer steps (default ~3) at **full resolution**
- Produces the final high-quality video with fine detail
- **Also re-generates audio latent** — but stage-2 audio can be *worse* than stage-1 for some cases

### Why Two Stages?

The two-stage design separates **structure** from **detail**:

1. **Efficiency**: Stage 1 at low resolution with many steps explores the solution space cheaply. Stage 2 at full resolution with few steps adds detail without re-exploring.
2. **Audio entanglement**: Audio is generated jointly with video — it's not a separate pass. The audio latent emerges from the same transformer that produces video.
3. **Quality**: Single-pass generation at full resolution with 30+ steps is extremely expensive. Two stages achieve similar quality in less total compute.

### The `audio_stage1_only` Option

Stage 2's audio refinement sometimes degrades quality instead of improving it. The `--audio-stage1-only` flag captures the stage-1 audio latent before stage-2 overwrites it:

```bash
run.py video generate --prompt "Woman says hello" --audio-stage1-only --audio-volume 50
```

**How it works** (implemented in [`app/vendor_patches.py`](../app/vendor_patches.py) patch #6):
1. Temporarily wraps `guided_denoise_loop` to capture `output_1.audio_latent`
2. Lets stage 2 run normally (for video quality)
3. Discards stage-2 audio and returns the captured stage-1 audio instead

---

## Pipeline Architecture

```
Text prompt
    ↓
Gemma 12B text encoder
    ↓
dual projections: video (4096-d) + audio (2048-d)
    ↓
Embeddings1DConnector (8 blocks, 128 registers)
    ↓
Transformer (48 blocks, joint audio+video attention)
  ├── Self-attention (video tokens + audio tokens, separately)
  ├── Text cross-attention (video↔text, audio↔text)
  └── AV cross-attention (video↔audio, gated by av_ca_timestep_scale)
    ↓
  ┌──────────────────────┐     ┌──────────────────────┐
  │ Video latent         │     │ Audio latent          │
  │ (B, C, T, H, W)     │     │ (B, 8, T, 16)        │
  └──────────┬───────────┘     └──────────┬───────────┘
             ↓                            ↓
      Video VAE decode             AudioVAEDecoder
      (spatial upscaler)           → mel (B, 2, T', 64)
             ↓                            ↓
        MP4 frames              BigVGAN vocoder → 16kHz waveform
                                          ↓
                                   BWE (bandwidth extension) → 48kHz
                                          ↓
                                   Mux audio into MP4 via ffmpeg
```

### Key Parameters

| Parameter | Video | Audio | Notes |
|-----------|-------|-------|-------|
| `cfg_scale` | 5.0 (default) | 7.0 (hardcoded) | Audio CFG is not affected by `--cfg-scale` |
| `stg_scale` | 1.0 | 1.0 | Spatial-temporal guidance |
| `stage1_steps` | ~30 | ~30 | Coarse pass |
| `stage2_steps` | ~3 | ~3 | Refinement pass |
| `modality_scale` | 3.0 | 3.0 | Same |
| `stg_blocks` | [28] | [28] | Block index for STG |
| Token dimensions | 4096 (32 heads × 128) | 2048 (32 heads × 64) | Audio is half video dim |
| Audio tokens/sec | — | ~25 | `round(frames/fps * 25)` |

---

## Model Components

All LTX components are stored decomposed under `models/<category>/<instance>/` and assembled at load time via symlinks into a flat temporary directory (ltx-2-mlx expects a flat HF-repo layout).

| Component | Location | Files |
|-----------|----------|-------|
| **Transformer** (22B, Q8) | `models/transformer/ltx-2.3-dev-q8/` | `transformer-dev.safetensors`, `split_model.json` |
| **LoRA** (distilled) | `models/lora/ltx-2.3-distilled/` | `ltx-2.3-22b-distilled-lora-384.safetensors` |
| **Text Encoder** (Gemma connector) | `models/text_encoder/ltx-2.3-connector/` | `connector.safetensors`, `embedded_config.json` |
| **VAE** | `models/vae/ltx-2.3-vae/` | `vae_encoder.safetensors`, `vae_decoder.safetensors`, `spatial_upscaler_x2_v1_1.safetensors` |
| **Audio** | `models/audio/ltx-2.3-audio/` | `audio_vae.safetensors`, `vocoder.safetensors` |

### Model Loading Priority

1. **Explicit `--video-model` path** — user-specified directory
2. **Local components** — symlink assembly from `models/` subdirectories
3. **HF auto-download** — fallback to `dgrauet/ltx-2.3-mlx-q8` (~22 GB download)

### Symlink Assembly

```python
# ltx_pipeline.py creates /tmp/ltx2_XXX/ with symlinks:
/tmp/ltx2_XXX/
├── transformer-dev.safetensors → models/transformer/ltx-2.3-dev-q8/transformer-dev.safetensors
├── connector.safetensors       → models/text_encoder/ltx-2.3-connector/connector.safetensors
├── vae_decoder.safetensors     → models/vae/ltx-2.3-vae/vae_decoder.safetensors
├── audio_vae.safetensors       → models/audio/ltx-2.3-audio/audio_vae.safetensors
└── ... (all components)
```

Assembly dir is cleaned up on pipeline close / `__del__`. Block-streaming mode memory-maps weights lazily from these symlinks.

---

## Vendor Patches

The `vendor/ltx-2-mlx` submodule is kept at clean upstream HEAD. All local fixes are applied as **monkey-patches at import time** via [`app/vendor_patches.py`](../app/vendor_patches.py). This means `git submodule update --remote` always works without merge conflicts.

### Patch Summary

| # | Target | Issue | Fix |
|---|--------|-------|-----|
| 1 | `UpSample1d.__call__` | MLX 0.31.2 `.at[strided].add()` mis-indexes on Metal | Direct assignment on zeroed tensor |
| 2 | `HannSincResampler.__call__` | Same `.at[strided].add()` Metal bug | Same fix as #1 |
| 3 | `AudioVAEDecoder.decode` | Missing causal frame crop (off-by-3 frames) | Crop output to `T*4-3` matching upstream |
| 4 | `LTXModelConfig` | `av_ca_timestep_scale_multiplier` default 1.0 instead of 1000.0 | Override default + add `from_checkpoint_config()` classmethod reading `embedded_config.json` |
| 5 | `_orchestration.load_transformer` | Config not read from checkpoint metadata | New `_load_transformer_config()` reads `embedded_config.json` |
| 6 | `TI2VidTwoStagesPipeline` | No way to get stage-1 audio only | `audio_stage1_only` param via `guided_denoise_loop` capture |

### Critical Fix: av_ca_timestep_scale_multiplier (#4)

This is the most impactful patch. Without it, the AV cross-attention gate is attenuated by 1000×, effectively zeroing speech/lip-sync information:

```
av_ca_factor = av_ca_timestep_scale_multiplier / timestep_scale_multiplier

Buggy default:  1.0 / 1000.0 = 0.001  ← gate near zero (no audio↔video coupling)
Correct value: 1000.0 / 1000.0 = 1.0  ← full cross-modal attention
```

The correct value (1000.0) is stored in `embedded_config.json` inside the checkpoint. Patch #4 adds a `from_checkpoint_config()` classmethod, and patch #5 wires it into `load_transformer()`.

**Upstream issues:** [dgrauet/ltx-2-mlx#37](https://github.com/dgrauet/ltx-2-mlx/issues/37), [#36](https://github.com/dgrauet/ltx-2-mlx/issues/36)

---

## CLI Reference

### `run.py video generate`

| Flag | Default | Description |
|------|---------|-------------|
| `--prompt` | (required)* | Text prompt |
| `--prompt-file` | — | Read prompt from file |
| `--test-prompt` | — | Built-in test prompt (voice-test, frog-yoga, dialog-test, etc.) |
| `--width` | 704 | Frame width (must be divisible by 32) |
| `--height` | 480 | Frame height (must be divisible by 32) |
| `--frames` | 97 | Frame count (must satisfy 8k+1: 25, 33, 41, 49, …) |
| `--fps` | 24.0 | Output frame rate |
| `--seed` | 42 | Random seed |
| `--cfg-scale` | 5.0 | Classifier-free guidance (optimal: 5.0) |
| `--stg-scale` | 1.0 | Spatial-temporal guidance (essential: 1.0 for coherent motion) |
| `--stage1-steps` | ~30 | Override stage 1 denoising steps |
| `--stage2-steps` | ~3 | Override stage 2 refinement steps |
| `--input-image` | — | Reference image for I2V |
| `--audio` | — | Audio file for A2V |
| `--low-ram` | false | Block-streaming mode (~75% less RAM, slower) |
| `--audio-stage1-only` | false | Use stage-1 audio only |
| `--audio-volume` | — | Post-process audio gain (recommended: 50) |
| `--audio-cfg-scale` | — | Override audio CFG (default: 7.0 hardcoded) |
| `--first-frame` | false | Extract first frame as PNG |
| `--caption` | false | Extract frame + VLM caption |
| `--variations` | 1 | A/B test count |
| `--ab-params` | — | Per-variation overrides as JSON |

### Test Prompts

Built-in prompts with recommended defaults:

```bash
run.py video generate --test-prompt voice-test --audio-volume 50     # Close-up speech
run.py video generate --test-prompt frog-yoga --audio-volume 50      # Narrative dialog
run.py video generate --test-prompt dialog-test --audio-volume 50    # Two-person conversation
```

---

## Known Issues

### Audio Amplitude ~50× Too Quiet

**Root cause:** MLX Metal bf16 accumulates numerical divergence over 48 transformer blocks. The audio latent is in the wrong distribution (not just wrong scale), producing near-silent mel spectrograms.

**Workaround:** `--audio-volume 50` (post-process with ffmpeg). Peak goes from ~0.014 to ~0.58 — normal speech levels.

See [`docs/ltx-voice.md`](ltx-voice.md) for full investigation details.

### Audio Intelligibility

MLX speech is ~60% intelligible vs near-perfect in PyTorch. The 48-layer transformer accumulates precision differences — cosine similarity diverges at output layers. Acceptable for ambient sound and rough speech; not production-quality for dialog.

---

## Related Docs

- [`docs/ltx-voice.md`](ltx-voice.md) — Full audio investigation, A/B tests, bug details
- [`docs/models.md`](models.md) — Model directory layout and conversion
- [`app/vendor_patches.py`](../app/vendor_patches.py) — All 6 monkey-patches with inline docs
- [`app/ltx_pipeline.py`](../app/ltx_pipeline.py) — Pipeline wrapper (model loading, symlink assembly)
