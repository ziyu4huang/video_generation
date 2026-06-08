# FLF2V (First-Last Frame to Video) — LTX-2.3

**Last updated:** 2026-06-08 (CFG mechanism documentation added)

---

## Overview

FLF2V (First-Last Frame to Video) generates a video that **interpolates between two keyframe images** — a begin frame and an end frame. The model fills in the motion, transition, and audio between them.

| Attribute | Detail |
|-----------|--------|
| **Pipeline** | `KeyframeInterpolationPipeline` (from vendor `ltx-2-mlx`) |
| **Transformer** | Dev (`transformer-dev.safetensors`) — distilled model hallucinates during interpolation |
| **LoRA** | `ltx-2.3-22b-distilled-lora-384.safetensors` for stage-2 refinement |
| **Audio** | Auto-generated jointly with video (no input audio supported in FLF2V mode) |
| **Mode trigger** | `--begin-image` + `--end-image` |

```bash
# Basic FLF2V
run.py video generate \
  --begin-image frame_first.png \
  --end-image frame_last.png \
  --prompt "Character turns to camera and speaks" \
  --width 640 --height 960 --frames 241 --fps 24 \
  --audio-volume 50 --first-frame --yes
```

---

## ✅ What Works — Good Practices

### 1. Use Same Seed + Different Prompt + `--input` Reference

