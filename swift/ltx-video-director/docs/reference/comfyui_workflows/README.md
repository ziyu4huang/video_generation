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

## Official Lightricks reference workflows (added 2026-07-04)

Source: `https://github.com/Lightricks/ComfyUI-LTXVideo/tree/master/example_workflows/2.3`
— the model author's own official example workflows (flat node graphs, no
subgraph indirection), fetched via public raw GitHub URLs, no auth required.
Added while investigating three RunningHub AI Apps marketplace listings
("Dasiwa V2", "Sulphur" prompt-optimized/distilled LTX2.3 apps) whose actual
workflow JSON is paywalled behind a group/coaching signup (confirmed via
each page's `og:description`: "Join the group to unlock ... download
workflows of this collection" + a Feishu-wiki signup link) — not pursued
further since that's a paid-community gate, not a login/registration one.
`Dasiwa` and `Sulphur` are public community terms independent of RunningHub
(DaSiWa = darksidewalker's LTX-2 LoRA/workflow pack on Civitai; Sulphur =
Winnougan's Sulphur-2 LTX-2.3 style LoRA on HuggingFace/Civitai) — the
official Lightricks base workflows below cover the same underlying node
plumbing those apps are built on, without needing either paywall.

| File | What it shows |
|------|----------------|
| `LTX-2.3_T2V_I2V_Single_Stage_Distilled_Full.json` | Base T2V/I2V + audio, single stage, no upscale — matches this package's `NativeI2VStage` core path node-for-node (`LTXVImgToVideoConditionOnly`, `LTXVSeparateAVLatent`/`LTXVConcatAVLatent`, `LTXVAudioVAELoader`/`Decode`). |
| `LTX-2.3_T2V_I2V_Two_Stage_Distilled.json` | Adds `LTXVLatentUpsampler` + `LatentUpscaleModelLoader` second pass — matches the just-landed `NativeUpscaleStage.generate(secondStage:)` cascade; useful as an **official** cross-check against the community `WhatDreamsCost` 2-/3-stage files already used to build it. |
| `LTX-2.3_ICLoRA_Pixel_Spatial_Upscaler_Distilled.json` | A *different* upscale mechanism: `LTXICLoRALoaderModelOnly` + `LTXAddVideoICLoRAGuide` + `LTXVCropGuides` conditioning a video-to-video pass, not the neural-latent-upsampler path. Not yet ported. |
| `LTX-2.3_T2A_Single_Stage_Distilled.json` | **Pure text-to-audio, no video at all** — `LTXVAudioOnlyEmptyVideoLatent` + `LTXVAudioOnlyModel` replace the video latent/model entirely. A genuinely new, previously-undocumented gap: no video decode, no `LTXVImgToVideoConditionOnly`, no `CreateVideo`/`SaveVideo` — just `PreviewAudio`. Smallest and most cleanly scoped of the new findings here. |
| `LTX-2.3_ICLoRA_Motion_Track_Distilled.json` | IC-LoRA conditioning driven by `LTXVDrawTracks`/`LTXVSparseTrackEditor` (sparse point-track motion control) — same `LTXICLoRALoaderModelOnly`/`LTXAddVideoICLoRAGuide` family as the upscaler above. |
| `LTX-2.3_ICLoRA_Union_Control_Distilled.json` | Same IC-LoRA family, guided by `CannyEdgePreprocessor` + `DWPreprocessor` (pose) + `VideoDepthAnythingProcess` — a multi-modal ControlNet-equivalent for LTX-2.3. |
| `LTX-2.3_ICLoRA_Lipdub_Two_Stage_Distilled.json` | Same IC-LoRA family + `LTXVAudioVAEEncode`/`LTXVSetAudioRefTokens` — audio-driven lip-sync conditioning, two-stage (base + upscale). |

**Net finding**: all five IC-LoRA workflows (upscaler/motion-track/union-
control/lipdub, plus this repo's already-known `--mode hd` restoration
IC-LoRA) share one general mechanism — `LTXICLoRALoaderModelOnly` +
`LTXAddVideoICLoRAGuide` + `LTXVCropGuides` conditioning a *video* (not
image) input — that this package has never ported in general form, only
the one specific restoration application. Porting the general IC-LoRA
video-conditioning primitive once would unlock all four control modes as
thin call-site variations, rather than requiring four separate ports. This
is a bigger, multi-session-shaped item — see `PLAN.md` backlog, not picked
as the immediate next goal because of that size, in favor of the smaller
`T2A` (pure text-to-audio) gap.

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

## Third pass (2026-07-04) — exhaustive function audit of `LTX I2V FFLF Custom Audio Workflow ... V3.json` specifically

Driven by `/goal verify if we have implemented all function of the ComfyUI
workflow`. Unlike the first two passes (structural overviews across all 4
files), this pass went node-by-node through ONE specific file end to end
and cross-checked every parameter against the current Swift source, to
answer "have we actually covered everything this file does," not just
"what interesting ideas does it contain."

**Correction to the first pass**: this V3 file has only **Stage #1 and
Stage #2** subgraphs — no Stage #3. The "6 steps/shift 0.42" figure quoted
for Stage #2 in the first pass's pipeline diagram belongs to the *sibling*
3-stage workflow; this file's own Stage #2 `BasicScheduler` is
**`linear_quadratic, 4 steps, shift 0.42`**. Worth flagging since it's easy
to conflate parameters across the 4 files when they share subgraph names.

**Confirmed IMPLEMENTED, matching**: euler sampler; Stage #1's
`linear_quadratic`/8-steps/shift-1 schedule (`SigmaSchedule.distilledSigmas`);
`LTXVLatentUpsampler` 2x (`NativeUpscaleStage.swift`); the
`spatial-upscaler-x2-1.1` checkpoint choice; `--lora path:strength` as a
mechanism; the Gemma-3-12b text encoder; audio+video VAE loading; custom
audio's `SetLatentNoiseMask`/mask=0-preserve mechanism
(`VideoConditionByLatentIndex` + `applyDenoiseMask`); FFLF's first+last
frame conditioning; the H.264+AAC mp4 mux (`MP4Writer.swift`); CFG=1
(implicit — Swift has no negative-conditioning branch at all, which is
equivalent to this workflow's `CFGGuider(cfg=1)`, not a gap).

**Confirmed IMPLEMENTED, but with a differing default/formula** (working as
designed, not bugs): `--lora` defaults to a pre-fused distilled checkpoint
at effective strength 1.0, vs. the workflow's dev-checkpoint + 0.5-strength
LoRA (pass-1 item 3, still not wired to a specific mode); `--seconds` snaps
to LTX's 8k+1 frame stride vs. the workflow's plain `seconds*fps+1`; default
640×960 vs. the workflow's 768×512.

**Newly found gaps this pass** (not previously captured in passes 1/2):
1. **`LTXSequencer`'s per-frame denoise-mask array in Stage #2 isn't
   ported** — `NativeUpscaleStage.refine()` applies a single uniform
   mask=1 (full-strength refine) across every frame, not the reference's
   per-segment strength schedule. This is a different, smaller gap than
   the "no N-stage cascade" gap already known from the second pass — it's
   about *per-frame* refine strength within the ALREADY-ported single
   refine pass, not about chaining multiple passes.
2. **`ImageScaleBy(bilinear, 0.5)` half-resolution guide/preview pass in
   `Process Latents`** — the reference generates a cheap half-res pass
   before the real generation (likely for a fast preview/guide signal);
   `NativeI2VStage` generates directly at target resolution with no
   equivalent lower-res pre-pass. Unclear if this is purely a UI/preview
   convenience in ComfyUI or feeds back into generation quality — worth
   understanding the reference's actual data-flow before deciding whether
   to port it.
3. **FFLF's per-slot strength, resize-mode, and crop-position aren't
   ported** — `MultiImageLoader` supports resizing/cropping input images
   to fit (`bicubic`/`lanczos`, `center` crop) and a per-image conditioning
   strength; `NativeI2VStage.Request.lastFrameImagePath` requires the input
   to already be EXACTLY `width`×`height` (fails fast otherwise — this
   package's established "don't silently degrade on mismatched input"
   convention) and hardcodes strength 1.0. This extends the previously-known
   ">2 keyframes" gap (second pass, item 3) with two more dimensions:
   even for the 2-keyframe FFLF case, per-image strength and auto-resize
   aren't there.
4. **`VAEDecodeTiled`'s spatial tile/overlap parameters (512px tile,
   128px overlap) are architecturally different from this package's own
   tiling** — `VideoDecodeTiling.computeAuto` tiles temporally
   (frame-chunked, memory-budgeted), not spatially. Not necessarily a
   functional gap (both approaches target the same "don't blow up memory
   on long/large decodes" goal) but worth knowing they're different
   strategies if a spatial-tiling-specific artifact ever needs debugging.

**Still open from earlier passes, reconfirmed present in this specific
file**: the tiny/optimized preview VAE toggle (second pass item 2) and the
dev+partial-LoRA mode (first pass item 3) are both used by this exact
workflow, not just the sibling ones.

**Not applicable** (ComfyUI graph plumbing with no Swift-CLI equivalent to
check): `SamplerCustomAdvanced`/`LTXVSeparateAVLatent`/`LTXVConcatAVLatent`
(covered by Swift's joint AV denoise+decode), `ConditioningZeroOut` (moot
under CFG=1), `LazySwitchKJ` bypass toggles (covered by flag
presence/absence), `GetImageSize`/`CM_IntToFloat` (graph-internal type
plumbing).

Net: no code changed this pass — pure verification. Four newly-identified
gaps (1-4 above) added to the backlog; everything else this specific file
exercises is either already implemented or already tracked from the first
two passes.

## Fourth pass (2026-07-04) — closing all four third-pass gaps

Driven by `/goal solve this gaps`. Two of the four gaps turned out to be
misreadings once actually investigated properly, rather than guessed from
widget-value arrays alone — worth recording HOW they were resolved, not
just the resolution.

**Gap 1 (FFLF per-slot strength/resize) — genuinely was a gap, fixed as
described.** `NativeI2VStage.Request.lastFrameStrength: Float = 1.0` and
`lastFrameAutoResize: Bool = false` added. The conditioning code was
restructured: frame-0 and the last-frame image are now each their own
`VideoConditionByLatentIndex` call, applied in sequence (`videoState` is
threaded through both), instead of one call sharing a single `strength`
across concatenated tokens — chaining two single-frame-index calls is
equivalent to one two-index call when neither changes sequence length, so
this is a pure refactor plus a new independent knob, not a behavior change
to the frame-0 path. `FrameLoad.resizeAspectFillCenterCrop` added
(aspect-fill + center-crop via `CGContext.interpolationQuality = .high`,
matching the reference `MultiImageLoader`'s "keep proportion" + crop
convention). New CLI: `--last-frame-strength`, `--last-frame-auto-resize`.

New tests in `NativeI2VStageFFLFTests.swift`, both against real
checkpoints:
- `testLastFrameAutoResizeAcceptsWrongSizeAndStillPreservesContent`: a
  solid-color image at the WRONG size and WRONG aspect ratio (exercises
  both the resize and crop paths) still passes with
  `--last-frame-auto-resize` and the decoded output matches the pinned
  color within the same tight tolerance as the exact-size case — a solid
  color is invariant under resize/crop, so this isolates "did auto-resize
  actually run" from "how much loss does resizing introduce." 56.9s.
- `testLastFrameStrengthBelowOneDivergesFromFullyPinnedResult`: runs the
  same clip at `strength=1.0` (must match the existing tight tolerance)
  and `strength=0.0` (fully generated, no pinning) and asserts the
  strength=0.0 result diverges from the solid-color target MORE than
  strength=1.0 does — proves strength actually changes behavior, not just
  that it doesn't crash. 353.4s (two full real generations).

**Gap 2 (half-res `ImageScaleBy` "guide pass") — was a misread; traced the
actual link graph instead of trusting widget values.** The nodes
`GetImageSize`/`ImageScaleBy(bilinear, 0.5)` looked, from widget values
alone, like a mysterious lower-resolution preview/guide pass. Reading the
`links` array in the raw JSON instead shows: `ImageScaleBy`'s output feeds
`GetImageSize`, whose width/height outputs feed `EmptyLTXVLatentVideo`'s
width/height inputs DIRECTLY. This is pure resolution auto-derivation —
the reference computes its BASE generation resolution as half the user's
FFLF input image size, relying on Stage #2's 2x upscale to bring the final
output back to that image's own resolution. Not a quality/preview pass at
all. Implemented the equivalent as a CLI convenience:
`native-i2v --last-frame-derives-resolution` derives `--width`/`--height`
from half the `--last-frame` image's own dimensions (`ResolutionResolver
.optimize`-snapped to the nearest 32), overriding any explicit
`--width`/`--height`. Implies `--last-frame-auto-resize` automatically
(the full-resolution image must still be downscaled to the derived base
resolution to serve as I2V conditioning) — this coupling is load-bearing,
not optional, so it's enforced in code rather than left to the user to
remember.

**Gap 3 (`LTXSequencer`'s "per-frame denoise-mask schedule") — was a
misread from a different angle: the JSON alone can't distinguish "per-frame
refine schedule" from "keyframe re-insertion," so the earlier passes'
interpretation was wrong.** Found and read the ACTUAL node source,
`ltx_sequencer.py`, from the `WhatDreamsCost-ComfyUI` checkout (not
available in this repo — a separate project checkout on the same
machine): `class LTXSequencer(LTXVAddGuide)` — it's literally the SAME
`MultiImageLoader`/keyframe-insertion mechanism as `Process Latents`'s FFLF
conditioning, just called again inside Stage #2/#3 to RE-APPLY those same
first/last-frame guides onto the newly-upscaled latent (`append_keyframe`
splices clean tokens + sets a noise mask at each guide's frame index,
architecturally identical to this package's own
`VideoConditionByLatentIndex`). Not a novel per-frame refine-strength
schedule at all.

This correction exposed the REAL, previously-undocumented gap underneath
it: `NativeUpscaleStage.refine()` had NO re-pinning mechanism whatsoever —
an FFLF-conditioned clip's first/last frames could silently drift during
the refine pass's low-strength re-denoise, since refine's mask was
uniformly 1.0 (fully re-denoise) everywhere. Fixed: `refine()` gained
`preserveFirstAndLastFrame: Bool = false`; when true, it re-applies
`VideoConditionByLatentIndex(frameIndices: [idx], strength: 1.0)` at
frames `[0, F-1]` using the clean tokens FROM THE JUST-UPSCALED LATENT
ITSELF (not the original conditioning images — the upscaled latent's
frame-0/frame-(F-1) already represent the pinned content at the new
resolution; this only needs to stop the refine denoise from letting that
content drift, not re-derive it from scratch). `generate()` gained the
same parameter, threaded through. Wired at two call sites:
`native-i2v --upscale --refine --last-frame` (automatic — the CLI already
knows `--last-frame` was given) and standalone
`native-upscale --preserve-first-last-frame` (opt-in, for the case where
`native-upscale` runs separately against a frame directory that was
FFLF-conditioned by an earlier `native-i2v --last-frame` call and the CLI
has no way to know that on its own).

**Gap 4 (spatial vs. temporal VAE-decode tiling) — confirmed NOT a
functional gap, no code change.** `VideoTiling.swift`'s own file header
(written when temporal tiling was first ported) already states: "spatial
tiling exists there but is never auto-selected" — referring to the
vendor's own `_compute_decode_tiling` auto-tiling entry point, which this
package's `VideoDecodeTiling.computeAuto` already mirrors exactly
(temporal-only). `VAEDecodeTiled`'s spatial tile/overlap widget values in
the reference workflow are a ComfyUI-specific MANUAL override a user could
set, not part of the automatic behavior being ported. This package already
matches the reference's real (automatic) tiling strategy — the earlier
pass's framing of this as an open gap was itself imprecise, not the
underlying implementation.

**Verification**: `NativeI2VStageFFLFTests` (4/4, including the 2 new
tests) pass against real checkpoints. Full suite run separately to confirm
no regressions from the refine()/generate() signature changes.

## Fifth pass (2026-07-04) — the true N-stage upscale cascade lands

Closes the "True N-stage cascade" item flagged as still-open in the second
pass ("`NativeUpscaleStage.refine()` isn't structured to be called twice
with a different upscaler + progressively fewer steps"). Two real pieces
of new work, not just wiring:

1. **`LatentUpsampler` gained the `spatial_x1_5` variant** (`SpatialRationalResampler`:
   Conv2d -> `pixelShuffle2D(factor: 3)` -> `blurDownsample2D(stride: 2)`,
   net 3x-then-÷2 = 1.5x) — direct port of `model.py`'s
   `SpatialRationalResampler`/`BlurDownsampleModule`, read line-by-line
   rather than assumed from the x2 variant's shape. One real finding: the
   depthwise blur kernel is a REAL checkpoint tensor
   (`upsampler.blur_down.kernel`, shape `(1,5,5,1)` BF16 — confirmed via
   direct safetensors header inspection), not derived on load from the
   binomial-coefficient formula the Python reference only falls back to
   when the checkpoint omits it — so the Swift port loads it like any
   other weight instead of recomputing it. Verified via
   `scripts/dump_latent_upsampler_x1_5_reference.py` (same fixed-seed
   `(1,128,2,8,8)` input as the existing x2 dump, real
   `spatial_upscaler_x1_5_v1_0.safetensors` checkpoint) +
   `LatentUpsamplerX1_5RealCheckpointParityTests.swift`: max-abs-diff <
   1e-3, **passed on the first attempt**, correct `8→12` (1.5x) shape.
2. **`NativeUpscaleStage.generate()` gained `secondStage:
   SecondStageUpscaler?`** (`.x1_5` or `.x2Again`) — chains a SECOND
   neural-upscale + low-strength-refine pass entirely in latent space
   (denorm → upsample → renorm → refine, reusing the exact same
   `videoEncoder` per-channel mean/std stats and `refine()` method the
   first stage already uses) before the single final `VideoDecoder` call —
   matching the reference's own structure of one decode at the very end,
   not a decode between stages. Requires `refinePrompt`/`refineAudioURL`
   (new `.secondStageNeedsRefine` error if omitted) since the reference
   always refines every cascaded stage. Wired into both
   `native-upscale --second-stage x1.5|x2` and
   `native-i2v --second-stage x1.5|x2` (off by default, requires
   `--upscale`/`--refine`, both already on by default).

**Scope note, stated plainly**: `.x2Again` reuses the already-verified x2
checkpoint a second time (the reference's own "2x-total" toggle branch,
which does the same) rather than requiring the numerically-close-but-not-
identical claim of bit-parity with a specific ComfyUI run — this package
has no CFG/negative-prompt path either (see first pass, item confirming
CFG=1 is implicit), so exact pixel parity with any single reference render
was never the bar; matching the reference's *structure* (checkpoint
choice, chain shape, refine-every-stage behavior) is.

Verified real-checkpoint: `NativeUpscaleStageRealCheckpointTests
.testGenerateWithSecondStageCascadeProducesQuadrupleResolution` — a
64x64 input through `secondStage: .x2Again` produces a real, decoded
256x256 output (2x * 2x = 4x total, matching the reference's "2x-total"
toggle branch), finite pixels, correct frame count. Plus
`testSecondStageWithoutRefineThrowsClearError` (fail-fast validation).
Full suite green after the change (see PLAN.md's matching entry for exact
counts).

## Sixth pass (2026-07-04) — five more official Lightricks workflows found + fetched

Driven by a `/review s2-agent-ext-ltx, search the internet for ComfyUI
workflow JSON related to LTX2` request. Re-checked
`https://github.com/Lightricks/ComfyUI-LTXVideo/tree/master/example_workflows/2.3`
via `gh api` (not a plain web search — the earlier fifth-pass fetch used the
same source) and found the directory now lists 12 files, not the 7 already
present here. Fetched the 5 new ones:

| File | What it shows |
|------|----------------|
| `LTX-2.3_ICLoRA_HDR_Distilled.json` | IC-LoRA family + `LTXVHDRDecodePostprocess` — HDR tone-mapping applied at decode time, single stage. |
| `LTX-2.3_ICLoRA_Ingredients_Single_Stage_Distilled.json` | IC-LoRA family conditioned on a reference "ingredient" image (`LoadImage` + `RepeatImageBatch`), single stage, with audio. |
| `LTX-2.3_ICLoRA_Inpaint_Two_Stage_Distilled.json` | IC-LoRA family + `LTXVInpaintPreprocess`/`LTXVDilateVideoMask`/`LTXVLaplacianPyramidBlend` — mask-driven inpainting, two-stage (base + upscale). |
| `LTX-2.3_ICLoRA_Outpaint_Two_Stage_Distilled.json` | Same inpaint machinery (`LTXVInpaintPreprocess`/`LTXVLaplacianPyramidBlend`) driven by `ImagePadForOutpaintTargetSize` instead of a mask — canvas extension, two-stage. |
| `LTX-2.3_V2V_ICLoRA_Single_Stage_Distilled.json` | IC-LoRA family conditioned on an existing video (`LoadVideo` + `GetVideoComponents`) instead of an image — video restyle/V2V, single stage, with audio. |

**Net finding: no new mechanism.** All five confirm rather than extend the
fourth/fifth-pass conclusion — every one is the same
`LTXICLoRALoaderModelOnly` + `LTXAddVideoICLoRAGuide`(`Advanced`) +
`LTXVCropGuides` primitive already identified as the single highest-leverage
unported item, now with **ten** known applications (restoration/hd,
upscaler, motion-track, union-control, lipdub, HDR, ingredients, inpaint,
outpaint, V2V) sharing one mechanism. Reinforces — does not change — the
`PLAN.md` backlog call: porting the general IC-LoRA video-conditioning
primitive once unlocks all ten as call-site variations, and remains a
bigger, multi-session-shaped item, not picked up this pass.

Separately, cross-referencing this reference collection against the ACTUAL
current Swift CLI surface (`LTXVideoDirectorCLI.swift`'s `subcommands:`
array) rather than just workflow JSON turned up a wrapper-side gap instead:
`native-t2a` (the T2A gap this document's fourth-pass note called "smallest
and most cleanly scoped") had, in fact, already been ported natively
(`NativeT2ACommand.swift` exists) — but `bun-apps/s2-agent-ext-ltx` never
picked it up, alongside the already-landed `segment` command. See that
package's `TODO.md` item 14 for the fix (both now wrapped, plus a drift-
guard blind spot and a real path-validation bug found by exercising them
end-to-end).

## Seventh pass (2026-07-05) — `native-storyboard`: JSON-driven config for a 4-grid storyboard, RunningHub pages unreachable

Driven by a task to study three specific RunningHub ComfyUI workflow posts
("LTX-2.3 4-grid V3.0" — camera-move + hard-cut variants — and their
author's collection page) and design a JSON storyboard config from them.
**None of the three pages were reachable from this sandbox**: the
outbound network policy's host allowlist rejects `runninghub.ai` at the
CONNECT level (`gateway answered 403 to CONNECT`), and the Wayback Machine
fallback (`archive.org`) is likewise not in the allowlist — this is an
environment restriction, not a site-side block, so it should be re-checked
from an environment with broader egress (or a local machine) before
assuming the design below is the LAST word on what those specific posts
show.

In lieu of the actual pages, the closest REAL reference material already
in this repo was used instead: `LTX_Director_2_Workflow_Hotfix.json`'s
`LTXDirector` node (flagged "not analyzed in depth" in the second pass
above) turns out to carry almost exactly the shape this task asked for —
its config widget is a JSON blob (`{"segments":[...], "motionSegments":[...],
"audioSegments":[...], "retakeMode":..., ...}`) rather than a flat set of
per-panel flags, and its two `LTXDirectorGuide` nodes each carry an
independent per-guide `strength` (1.0 and 0.5 in the example file) — i.e. a
real production ComfyUI pipeline already prefers "one JSON config with a
segments array" over "N individual guide-strength widgets," which is
exactly the drift this task's `native-storyboard` command (see
`StoryboardConfig.swift`) is meant to fix for this package's CLI.

**Design consequence of not being able to inspect the actual 4-grid
workflow's node graph**: the camera-move/hard-cut split implemented here is
inferred from the task's own description (grid image split into panels,
per-panel frame index + strength, "camera-move" vs "hard-cut" as the
stated difference) and from this package's own two existing native stages,
rather than confirmed node-for-node against RunningHub's actual graph:

- `"camera-move"` → routes to `NativeI2VStage` (already has
  `gridImagePath`/`gridFrameIndices`/`gridStrengths`) — ONE continuous
  generation, every panel a keyframe at its own frame index. This is an
  exact fit for the already-ported grid-guide mechanism, no stage changes
  needed.
- `"hard-cut"` → routes to `NativeRelayStage` — each panel becomes an
  independent segment/shot, concatenated with a real cut. This DID need a
  new mechanism: the existing `gridImagePath`/`gridFrameIndices` fields on
  `NativeRelayStage.Request` apply the SAME whole grid identically to every
  segment (by design, per that file's own doc comment) — there was no way
  to say "segment 2 uses panel 2, segment 3 uses panel 3." Added
  `segmentGridPanels: [Int]?` / `segmentGridStrengths: [Float]?`: each
  segment crops its own panel from the shared grid (`FrameLoad.splitGrid`,
  already used elsewhere) and pins it via the SAME single-panel grid-guide
  call already used for the whole-grid case (`gridColumns=1, gridRows=1,
  gridFrameIndices=[0]`), which also means each hard-cut segment
  deliberately skips the relay's default continuity chaining (previous
  segment's last frame forced into the next segment's frame 0) — a hard cut
  is a new shot, not a continuation.

**NOT verified this pass** (no macOS/Swift toolchain in this sandbox — see
that PR's own checklist): `swift build -c release`, `bun test`, `bun run
check:flags` all still need to run locally before this is mergeable.
Re-fetching the three RunningHub pages from an environment with real
internet access and cross-checking the node graph against the design above
is the highest-value follow-up if the camera-move/hard-cut split needs
correcting.

## Eighth pass (2026-07-05) — CFG audit across all 16 files: zero real dev-mode (cfg>1) examples exist in this corpus

Driven by the `native-i2v --transformer` variant-wiring work
(`docs/native-i2v-dev-variant-study.md`): before investing in Milestone 2
(implementing real classifier-free guidance in `DenoiseLoop.swift`, needed
for the `dev`/`dasiwa` checkpoints' manifest-recommended `cfg_scale=5.0`),
checked whether this repo's own 16-file ComfyUI reference collection
contains ANY real example of that mode running — earlier passes had only
spot-checked 1-2 files and asserted "CFG=1 is implicit, not a gap" from
that partial sample. Parsed all 16 files programmatically this time
(`json.load` + walk `nodes` and every `definitions.subgraphs[].nodes`, not
grep-on-widget-values) rather than trusting the earlier files' README
summaries at face value.

**Result, with hard numbers**:
- **Every `CFGGuider` node in all 16 files has `widgets_values: [1]`** — 21
  `CFGGuider` instances total across the corpus (files with 2-stage/3-stage
  pipelines have 2-3 each), zero exceptions, zero other `cfg` value ever
  appears.
- **15 of 16 files' `CheckpointLoaderSimple` loads a checkpoint literally
  named `ltx-2.3-22b-dev.safetensors` or `ltx-2.3-22b-dev-fp8.safetensors`**
  — i.e. these workflows load the RAW dev weights, not a pre-fused
  distilled checkpoint. The 16th (`LTX_Director_2_Workflow_Hotfix.json`)
  loads an already-distilled transformer directly via `UNETLoader`
  (`ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors`), no
  LoRA needed.
- Combined with the already-known `LoraLoaderModelOnly` finding (the
  `dynamic_fro09` dev→distilled conversion LoRA, correctly identified in
  PR #294 — see `project_runninghub_grid_guide_research.md`): **the
  universal pattern across this entire corpus is "load dev weights → fuse
  the conversion LoRA → sample at cfg=1," never "sample the dev weights
  directly at their own manifest-recommended cfg>1."**
- Confirmed via case-insensitive grep across all 16 files: **no
  `STGGuider`/`DualCFGGuider` node type, and no genuine STG (spatio-temporal
  guidance) mechanism anywhere** — the one substring hit for "stg" across
  the corpus was `lastGroupId` (a false positive from ComfyUI's canvas
  state, not a guidance-related field).

**Why this matters for the native-i2v dev-variant work**: every other
feature this package has ported from this reference corpus (FFLF,
grid-guide, audio-track injection, upscale+refine, LoRA fusion, IC-LoRA
family) had a node-for-node match in some workflow file to validate
against. Real CFG (`cfg_scale>1`, needed for `mlx-models/transformer/ltx-2.3-dev-q8/manifest.json`'s
recommended params) does not — this specific mode is entirely ABSENT from
the community + official Lightricks reference material collected here,
despite 16 files across 2026-07-03 through 2026-07-04 fetches. If Milestone
2 (real CFG) is pursued, it has no ComfyUI graph to cross-check against in
this repo's own reference material; correctness would need to be validated
purely against the vendor Python `ltx_pipelines_mlx/utils/samplers.py`
implementation (confirmed present and CFG-capable — see
`native-i2v-dev-variant-study.md`), not by node-graph parity the way every
prior port in this document was checked. Worth treating as a genuine open
question, not just an implementation task: no production ComfyUI workflow
in this corpus (RunningHub included, per the seventh pass and PR #294's
correction) actually runs LTX-2.3's dev checkpoint in its own
manifest-recommended guided mode — the community convention treats "dev"
purely as a base weight to convert into fast distilled-style behavior, not
as a directly-usable quality mode. Whether that's because raw dev+CFG
sampling is genuinely less desirable in practice (slower, not obviously
better output) or simply less commonly shared/document is unconfirmed —
flagged for whoever decides whether Milestone 2 is worth building, rather
than assumed either way.

No code changed this pass — pure verification/corpus-audit, feeding
directly into the Milestone 1/2 split already recorded in
`docs/native-i2v-dev-variant-study.md`.
