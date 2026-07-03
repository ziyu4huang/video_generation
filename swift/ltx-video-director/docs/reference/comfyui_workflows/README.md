# ComfyUI reference workflows (transferred 2026-07-03)

Source: `/Users/huangziyu/proj/WhatDreamsCost-ComfyUI/example_workflows/` (a
separate checkout of the `WhatDreamsCost-ComfyUI` LTX-2.3 node pack's example
workflows — not part of this repo's own history). Copied here verbatim as
reference material for scoping `native-i2v`/`native-upscale`'s remaining
gaps against a real, community-maintained production pipeline. These are
ComfyUI node-graph JSON, not runnable by this Swift package directly — the
value is the pipeline STRUCTURE and PARAMETERS, extracted below.

| File | What it shows |
|------|----------------|
| `LTX I2V FFLF Custom Audio Workflow ... V3.json` | First+Last-Frame conditioning + user-supplied audio track injection |
| `LTX I2V First Last Frame 2 Stage Workflow v6.json` | FFLF + base gen + one upscale/refine stage |
| `LTX I2V First Last Frame 3 Stage Workflow v6.json` | FFLF + base gen + two upscale/refine stages (1.5x then 2x, or straight to 2x) |
| `LTX_Director_2_Workflow_Hotfix.json` | A different node pack (`LTXDirector`/`LTXDirectorGuide`/`LTXDirectorCropGuides`) — same LTX-2.3 model, alternate guide-crop mechanism. Not analyzed in depth below (name collision with this repo is coincidental — unrelated project). |

All four use ComfyUI's subgraph feature (`definitions.subgraphs`) — the
top-level `nodes` array is mostly subgraph *instances* (referenced by UUID
`type`), so the real pipeline structure lives in `definitions.subgraphs`.

## Pipeline structure (FFLF workflows, 2-stage and 3-stage)

```
Model Loader ─┬─ CheckpointLoaderSimple (ltx-2.3-22b-dev-fp8.safetensors)
              ├─ LTXAVTextEncoderLoader (gemma_3_12B_it_fp4_mixed + dev checkpoint)
              ├─ LoraLoaderModelOnly (ltx-2.3-22b-distilled-lora-...bf16.safetensors, strength 0.5)
              ├─ VAELoaderKJ x3 (audio / video / "tiny" preview VAE)
              └─ LatentUpscaleModelLoader (ltx-2.3-spatial-upscaler-x2-1.1.safetensors)

MultiImageLoader ─→ first/last frame images (lanczos resize, "keep proportion", 32-multiple)

Process Latents ─┬─ EmptyLTXVLatentVideo (width, height, batch, ...)
                 ├─ LTXVEmptyLatentAudio
                 └─ ImageScaleBy (0.5x — half-res preview/guide pass)

Stage #1 (base generation, 8 steps, cfg=1, linear_quadratic schedule)
    KSamplerSelect(euler) → BasicScheduler(linear_quadratic, steps=8, shift=1)
    → CFGGuider(cfg=1) → SamplerCustomAdvanced → LTXVSeparateAVLatent

Stage #2 (upscale + refine, 6 steps, cfg=1, denoise≈0.42)
    LTXVLatentUpsampler (neural 2x upscale, same class as this package's
      LatentUpsampler.swift) → LTXSequencer (per-block sigma/denoise-mask
      schedule — NOT a single scalar denoise, a per-segment array) →
      BasicScheduler(linear_quadratic, steps=6, shift=0.42) → CFGGuider(cfg=1)
      → SamplerCustomAdvanced (LOW-strength refinement denoise, not a fresh
      noise-to-clean pass) → LTXVSeparateAVLatent

Stage #3 (3-stage workflow only — second upscale + refine, 4 steps, denoise≈0.42)
    LatentUpscaleModelLoader (ltx-2.3-spatial-upscaler-x1.5-1.0.safetensors —
      a DIFFERENT, 1.5x variant, distinct from Stage #2's x2-1.1) →
      LTXVLatentUpsampler → LTXSequencer → BasicScheduler(steps=4, shift=0.42)
      → CFGGuider(cfg=1) → SamplerCustomAdvanced → LTXVSeparateAVLatent
    (a PrimitiveBoolean toggle switches this stage between 1.5x and 2x total)

Decode: LTXVSeparateAVLatent → VAEDecode/VAEDecodeTiled (video) +
    LTXVAudioVAEDecode (audio) → CreateVideo → SaveVideo
```

## What this confirms/extends about this package's own port

1. **`NativeUpscaleStage`'s "no refine pass" gap is exactly Stage #2/#3
   above**, now with real numbers: the neural upscale (`LatentUpsampler`,
   already ported) is followed by a LOW-STRENGTH denoise refinement —
   `linear_quadratic` schedule at **6 steps / shift 0.42** for the first
   upscale stage, **4 steps / shift 0.42** for a second one — NOT a fresh
   generation. This is a bounded, well-specified follow-up: reuse
   `DenoiseLoop`/`SigmaSchedule` (already ported) with a short partial-denoise
   schedule starting from the upscaled latent instead of pure noise, rather
   than new architecture work.
2. **This package's choice of `spatial_upscaler_x2_v1_1.safetensors` matches
   the workflow's own recommendation** — its embedded FAQ note explicitly
   calls v1.1 "the newest version," confirming the checkpoint choice
   `NativeUpscaleStage` already made is current best practice, not stale.
   A 1.5x variant (`ltx-2.3-spatial-upscaler-x1.5-1.0.safetensors`) also
   exists for a lighter Stage #3 — not currently in `mlx-models/`, not
   ported.
3. **Real-world LoRA usage validates this session's `--lora path:strength`
   work**: this workflow applies the distilled LoRA via `LoraLoaderModelOnly`
   at **strength 0.5**, not the default 1.0 our `NativeI2VStage` bakes in via
   the pre-fused checkpoint — i.e. production pipelines DO run the distilled
   LoRA at partial strength on top of the "dev" base, which is precisely the
   `strength` parameter `LoRAFusion`/`--lora` already support (see this
   session's earlier milestone). Not wired to a specific feature yet — noted
   for whenever a "dev + partial distilled LoRA" mode is wanted instead of
   the pre-fused distilled checkpoint.
4. **First-Last-Frame (FFLF) conditioning is a real, NOT-yet-ported
   capability**: `MultiImageLoader` feeds two images (first + last) into the
   conditioning path, vs. this package's `NativeI2VStage`/
   `VideoConditionByLatentIndex(frameIndices: [0], ...)` which only
   conditions frame 0. Porting FFLF would mean conditioning BOTH frame 0 and
   the last frame's latent index — `VideoConditionByLatentIndex` already
   accepts a `frameIndices: [Int]` array (not hardcoded to `[0]`), so the
   conditioning mechanism itself may already generalize; what's missing is
   (a) a second image input + VAE-encode call in `NativeI2VStage`, and (b)
   confirming the guide-crop/sequencer interaction (`LTXVCropGuides`,
   `LTXSequencer`) doesn't need porting too for correct results at the seam.
   Not attempted this session — flagged as the next concrete scope item if
   FFLF is wanted.
5. **Custom audio injection** (`Custom Audio` subgraph): encodes a
   user-supplied audio waveform via `LTXVAudioVAEEncode` + masks its noise
   out (`SetLatentNoiseMask`) so it's preserved through the denoise loop —
   conceptually the audio-modality analogue of `VideoConditionByLatentIndex`/
   `applyDenoiseMask` (already ported for video). Not implemented for audio
   in this package (`NativeI2VStage` always generates audio from scratch,
   never accepts a real audio track as input) — same mechanism would apply
   if wanted.

None of items 4/5 were implemented this session (each is its own scoped
port, not a same-session addition to the LoRA/upscale/resolution work this
`/goal` already covered) — this document exists so that scope is captured
accurately for whenever they're picked up, instead of being re-discovered
from scratch.