This is the **proven winning formula** (Experiment #5):

```bash
# Step 1 — Generate begin frame (free generation)
python/venv/bin/python run.py image generate \
  --pipeline zimage --width 640 --height 960 --steps 9 --seed 42 \
  --prompt-file app/prompts.md

# Step 2 — Generate end frame (different pose prompt, same seed, --input reference)
python/venv/bin/python run.py image generate \
  --pipeline zimage --width 640 --height 960 --steps 9 --seed 42 \
  --input output/<begin_frame>.png \
  --prompt '... (different pose/expression, SAME character/setting description)'

# Step 3 — Run FLF2V
python/venv/bin/python run.py video generate \
  --begin-image output/<begin_frame>.png \
  --end-image output/<end_frame>.png \
  --prompt "Description of motion/transition, she speaks softly" \
  --width 640 --height 960 --frames 241 --fps 24 \
  --stage1-steps 16 --stage2-steps 3 \
  --audio-volume 50 --first-frame --seed 42 --yes
```

Why each piece matters:

| Element | Why It's Critical |
|---------|-------------------|
| **Same seed** (42) | Keeps character facial features, hair, body identical across frames |
| **Different prompt** | Changes pose/expression (e.g., 趴着→抬头, 慌张→微笑) while describing the SAME character and setting |
| **`--input` reference** | Forces Z-Image to use Image 1's background/scene as visual anchor — guarantees consistent room, lighting, props |
| **cfg_scale=3.0** | Auto-set by CLI. Soft guidance allows natural interpolation (5.0 causes jarring jump cuts) |

### 2. Prompt Design for Keyframes

Both prompts must describe the **same character and setting** — only the pose/expression differs:

**Begin prompt** (趴在化妆台, 慌张):
```
构图：半身略俯拍，女孩跪坐在房间地毯上，上半身趴在化妆台边缘，
双手交叠垫着下巴，侧脸转向镜头，眼神有点慌张又有点倔强。
```

**End prompt** (抬头, 微笑, 准备说话):
```
构图：半身略俯拍，女孩跪坐在房间地毯上，上半身微微后仰离开化妆台，
一只手托着下巴，另一只手自然放在膝盖上，正脸直视镜头，
嘴角带笑，嘴唇微张像在说话。
```

Both prompts share:
- Same character description (服装、发型、妆容)
- Same setting (深夜自习室, same props, same lighting)
- Same camera angle (半身略俯拍)
- **Only the pose/expression differs**

### 3. Video Prompt for Speech

Include speech cues to trigger audio generation:
```
she adjusts her position slightly and looks at the camera with changing expression,
she speaks softly
```

---

## ❌ What Doesn't Work — Bad Practices to Avoid

### 1. Different Backgrounds → Black Transition ❌

When begin/end frames have **different rooms, lighting, or settings**, FLF2V cannot reconcile them. The model fades to **black frames** as the "safest" intermediate state.

| ❌ Causes Black Transition | Why |
|---------------------------|-----|
| Different rooms (化妆台 vs 书桌) | Model can't morph one scene into another |
| Different lighting (暖黄灯 vs 手机冷光) | Inconsistent light paths |
| Different props / table items | Scene doesn't match at keyframe anchors |
| Different camera angle | Model sees it as two different scenes |

**Experiment #1** (failure): Warm makeup-table vs cold study room → video faded to black between frames.

### 2. Same Seed + Same Prompt + `--input` → Too Similar ❌

If you use the same seed AND the same prompt AND `--input`, the output image is **nearly identical** to the begin frame. There's no visible pose change for FLF2V to interpolate.

**Fix**: Use a **different prompt** that describes a different pose/expression.

### 3. Different Seeds → Character Identity Diverges ❌

Using seed=42 for Image 1 and seed=99 for Image 2 causes:
- Different facial features
- Different hair details
- Slightly different body proportions

Even with `--input` reference, the different seed creates a noticeably different person. FLF2V then struggles because it's trying to interpolate between two different-looking characters.

**Experiments #3–#4** used seed=99 for Image 2 → character looked different, transition less natural.

### 4. cfg_scale=5.0 → "Forced Insertion" Jump Cuts ❌

The CLI default for T2V/I2V is cfg_scale=5.0, but FLF2V needs **3.0**. High CFG causes the model to aggressively follow the text prompt during interpolation, creating abrupt visual jumps ("forced insertion") instead of smooth transitions.

> **Important**: Lowering cfg_scale does **NOT** risk "not reaching the end frame." The end frame is guaranteed by the denoise mask system (see [Keyframe Enforcement vs Text Guidance](#keyframe-enforcement-vs-text-guidance-cfg) below). cfg_scale only controls *how* the model interpolates, not *whether* it arrives.

**This is now auto-fixed** — the CLI automatically sets cfg_scale=3.0 for FLF2V mode.

| cfg_scale | Interpolation Behavior | Still Reaches End Frame? | Use For |
|-----------|----------------------|--------------------------|---------|
| 5.0 | Aggressive text guidance → jarring jump cuts | ✅ Yes (but ugly path) | T2V, I2V |
| **3.0** | **Soft guidance → smooth natural transition** | ✅ Yes | **FLF2V** |
| 1.0 | No text guidance → model-driven interpolation | ✅ Yes (but may be incoherent) | Distilled mode |

### 5. Manually Matching Prompt Descriptions → Still Different ❌

Even if you carefully write two prompts that describe "the same room" in words, Z-Image will generate **different interpretations** — different furniture placement, different lighting angles, different prop positions. The `--input` reference technique is more reliable because it uses the actual pixels of Image 1.

**Experiment #2** (failure): Manually matched prompt descriptions for same study room → Z-Image generated different backgrounds anyway.

### Summary Table: Do's and Don'ts

| ❌ Don't | ✅ Do |
|----------|-------|
| Use different seeds for begin/end frames | Use same seed for both frames |
| Use same prompt for both frames (too similar) | Use different prompts (different pose/expression) |
| Describe same setting in words only | Use `--input` reference for pixel-level background match |
| Use cfg_scale=5.0 (causes jump cuts) | Let CLI auto-set cfg_scale=3.0 |
| Use different rooms/settings for each frame | Keep same room, same angle, same lighting |
| Large pose changes (趴着→坐着) | Gradual, natural changes (趴着→微微后仰) |

---

## Experiment Log

### Experiment #1 (2026-06-08): Background Mismatch → ❌ Black Transition

| Parameter | Value |
|-----------|-------|
| Image 1 | seed=42, 趴在化妆台, 暖黄灯 |
| Image 2 | seed=88, 坐在椅子上玩手机, 手机冷光 |
| cfg_scale | 5.0 |
| Result | Faded to black — completely different scenes |
| Wall time | ~16m08s (967s) |

**Lesson**: FLF2V cannot morph between different scenes. It uses black as the "safest" intermediate.

### Experiment #2 (2026-06-08): Manual Prompt Matching → ❌ Still Different

| Parameter | Value |
|-----------|-------|
| Image 1 | seed=42, manually written study room prompt |
| Image 2 | seed=88, manually matched study room prompt |
| cfg_scale | 5.0 |
| Result | Z-Image interpreted differently despite matching descriptions |
| Wall time | ~16m56s (1016s) |

**Lesson**: Word-level scene matching doesn't work. Use `--input` for pixel-level consistency.

### Experiment #3 (2026-06-08): Input Reference + Wrong Seed → ⚠️ Partial

| Parameter | Value |
|-----------|-------|
| Image 1 | seed=42, prompts.md |
| Image 2 | seed=**99**, same prompt, `--input Image1` |
| cfg_scale | 5.0 |
| Result | Background consistent but character diverged; forced insertion from high CFG |

**Lesson**: `--input` fixes background, but different seed breaks character identity.

### Experiment #4 (2026-06-08): cfg_scale Fixed + Still Wrong Seed → ⚠️ Better

| Parameter | Value |
|-----------|-------|
| Image 1 | seed=42, prompts.md |
| Image 2 | seed=**99**, same prompt, `--input Image1` |
| cfg_scale | **3.0** (auto-fixed) |
| Result | Smoother interpolation but character still diverged |
| Wall time | ~83 min (memory pressure anomaly in Stage 2) |

**Lesson**: cfg_scale=3.0 is correct for FLF2V. But seed mismatch still hurts.

### Experiment #5 (2026-06-08): Same Seed + Same Prompt + --input → ⚠️ Too Similar

| Parameter | Value |
|-----------|-------|
| Image 1 | seed=42, prompts.md |
| Image 2 | seed=**42**, **same prompt**, `--input Image1` |
| cfg_scale | 3.0 |
| Result | Images nearly identical — no visible pose change for FLF2V |
| Wall time | ~19 min |

**Lesson**: Same seed + same prompt = images too similar. Need different prompt for pose/expression change.

### Experiment #6 (2026-06-08): Same Seed + Different Prompt + --input → ✅ SUCCESS

| Parameter | Value |
|-----------|-------|
| Image 1 | seed=42, prompt-file (趴在化妆台, 慌张) |
| Image 2 | seed=**42**, **different prompt** (抬头直视, 微笑), `--input Image1` |
| cfg_scale | 3.0 (auto-set) |
| Result | **Very natural smooth transition** ✅ |
| Wall time | ~17.5 min |

**The winning formula confirmed:**
1. Same seed → identical character
2. Different prompt → different pose/expression
3. `--input` → identical background
4. cfg_scale=3.0 → smooth interpolation

---

## How FLF2V Works

### Architecture

Both keyframe images are encoded by the VAE and injected as **keyframe tokens** at fixed positions in the video latent sequence:

- **Begin frame** → keyframe index `[0]` (first frame)
- **End frame** → keyframe index `[last_pixel_frame]` (last frame)

The `KeyframeInterpolationPipeline` then runs two-stage denoising to fill in all intermediate frames, conditioned on:
1. The two keyframe images (visual anchor)
2. The text prompt (motion/speech direction)

### Keyframe Enforcement vs Text Guidance (CFG)

FLF2V uses **two orthogonal systems** that do not interact with each other:

| System | What It Controls | Mechanism | Parameters |
|--------|-----------------|-----------|------------|
| **Keyframe conditioning** | Model arrives at begin/end frame | `denoise_mask = 0.0` — keyframe latents are **never denoised**, deterministically preserved every step | `begin_strength`, `end_strength` |
| **Text guidance (CFG)** | How the model interpolates *between* keyframes | Scales `cond - uncond` text prediction | `cfg_scale` |

**Keyframe guarantee — how it works:**

Keyframe images are VAE-encoded and appended to the latent sequence as fixed tokens. During each denoising step, `apply_denoise_mask()` runs:

```
output = x0 * mask + clean * (1 - mask)
```

Since `mask = 0.0` for keyframe positions → `output = clean_latent` always. The keyframes are **locked in place** — no cfg_scale value can change this.

**CFG formula (text guidance only):**

```
pred = cond + (cfg_scale - 1) * (cond - uncond_text)
```

This scales only the text prompt influence. It does NOT scale keyframe conditioning. The two systems are completely independent.

**What this means for tuning:**

- Lowering cfg_scale from 5.0 → 3.0 → 1.0 **never risks losing the end frame**
- cfg_scale only changes the interpolation *path* (how natural/jarring the motion looks)
- cfg_scale=5.0: model aggressively follows text prompt → abrupt jump cuts (but still arrives at end frame)
- cfg_scale=3.0: soft text guidance → smooth natural transition ← **FLF2V sweet spot**
- cfg_scale=1.0: no text guidance → model still reaches end frame, but interpolation may be incoherent (model ignores the prompt entirely)

### Two-Stage Denoising

FLF2V uses the same two-stage approach as T2V/I2V:

| Stage | Purpose | Steps | Resolution |
|-------|---------|-------|------------|
| **Stage 1** | Coarse structure + motion interpolation | 16–20 (default 20 for dev) | Lower spatial |
| **Stage 2** | Detail refinement | 3 (default) | Full resolution |

Stage 1 uses the **dev transformer** (non-distilled, Q8 quantized ~20GB). Stage 2 applies the **distilled LoRA** on top for efficient refinement.

### Why Dev Transformer?

The distilled transformer is trained to generate from noise, not to interpolate between existing frames. When used for FLF2V it:
- Ignores keyframe conditioning
- Hallucinates random content
- Produces chaotic transitions

The dev transformer was used during the original keyframe interpolation training, so it respects the keyframe token positions correctly.

---

## Dimension Decision from Reference Images

When `--begin-image` / `--end-image` are provided, the CLI auto-fits the video resolution to the images before passing anything to the pipeline.

### Step 1 — Geometric-mean aspect ratio (`_fit_to_dual_images`)

```python
begin_ratio = begin_w / begin_h
end_ratio   = end_w / end_h
avg_ratio   = math.sqrt(begin_ratio * end_ratio)   # geometric mean
```

If the two images have very different ratios (>10% divergence) the CLI warns and uses the average anyway.

### Step 2 — 64-alignment (`_adjust_resolution`)

Both dimensions are rounded to the nearest multiple of **64** (two-stage pipeline requirement).

> **Why 64, not 32?** The pipeline computes `H_half = height // 2 // 32`. This floor-division chain only preserves the original dimension when `height` is divisible by 64. Heights divisible by 64 guarantee `H_half * 2 * 32 == height` exactly.

### Full Dimension Flow (640×960 example)

`--begin-image 640×960 --end-image 640×960 --frames 241` → CLI keeps `640×960`:

| Phase | Where | Operation | Latent shape | Pixel |
|-------|-------|-----------|-------------|-------|
| CLI auto-fit | `video-generate.py` | aspect match ✓ → `640×960` | — | 640 × 960 |
| Stage 1 | vendor | `half_h=480, half_w=320` → `H_half=15, W_half=10` | `(4, 15, 10)` | 320 × 480 |
| Keyframe encoding (S1) | vendor | images resized to `enc_h=480, enc_w=320` | — | 320 × 480 |
| **spatial_upscaler_x2** | vendor | denorm → 2× spatial → renorm | `(4, 30, 20)` | 640 × 960 |
| Stage 2 | vendor | `H_full=30, W_full=20` | `(4, 30, 20)` | 640 × 960 |
| Keyframe encoding (S2) | vendor | images resized to `enc_h=960, enc_w=640` | — | 640 × 960 |
| VAE decode | vendor | `(31-1)*8+1 = 241` pixel frames | — | **640 × 960** |

For more detail on the spatial upscaler denorm/renorm and timing, see [`docs/ltx-pipeline.md § Two-Stage Resolution Math`](ltx-pipeline.md#two-stage-resolution-math).

---

## Parameters

### FLF2V-Specific CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--begin-image` | (required) | First frame image path |
| `--end-image` | (required) | Last frame image path |
| `--begin-strength` | 1.0 | Begin frame conditioning strength (1.0 = exact match) |
| `--end-strength` | 1.0 | End frame conditioning strength (1.0 = exact, lower = more freedom) |

### Inherited Parameters

| Flag | FLF2V Default | Notes |
|------|--------------|-------|
| `--stage1-steps` | 20 (auto-set) | CLI auto-sets 20 when default 8 is unchanged |
| `--stage2-steps` | 3 | Refinement steps |
| `--cfg-scale` | 3.0 (auto-set) | CLI auto-sets 3.0 when default 5.0 is unchanged |
| `--stg-scale` | 1.0 | Same as other modes |
| `--audio-volume` | 50 (recommended) | Auto-generated audio is ~50× too quiet |
| `--frames` | 97 | 241 frames = 10s @ 24fps |
| `--seed` | 42 | Reproducibility |

### begin_strength / end_strength

- **1.0** (default): Strict adherence to the keyframe — the model tries to match the image exactly
- **0.8–0.9**: Slight relaxation — allows more creative motion while still anchoring to the keyframe
- **< 0.7**: Weak anchoring — keyframe becomes a "suggestion", may lose visual fidelity
- Lowering `end_strength` can help when the end pose is very different from begin, giving the model more room to find a path

### Audio Guider (Hardcoded)

The FLF2V pipeline uses separate guider params for video and audio:

| Parameter | Video Guider | Audio Guider |
|-----------|-------------|-------------|
| `cfg_scale` | 3.0 (from --cfg-scale) | 7.0 (hardcoded) |
| `stg_scale` | 1.0 | 1.0 |
| `rescale_scale` | 0.7 | 0.7 |
| `modality_scale` | 3.0 | 3.0 |
| `stg_blocks` | [28] | [28] |

---

## Performance

### Runtime Estimation

FLF2V uses **separate benchmark constants** from T2V/I2V because it runs the dev transformer (larger, ~28% slower per step than the distilled pipeline). The CLI automatically estimates runtime before generation.

**Benchmark constants** (calibrated on Apple Silicon MPS, LTX-2.3 22B Q8):

| Constant | FLF2V (dev) | T2V/I2V (distilled) |
|----------|-------------|---------------------|
| Stage 1 slope | 0.303 s/Mpx/step | 0.237 s/Mpx/step |
| Stage 2 slope | 0.561 s/Mpx/step | 0.495 s/Mpx/step |
| Decode slope | 0.274 s/Mpx | 0.251 s/Mpx |
| Fixed overhead | 7.0 s | 7.4 s |

**Formula**: `total = stage1_steps × S1_SLOPE × mpx + stage2_steps × S2_SLOPE × mpx + DECODE × mpx + OVERHEAD`

Where `mpx = width × height × frames / 1,000,000`.

### Typical Performance (640×960, 241 frames)

| Metric | Value |
|--------|-------|
| Stage 1 | 16 steps × ~45 s/it = **~12 min** |
| Stage 2 | 3 steps × ~87 s/it = **~4.5 min** |
| VAE decode + mux | ~40s |
| **Total wall time** | **~17–19 min** |
| Peak RAM | 20.6 GB |

> **Note:** Experiment #4 had an anomalous Stage 2 (~65 min) due to memory pressure / swap. This is NOT typical. Normal runs are ~17–19 min total.

---

## Audio in FLF2V

### How It Works

Audio is **auto-generated** jointly with video during denoising — no `--audio` input file is needed or supported in FLF2V mode. The audio latent emerges from the same transformer that produces video frames.

### Volume Fix

Like T2V/I2V, FLF2V audio is ~50× too quiet due to Metal bf16 numerical divergence over 48 transformer blocks:

```bash
--audio-volume 50  # Required for audible speech
```

### Speech Intelligibility

Same as T2V: ~60% intelligible on MLX. The speech quality is not affected by FLF2V mode specifically — it shares the same audio pipeline.

### Triggering Speech

To get the model to generate speech audio:
1. **Include speech cues in the video prompt**: "she speaks softly", "says hello", "talking to camera"
2. **End frame with open mouth**: A keyframe showing the character with lips slightly parted encourages the model to animate speech

---

## Implementation Details

### Pipeline Construction

```python
# app/ltx_pipeline.py:346
KeyframeInterpolationPipeline(
    model_dir=model_dir,
    low_memory=True,
    low_ram_streaming=low_ram,
    dev_transformer="transformer-dev.safetensors",
    distilled_lora="ltx-2.3-22b-distilled-lora-384.safetensors",
)
```

The pipeline is built lazily on first FLF2V call and cached. Switching to T2V/I2V mode rebuilds the pipeline.

### Keyframe Injection

```python
# app/ltx_pipeline.py:327-343
pipeline.generate_and_save(
    prompt=prompt,
    output_path=output_path,
    keyframe_images=[begin_image, end_image],
    keyframe_indices=[0, last_pixel_frame],       # [0, N-1]
    keyframe_strengths=[begin_strength, end_strength],
    height=height,
    width=width,
    num_frames=num_frames,
    frame_rate=frame_rate,
    seed=seed,
    stage1_steps=stage1_steps,
    stage2_steps=stage2_steps,
    cfg_scale=cfg_scale,
    video_guider_params=video_gp,
    audio_guider_params=audio_gp,
)
```

---

## Related Docs

- [`docs/ltx-pipeline.md`](ltx-pipeline.md) — Full LTX-2.3 pipeline architecture, T2V/I2V modes
- [`docs/ltx-voice.md`](ltx-voice.md) — Audio investigation, amplitude fix, intelligibility analysis
- [`app/ltx_pipeline.py`](../app/ltx_pipeline.py) — Pipeline wrapper with `generate_flf2v()` (line 256)
- [`app/vendor_patches.py`](../app/vendor_patches.py) — All monkey-patches including av_ca_timestep_scale fix
