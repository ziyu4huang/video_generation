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

## Second pass (2026-07-04) — status check + previously-unexplored `LTXDirector` pack

Items 1, 3, 4, 5 above are now DONE (confirmed against this package's own
code, not re-guessed): the upscale refine pass, `--lora path:strength`,
FFLF (`--last-frame`), and `--audio-track` noise-masking all shipped in the
2026-07-03 "native VAE tiling, upscale+refine, LoRA fusion, FFLF, custom
audio" milestone. Re-verified live against `NativeI2VStage.swift`/
`NativeUpscaleStage.swift`/`LatentConditioning.swift`: `--audio-track`
genuinely uses the mask=0-preserve mechanism this doc predicted
(`VideoConditionByLatentIndex(..., strength: 1.0)` → `applyDenoiseMask`
forces the audio tokens back to the clean input after every step — the
real analogue of ComfyUI's `SetLatentNoiseMask`+`SolidMask`, not a
post-hoc waveform overwrite).

What's genuinely new this pass — either not looked at before, or looked at
but not acted on:

1. **True N-stage cascade is still NOT ported — only a single refine pass
   is.** Item 1 above was resolved as "one upscale + one low-strength
   refine," which is exactly Stage #2. The 3-stage workflow chains a
   SECOND upscale+refine (Stage #3: a *different* 1.5x checkpoint,
   `ltx-2.3-spatial-upscaler-x1.5-1.0.safetensors` — not the x2 model used
   twice — at 4 steps/shift 0.42, with a `PrimitiveBoolean` toggle to pick
   1.5x-total vs 2x-total, and a `LazySwitchKJ` bypass to skip it
   entirely). `NativeUpscaleStage.refine()` isn't structured to be called
   twice with a different upscaler + progressively fewer steps — it would
   need a chain/loop, not new sampling math (the schedule math is already
   ported). Not needed until someone asks for >2x total upscale in one
   command; noted so the shape carries over from the reference cleanly
   when it is.
2. **Tiny/fast preview VAE (`taeltx2_3.safetensors`) — never previously
   captured.** Every reference workflow loads THREE VAEs (audio, full
   video, and this "tiny" one) plus a `PrimitiveBoolean` "Use Optimized
   Decoding" toggle in the `Decode` subgraph. This package has exactly one
   VAE decode path (the full checkpoint, tiled for memory, not speed) in
   both `NativeI2VStage` and `NativeUpscaleStage` — no lightweight preview
   option. Concrete idea: a `--preview-vae` (or similar) flag that decodes
   through a distilled/tiny VAE for a fast low-fidelity look before
   committing to the full decode — useful for iterating on seed/prompt
   before paying the full VAE cost, and a natural fit for a GUI "quick
   preview" button. Scoped, not started.
3. **Multi-keyframe insertion beyond FFLF's 2 frames — genuinely open.**
   `MultiImageLoader` + `LTXSequencer` support inserting arbitrarily many
   images at arbitrary frame indices OR by seconds, each with its own
   per-slot strength — FFLF (frame 0 + last frame only) is the special
   case with just 2 slots. Confirmed (via code read) this doesn't need new
   conditioning machinery: `VideoConditionByLatentIndex` already takes
   `frameIndices: [Int]` and applies per-call `strength` — `NativeI2VStage`
   would just need `lastFrameImagePath: URL?` generalized to something like
   `keyframes: [(imagePath: URL, frameIndex: Int, strength: Double)]` and a
   CLI surface for it (repeatable `--keyframe path:index[:strength]`,
   mirroring the existing `--lora path:strength` spec-string convention).
   Not started — no concrete use case has asked for >2 keyframes yet.
4. **`LTX_Director_2_Workflow_Hotfix.json` — the one file explicitly
   flagged "not analyzed in depth" last time — is the closest existing
   reference for this repo's own `run.py video segment`/`relay`/`vbvr`
   commands, still un-ported to native Swift** (see
   `project_ltx_swift_native_port` memory: "transformer/encoder/audio
   remain" — segment/relay specifically were never scoped against a real
   reference before). Its `LTXDirector` node is a full timeline editor, not
   a simple FFLF workflow: JSON config carries `segments`/`motionSegments`/
   `audioSegments` arrays (independent per-modality tracks, each entry
   presumably `{start, length, prompt, strength}` — empty in this example's
   default state) plus a **"retake" mechanism**
   (`retakeMode`/`retakeStart`/`retakeLength`/`retakePrompt`/
   `retakeStrength`/`retakeVideo`) that re-denoises a specific sub-range of
   an ALREADY-GENERATED video at a given strength, driven by a new prompt
   — i.e. partial regeneration of one segment without redoing the whole
   clip. `LTXDirectorGuide` nodes (2 present, strengths 1.0 and 0.5) feed
   per-segment reference images, each independently weighted — the
   generalized version of idea 3 above, but wired through a segment/track
   model instead of a flat keyframe list. `LTXDirectorCropGuides` (2
   instances) removes the guide/reference frames from the final decoded
   output before muxing — this pack DOES crop guides, unlike the FFLF pack
   (which this repo's own FFLF milestone confirmed doesn't need cropping
   at current scope — still true, not contradicted). **Relevance**: this
   is the first concrete, real-production shape to scope
   `video segment`/`relay` porting against, once that becomes the active
   goal — the "retake a sub-range at strength X with a new prompt" pattern
   maps directly to a native `VideoConditionByLatentIndex`-based partial
   re-denoise over an existing decoded (then re-encoded) clip range, same
   primitive already used for FFLF/audio-track, applied to a mid-clip
   range instead of frame 0/last-frame. Not started — flagged as the
   concrete starting point for whenever `run.py`'s `segment`/`relay`
   subcommands get their native Swift port.

Net: nothing in this second pass required immediate code changes — it's
scope-capture for genuinely open follow-ups (items 1-4 above), confirming
work already done (items 1/3/4/5 from the first pass) rather than
re-discovering it from scratch.
