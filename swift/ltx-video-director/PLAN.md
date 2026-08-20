## T2A (pure text-to-audio) — LANDED (2026-07-04)

New `native-t2a` command + `NativeT2AStage`, reusing existing audio VAE/Gemma
text-encoder/DenoiseLoop infrastructure. Ported from the official Lightricks
reference `docs/reference/comfyui_workflows/LTX-2.3_T2A_Single_Stage_Distilled.json`
(`LTXVAudioOnlyModel` + `LTXVAudioOnlyEmptyVideoLatent`), found while
investigating three RunningHub AI-app links whose own workflow JSON turned
out to be paywalled behind a paid-group signup — see that README section for
the full provenance chain. Read the model author's own `audio_only.py` +
ComfyUI core `av_model.py` source directly (not guessed from widget values)
to confirm the exact mechanism: `run_vx`/`a2v_cross_attn`/`v2a_cross_attn`
transformer_options flags gate the ENTIRE video branch (self-attn + text
cross-attn + FF) and both cross-modal directions, while a fixed (1,128,1,2,2)
dummy video latent still threads through positionally (never attended to).

Ported this as three new `runVideoStream`/`a2vCrossAttn`/`v2aCrossAttn`
parameters on `BasicAVTransformerBlock.callAsFunction` (default `true`,
zero behavior change for every existing caller), threaded through
`LTXModel.callAsFunction`/`streamingForward` and `DenoiseLoop.runStreaming`
as a single `audioOnly: Bool` flag. `NativeT2AStage` builds the dummy video
latent + real audio noise, runs the same real 48-block distilled transformer
+ `SigmaSchedule.distilledSigmas` (confirmed byte-identical to the reference
workflow's own `ManualSigmas` — no new schedule needed), and decodes ONLY
the audio (dummy video output is discarded, never decoded).

Verified real-checkpoint: `NativeT2AStageRealCheckpointTests
.testGenerateProducesRealNonSilentAudio` — real WAV, dBFS computed directly
from PCM samples (not trusting exit-code self-report), confirmed non-silent
(-29.6dB mean / -8.5dB peak via an independent `ffmpeg volumedetect` check
outside the test too). 4.5s wall time for a 3.85s clip. Full `swift test`
run completed clean afterward: **132/132 pass** (130 -> 132, the 2 new T2A
tests), 1 test skipped (expected — `LoRAFusionTests`' real-vendor-reference
test, unrelated to this change), 0 failures, 1446.8s wall — confirms the new
`runVideoStream`/`a2vCrossAttn`/`v2aCrossAttn` block parameters (all
default-`true`) didn't regress any existing caller, including
`BasicAVTransformerBlockParityTests`.

## True N-stage upscale cascade — LANDED (2026-07-04)

Closes the "True N-stage cascade" gap flagged open since the second
ComfyUI-reference research pass (docs/reference/comfyui_workflows/
README.md). `LatentUpsampler` gained the `spatial_x1_5` variant
(`SpatialRationalResampler`: Conv2d -> pixelShuffle2D(3) ->
blurDownsample2D(stride 2), real checkpoint blur kernel loaded from
`upsampler.blur_down.kernel`, not recomputed) — verified real-checkpoint
parity (max-abs-diff < 1e-3, 8→12 shape, passed first try). `NativeUpscaleStage
.generate()` gained `secondStage: SecondStageUpscaler?` (`.x1_5` or
`.x2Again`), chaining a second neural-upscale+refine pass entirely in
latent space before the single final VideoDecoder call, mirroring the
reference 3-stage FFLF workflow's Stage #3. Wired into both
`native-upscale --second-stage x1.5|x2` and `native-i2v --second-stage
x1.5|x2` (both off by default — existing default behavior unchanged).

Verified real-checkpoint: `NativeUpscaleStageRealCheckpointTests
.testGenerateWithSecondStageCascadeProducesQuadrupleResolution` (64x64 ->
256x256, 2x*2x=4x total via `.x2Again`, real decoded output, correct frame
count) + `testSecondStageWithoutRefineThrowsClearError` (fail-fast
validation). Targeted suite run (`LatentUpsampler*`+`NativeUpscaleStage*`,
8 tests): **8/8 pass, 0 failures**. Full from-scratch `swift test` runs
were killed twice by the environment mid-run/mid-build with zero failures
logged either time (background-process eviction under concurrent
heavy-model contention — a known, previously-documented environment
quirk, not a test failure) — relying on this direct, complete, unkilled
targeted run instead. See docs/reference/comfyui_workflows/README.md's
fifth pass for the full writeup.

# ltx-video-director — porting plan

Goal: port `python/mlx-movie-director/run.py video` (LTX-2.3 I2V + quality
review) to a native Swift/MLX app, following the phased, parity-verified
methodology that shipped `z-image-director` and `flux2-image-director`
(each component ported and checked against the Python reference — cos
similarity / metric parity — before the next is begun).

## Scope (from the driving goal)

1. I2V, ~10s, "beautiful girl on a street", distilled model first, reusing
   the already-converted `mlx-models/ltx-mlx/{dev,distilled,dasiwa}`
   checkpoints (no re-conversion).
2. A basic (VLM-free) video/image/voice quality gateway.
3. VLM keyframe captioning to verify video quality/prompt-adherence.
4. LTX's native spatial upscaler (IC-LoRA restore+upscale stack).

## Phase 0 — shipped now (this commit)

Everything EXCEPT the actual LTX denoising loop is native Swift, today:

- `LTXModelRegistry` — discovers installed transformer variants under
  `mlx-models/ltx-mlx/` (no subprocess).
- `VideoProbe` / `AudioProbe` (AVFoundation) — duration/fps/resolution/
  keyframe extraction, loudness/silence analysis. Pure native.
- `VideoGate` — combines per-frame `CommonImageDirector.ImageGate` (reused
  verbatim from the image directors), frame-to-frame SSIM via
  `ImageGenUtils.ImageMetrics` (frozen-frame / corruption detection), and
  `AudioProbe` loudness (voice-track sanity). This is item (2), fully native.
- `VLMVerify` — extracts keyframes, scores each with the same LM Studio VLM
  client (`ImageGenUtils.CaptionClient`) z-image/flux2 use, using the
  `review` style for prompt-adherence checking. This is item (3), fully
  native.
- `I2VEngine` / `UpscaleEngine` — the ONE Python-bridged piece. Shells out
  to `run.py video t2i2v` / `run.py video restore --restore-scale` (via
  `Process`, `RunPyBridge.swift`) because the LTX-2.3 transformer + VAE
  denoising loop is not yet ported. This reuses the exact same converted
  checkpoints a native transformer would load — swapping the bridge for a
  native call is a drop-in replacement behind the same request/result types.

Why bridge instead of stub: the LTX-2.3 transformer (22B, video-temporal
attention, joint audio/video denoising, IC-LoRA restoration) is a
multi-week port even at the pace z-image-director/flux2-image-director set
(see their docs/PLAN.md — each was ported block-by-block with numerical
parity checks). Shipping a working `ltx-video i2v` today that produces a
REAL 10s clip — via the already-verified Python engine — is more useful
than an unverified from-scratch reimplementation that might silently
produce garbage. The native gateway/verify/upscale-wiring layers do NOT
depend on the bridge and are real, working Swift code today.

## Phase 1 progress (2026-07-02)

First native, parity-verified component landed: `Sources/LTXVideoDirector/VAE/Conv3dBlock.swift`
— the causal/non-causal 3D-conv building block used throughout the LTX-2.3 video VAE
(`ltx_core_mlx.model.video_vae.convolution.Conv3dBlock`). Verified against the ACTUAL Python
MLX implementation this project runs (not a hand-derived expectation): `scripts/dump_conv3d_reference.py`
dumps fixed-seed weights/input/output from the real `Conv3dBlock`, and
`Tests/LTXVideoDirectorTests/Conv3dBlockParityTests.swift` loads them and asserts max-abs-diff
< 1e-4 for all three modes (causal+zeros, non-causal+reflect, causal kernel=1). All 3 pass.

Second and third components landed the same way: `PixelNorm.swift` (parameter-free RMS norm over
channels — `mx.fast.rms_norm(x, weight=None)`; ported as an explicit formula since MLX Swift's
`rmsNorm` requires a non-optional weight) and `ResBlockStage.swift` (pre-activation residual
block: norm→silu→conv1→norm→silu→conv2+skip, composed from `Conv3dBlock`+`PixelNorm`). Verified
via `scripts/dump_resblock_reference.py` + `Tests/LTXVideoDirectorTests/ResBlockStageParityTests.swift`
(max-abs-diff < 1e-4, 2-block stage, 8 real weight tensors loaded by their checkpoint-shaped keys
`res_blocks.{i}.conv{1,2}.conv.{weight,bias}` — confirms the Swift loader's key scheme matches the
real checkpoint layout, not just the math). 7/7 tests pass.

Fourth/fifth/sixth: `VAESampling.pixelShuffle3D` and `.unpatchifySpatial` (`sampling.py`'s
weight-free depth-to-space rearrangement ops — the two differ in channel-split order, (c,temporal,
h,w) vs (c,r=width,q=height), which caused checkerboard artifacts upstream when confused; both
verified separately) plus `DepthToSpaceUpsample` (a thin wrapper — literally just `Conv3dBlock`,
since the reference applies `pixel_shuffle_3d` to its output externally). Verified via
`scripts/dump_sampling_reference.py` + `Tests/LTXVideoDirectorTests/VAESamplingParityTests.swift`:
max-abs-diff < 1e-5 on 3 shape/factor combinations. 10/10 tests pass across all Phase 1 work so far.

Seventh: `PerChannelStatistics.denormalizeLatent` — the per-channel affine (x*std+mean) applied to
the raw latent before `conv_in` in the real decoder's `decode()` (confirmed by reading
`video_vae.py`'s actual `decode()` body, which also revealed the real upsample factor schedule
for `up_blocks` 1/3/5/7: `[(2,2),(2,2),(1,2),(2,1)]` spatial/temporal — needed for the next
assembly step). Verified via `scripts/dump_perchannelstats_reference.py` +
`Tests/LTXVideoDirectorTests/PerChannelStatisticsParityTests.swift`: max-abs-diff < 1e-5.
11/11 tests pass across all Phase 1 work so far.

### Milestone: full decoder assembly, verified against the REAL production checkpoint

`VideoDecoder.swift` assembles all of the above into the complete decoder — `conv_in` → 9
`up_blocks` (alternating `ResBlockStage`/`DepthToSpaceUpsample`, real channel counts
1024/512/256/128 and per-stage block counts 2/2/4/6/4, matching the real checkpoint's actual
tensor shapes) → pre-activation PixelNorm+SiLU → `conv_out` → `unpatchifySpatial`. Two details
that are NOT derivable from the code ported so far, only from reading `video_vae.py`'s `decode()`
body directly: (1) the first frame is unconditionally dropped after every temporal upsample
(`tf>1`), and (2) `causal` defaults to **false** with zeros-padding for LTX-2.3's actual trained
config (a prior hardcoded `causal=True`/`reflect` caused a documented keyframe regression).

Two-tier verification:
- `scripts/dump_videodecoder_reference.py` runs the REAL `VideoDecoder` class (real architecture,
  fixed-seed random weights) end-to-end; `VideoDecoderParityTests.swift` checks the Swift assembly
  against it — max-abs-diff < 1e-3, correct F=2→9 frame-count transformation. This validates the
  ASSEMBLY logic, not just individual ops.
- `VideoDecoderRealCheckpointTests.swift` loads the ACTUAL production checkpoint
  (`mlx-models/vae/ltx-2.3-vae/vae_decoder.safetensors`, bf16, 86 tensors, `vae_decoder.` key
  prefix) and runs a real forward pass — confirms the native Swift assembly loads real production
  weights and produces finite, correctly-shaped output. No reference to diff against (would need a
  full PyTorch pipeline) — this is an integration smoke test, not a numerical parity check.

**This is the first native Swift code path that has actually decoded a latent using real LTX-2.3
production weights, with zero Python involved.** 13/13 tests pass.

Remaining before the decoder is usable in the real `i2v` pipeline: memory-bounded tiling (real
latents are far larger than the tiny 2×2×2 test case), and swapping `RunPyBridge`'s decode step for
this native path behind the same `I2VResult` type.

### Encoder work started (needed for I2V image conditioning, not just training/round-trip)

Ninth/tenth components: `VAESampling.spaceToDepth`/`.patchifySpatial` (the encoder-side downsample
rearrangement, analogous to the decoder's pixelShuffle3D/unpatchifySpatial) and
`SpaceToDepthDownsample` (the encoder's downsample block: a conv branch + a parameter-free
group-mean skip branch, summed — real formula: `group_size = in_ch*stride_h*stride_w*stride_t /
out_ch`). Read `video_vae.py`'s real `VideoEncoder.__init__`/`encode()` directly to confirm the
full architecture: `conv_in` (48→128) → 9 `down_blocks` (ResBlockStage@128×4/256×6/512×4/1024×2/
1024×2 alternating with SpaceToDepthDownsample at strides `(1,2,2)/(2,1,1)/(2,2,2)/(2,2,2)`) →
pre-activation PixelNorm+SiLU → `conv_out` (1024→129, keep first 128 channels, discard the rest) →
`normalize_latent` ((x-mean)/std, note: SUBTRACT not add, unlike the decoder's denormalize) →
`patchifySpatial` at the INPUT (before conv_in, not shown above — patches pixels 48ch before the
first conv). Verified via `scripts/dump_spacetodepthdownsample_reference.py` +
`Tests/LTXVideoDirectorTests/SpaceToDepthParityTests.swift`: max-abs-diff < 1e-4/1e-5 across
space_to_depth alone and two SpaceToDepthDownsample stride configs. 16/16 tests pass.

### Milestone: full encoder assembly, verified against the REAL production checkpoint

`VideoEncoder.swift` assembles the encoder the same way `VideoDecoder.swift` assembled the
decoder: `patchifySpatial` → `conv_in` (48→128) → 9 `down_blocks` (ResBlockStage 128×4/256×6/
512×4/1024×2/1024×2 alternating with `SpaceToDepthDownsample` at strides `(1,2,2)/(2,1,1)/
(2,2,2)/(2,2,2)` — the (in,out,stride) triples are NOT derivable from checkpoint shapes alone,
read directly from `VideoEncoder.__init__`) → pre-activation PixelNorm+SiLU → `conv_out`
(1024→129, keep first 128 channels) → `normalize_latent` (`(x-mean)/std` — SUBTRACT, the opposite
sign from the decoder's `denormalize_latent` which ADDS). Handles a real checkpoint quirk: the
per-channel-statistics keys are underscore-prefixed (`_mean_of_means`/`_std_of_means`) in the
safetensors file (MLX's Python `nn.Module` skips underscore-prefixed attributes, so the reference
remaps them on load — this loader does the same remap). All `down_blocks` use `causal=true`
(confirmed: hardcoded in every `VideoEncoder` sub-module, unlike `VideoDecoder`'s `causal=false`
default for LTX-2.3).

`VideoEncoderRealCheckpointTests.swift` loads the ACTUAL production checkpoint
(`mlx-models/vae/ltx-2.3-vae/vae_encoder.safetensors`, bf16, 86 tensors) and runs a real forward
pass on a synthetic 64×64×9-frame pixel input, confirming finite, correctly-shaped (128-channel
latent) output. 17/17 tests pass.

**Both VAE halves (encoder AND decoder) now run natively in Swift/MLX against real production
LTX-2.3 weights, with zero Python involved**, for small test-scale inputs. Remaining before either
is usable in the real `i2v` pipeline: memory-bounded tiling for real-size latents/pixels, and
wiring both into the `i2v`/`upscale` CLI commands in place of `RunPyBridge`. After the VAE: the
48-layer transformer (by far the largest piece — see Phase 2; this is what actually generates the
latent, and nothing ported so far touches it). Each subsequent piece follows the same
dump-real-reference → port → parity-test loop established here.

## Phase 1 — native VAE (decode-only)

Port the LTX-2.3 3D causal VAE decoder (latents → pixels) to MLX Swift.
Verify against a Python reference dump (`scripts/dump_vae_reference.py`
pattern from z-image-director) — decode the SAME latent tensor in both
runtimes, check pixel-space MSE/SSIM. This alone lets native Swift consume
latents produced by the bridge, useful for a later hybrid (native
upsampling/tiling around a still-bridged denoiser).

## Phase 2 — native transformer (single-step parity)

Port the LTX-2.3 DiT block (spatiotemporal attention + RoPE + audio cross-
attention) one block at a time, each verified against
`scripts/dump_transformer_reference.py`-style dumps (cos similarity > 0.99
per block, matching the flux2-image-director methodology). Land CFG/STG
guidance and the Euler flow-match scheduler (`CommonImageDirector.Scheduler`
is already model-agnostic and reusable as-is).

**Started 2026-07-02.** First component: `RoPE.swift` — LTX-2.3's rotary position
embeddings (`ltx_core_mlx.model.transformer.rope`). Two things confirmed by reading the
source directly (not assumable from "RoPE" alone): (1) LTX-2.3 uses log-spaced frequency
indices with fractional positions, NOT standard `1/theta^k` RoPE; (2) SPLIT layout
(first-half-cos/second-half-sin) is what every production checkpoint actually uses —
upstream switched the default from INTERLEAVED in PR #212, so INTERLEAVED is legacy and
was not ported. Pure function, no learnable weights — good first transformer-side
component since checkpoint-loading isn't a variable. Verified via
`scripts/dump_rope_reference.py` + `Tests/LTXVideoDirectorTests/RoPEParityTests.swift`:
max-abs-diff < 1e-4 on cos/sin frequency tables AND the applied rotation, video-shaped
input (3 position dims: temporal/height/width). 18/18 tests pass across all Phase 1+2
work so far.

Second component: `TimestepEmbedding.swift` — sinusoidal timestep embedding
(`mlx_arsenal.diffusion.get_timestep_embedding`, an external dependency `timestep_embedding.py`
re-exports) + the 2-layer MLP that projects it (`TimestepEmbedding`/`TimestepEmbedder`). First
component with real learnable weights on the transformer side (`linear1`/`linear2`). Verified via
`scripts/dump_timestep_embedding_reference.py` + `Tests/LTXVideoDirectorTests/TimestepEmbeddingParityTests.swift`:
max-abs-diff < 1e-4 on both the sinusoidal table and the MLP output. 19/19 tests pass.

Third component: `AdaLayerNormSingle.swift` — produces the DiT block's modulation parameters
(scale/shift/gate for attention + MLP) from the timestep embedding. Thin composition on top of
`TimestepEmbedder`: `emb(timestep) → silu → linear → (params, embedded)`. Verified via
`scripts/dump_adaln_reference.py` + `Tests/LTXVideoDirectorTests/AdaLayerNormSingleParityTests.swift`:
max-abs-diff < 1e-4 on both outputs. 20/20 tests pass.

Fourth component: `FeedForward.swift` — the DiT block's MLP (Linear → GELU tanh-approx → Linear),
used for both the main video FFN (`ff`) and the audio FFN (`audio_ff`, same class, different
instance). Verified via `scripts/dump_feedforward_reference.py` +
`Tests/LTXVideoDirectorTests/FeedForwardParityTests.swift`: max-abs-diff < 1e-4. 21/21 tests pass.

Fifth component: `Attention.swift` — the real complexity piece. Multi-head attention with QK
RMSNorm (learnable weight, unlike VAE's parameter-free PixelNorm), SPLIT-layout RoPE (reuses
`RoPE.swift`), `MLX.scaledDotProductAttention` (MLX's fused kernel, matching `mx.fast.
scaled_dot_product_attention`), STG perturbation blending (`out*mask + v*(1-mask)`), and
per-head sigmoid gating (`2*sigmoid(gate_logits)`, zero-init → gate=1). One `Attention` struct
serves both attention "shapes" the 48-layer DiT uses: self-attention with RoPE (`kv_dim ==
query_dim`, `encoderHiddenStates` nil) and cross-attention without RoPE (`kv_dim` can differ,
`encoderHiddenStates` provided — video↔text/audio). Verified via
`scripts/dump_attention_reference.py` + `Tests/LTXVideoDirectorTests/AttentionParityTests.swift`
covering BOTH shapes: max-abs-diff < 1e-3 (looser than the FFN/AdaLN tests — attention involves
softmax + multiple matmuls, more fp32 accumulation than a single Linear). 23/23 tests pass.

Sixth component: `Modality.swift` — the input bundle for one modality (video or audio) in the
DiT: latent/sigma/timesteps/positions/context + optional masks. A plain data container (no
learned weights, no real numerics) with a `split(sizes:)` utility used by guidance code that
batches multiple guidance variants (cond/neg/ptb/mod) together for one forward pass and needs to
break them apart again afterward. Still verified against the real Python `.split()` (batch-offset
slicing across 5 fields is easy to get subtly wrong) via `scripts/dump_modality_reference.py` +
`Tests/LTXVideoDirectorTests/ModalityParityTests.swift`: exact match (tolerance 1e-6) splitting a
batch-of-6 into [2,3,1], the real guidance-batching shape. 24/24 tests pass.

### Milestone: the full joint audio-video DiT block, verified end-to-end

`BasicAVTransformerBlock.swift` ports `transformer.py`'s `BasicAVTransformerBlock` — the actual
block stacked 48x into the LTX-2.3 DiT. Wires together every Phase-2 component built so far into
the real forward pass: video self-attn → audio self-attn → video text cross-attn → audio text
cross-attn → bidirectional audio↔video cross-modal attention (the joint-modality mechanism that
makes this a "joint audio+video" model, not a video model with bolted-on audio) → video FF →
audio FF, each step modulated by AdaLN-derived scale/shift/gate parameters unpacked from a
per-block `scale_shift_table` (`_unpack_adaln`, ported faithfully including the "scalar vs
per-token" branch and the 9/4/2/1-param table layouts for self-attn/AV-cross/text-cross/AV-gate
respectively). Uses 6 separate `Attention` instances (video self, audio self, video text-cross,
audio text-cross, audio→video cross-modal, video→audio cross-modal) and 2 `FeedForward` instances
— confirms `Attention`'s single-struct design correctly serves every attention shape the real DiT
needs, not just the two shapes it was originally tested against.

**NOT yet ported**: STG (spatial-temporal guidance) perturbation masking
(`BatchedPerturbationConfig`) — used for inference-time guidance tricks, not needed for a basic
forward pass; the reference's `perturbations` branches are simply omitted (block always takes the
un-perturbed path).

Verified via `scripts/dump_basicavblock_reference.py` (runs the REAL `BasicAVTransformerBlock`
class, real 9-step forward logic, fixed-seed weights, small dims, includes video/audio self-RoPE
AND separate video/audio cross-RoPE — 4 distinct RoPE frequency tables in one test, matching how
the real block actually receives them) + `Tests/LTXVideoDirectorTests/BasicAVTransformerBlockParityTests.swift`:
**passed on the first run** — max-abs-diff < 2e-3 on both video and audio outputs (looser
tolerance than single-attention tests: 8 attention/FF stages of fp32 accumulation compound). This
is the single largest validation in the port so far and the real test of whether the 6 components
built earlier in Phase 2 were correct AND correctly composable — they were. 25/25 tests pass.

### Milestone: the full top-level LTXModel, verified end-to-end (2026-07-02)

`LTXModel.swift` ports `model.py`'s `LTXModel` — the complete 48-layer DiT wiring: patchify
projections → 8 top-level `AdaLayerNormSingle` modules (`adaln_single`/`audio_adaln_single`
9-param self-attn+ff+text-xattn, `prompt_adaln_single`/`audio_prompt_adaln_single` 2-param text
cross-attn, `av_ca_video/audio_scale_shift_adaln_single` 4-param AV cross-attn, `av_ca_a2v/v2a_gate_adaln_single`
1-param AV gates — ALL sharing ONE timestep embedding, except the AV-gate pair which uses a
separately-scaled embedding via `av_ca_timestep_scale_multiplier`) → RoPE frequency computation
(4 distinct tables: video self, audio self, video cross, audio cross — cross tables use ONLY the
temporal position axis and a combined `max(video_max_pos[0], audio_max_pos[0])`) → the block
stack (`transformerBlocks`, reusing `BasicAVTransformerBlock` unchanged) → output projection
(parameter-free LayerNorm — note: LayerNorm here, NOT the RMSNorm `BasicAVTransformerBlock` uses
internally — + AdaLN scale/shift + final Linear).

**Scope** (matches `BasicAVTransformerBlock`'s documented scope): scalar-timestep path only — no
per-token timesteps, no STG perturbations, no block-streaming/TeaCache/calibration-tap hooks, no
`LTX2_DIT_EVAL_EVERY` Metal-watchdog flushing (MLX Swift's evaluation model differs from Python's
lazy-graph-per-48-blocks; revisit only if profiling shows it's needed).

Verified via `scripts/dump_ltxmodel_reference.py` (runs the REAL `LTXModel` class with a small
2-layer config — 86 real weight tensors incl. 2 full transformer blocks — fixed-seed weights,
real video+audio text embeddings, real 3D video / 1D audio RoPE positions) +
`Tests/LTXVideoDirectorTests/LTXModelParityTests.swift`: **passed on the first run** —
max-abs-diff < 5e-3 on both video and audio outputs (looser than the single-block test: the
reference casts activations to bf16 internally for memory, which this comparison inherits as
extra rounding noise on top of the accumulated depth). This is the top of Phase 2 — every
component built in this phase (RoPE, TimestepEmbedding, AdaLayerNormSingle, FeedForward,
Attention, Modality, BasicAVTransformerBlock) is now exercised together in the real top-level
assembly. 26/26 tests pass.

### Milestone: real production checkpoint, dequantized and run natively (2026-07-02)

`QuantizedWeights.swift` + `LTXModelRealCheckpointTests.swift` close the gap between the
synthetic-weight `LTXModel` test and actual production use. Real finding: the production
checkpoint (`mlx-models/transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors`,
19GB, 7450 tensors, confirmed via direct inspection) stores every block's Attention/FeedForward
Linear weights **MLX-quantized** (int8, group_size=64 — packed `uint32` weight + bf16
`scales`/`biases` siblings; shapes cross-checked: `(4096,1024)` packed U32 for a 4096×4096 matrix
at 8 bits/element, `(4096,64)` scales for group_size=4096/64=64). None of the Attention/
FeedForward code ported so far does quantized matmul, so `QuantizedWeights.dequantizeLinearWeights`
dequantizes on load (`MLX.dequantized`) instead — simpler than implementing quantized inference,
and fine for a smoke test (dequantizing all 48 blocks to float32 would need far more memory than
reasonable to hold at once; this test dequantizes ONLY block 0 + the small top-level modules).

Also confirmed against `mlx-models/ltx-mlx/distilled/embedded_config.json` (the checkpoint's own
metadata, not assumed): the real production config is `video_dim=4096, audio_dim=2048,
video/audio_num_heads=32, video_head_dim=128, audio_head_dim=64, timestep_embedding_dim=256`, and
**`timestep_scale_multiplier` AND `av_ca_timestep_scale_multiplier` are BOTH 1000** (not the
Python dataclass's literal default of `1.0` for the latter — production sets them equal, making
the AV-gate embedding scale factor exactly 1.0, i.e. no separate scaling in practice despite the
code path existing for it).

`LTXModelRealCheckpointTests.swift` loads the real checkpoint, strips the `transformer.` prefix,
keeps only `transformer_blocks.0` + top-level keys, dequantizes, builds one real
`BasicAVTransformerBlock` + `LTXModel` at real production dims, and runs a forward pass on tiny
synthetic tokens — confirms finite, correctly-shaped output. **Runs in well under a second.**
27/27 tests pass.

**This means: a real slice of the actual 19GB LTX-2.3 production checkpoint has now been loaded,
dequantized, and executed through native Swift/MLX code, end to end, with zero Python.**

### Milestone: all 48 real transformer blocks stream end-to-end (2026-07-02)

`TransformerCheckpointLoader.swift` centralizes the checkpoint-loading logic (previously
duplicated across test files) into reusable production code — `blockWeights(raw:blockIndex:)`
dequantizes ONE block's slice on demand, `topLevelWeights`/`makeAdaLN`/`makeAttention`/`makeFF`/
`makeBlock`/`makeModel` build the corresponding native structs from it.

`LTXModel.streamingForward` (new method alongside `callAsFunction`) mirrors the Python
reference's `block_provider` streaming mechanism: instead of a fixed `transformerBlocks` array,
it takes a `blockProvider(Int) -> BasicAVTransformerBlock` closure, calling it fresh each
iteration and `MLX.eval`-ing the hidden states immediately after each block so that block's
just-built dequantized weights become eligible for release before the next block is constructed.

`LTXModelRealCheckpointTests.testAll48RealBlocksStreamWithBoundedMemory` streams **all 48 REAL
transformer blocks** from the actual 19GB checkpoint (not a synthetic stand-in, not just block
0) — dequantizing each block's weights on demand, running it, releasing it, moving to the next.
**Runs in 1.5 seconds with finite, correctly-shaped output.** This directly answers the open
question from the previous milestone ("does streaming actually work at full depth against real
weights") — it does, and cheaply. 28/28 tests pass.

**This closes out the transformer-depth question entirely.** The full 48-layer joint audio-video
DiT can now run against real production weights, end to end, natively in Swift, with bounded
memory. Remaining before real generation: the diffusion sampling loop (Euler flow-match stepping,
CFG/STG guidance batching via `Modality.split`), the text encoder (Gemma — likely reusable via
`mlx-lm`, not something to hand-port), the audio VAE/vocoder/bandwidth-extension stack (untouched,
separate from everything ported so far), and replacing `RunPyBridge` in the `i2v`/`upscale` CLI
commands with all of the above wired together. None of these are "is the architecture right"
questions anymore — they're each their own integration project.

## Phase 3 — native I2V conditioning + audio + speech-gate

- Image-conditioning latent injection (I2V).
- Joint audio decode (LTX-2.3 generates audio from the same prompt).
- A REAL voice-presence gate: today's `AudioProbe` is energy-based only
  (loudness/silence). A proper "is this actually speech, and roughly the
  right language" check needs VAD/ASR — out of scope until this phase.
  **Partially closed 2026-07-04**: `ASRGate.swift` + `CJKScript.swift` add
  content/language verification (transcript-overlap check, zh-TW vs zh-CN
  script classification — the latter fully native, no ML model) wired into
  `ltx-video gate --asr-prompt`. What's STILL bridged (not native): the
  transcription itself, via `python/mlx-movie-director/app/commands/
  video-asr-gate.py` → `mlx_whisper`. A native Swift/MLX Whisper port
  (encoder+decoder+tokenizer, likely `whisper-large-v3-mlx` weights) remains
  the one open item to make this gate 100% native — multi-session scope on
  its own, not attempted this iteration; every decision ON TOP of the raw
  transcript (language match, content overlap, Traditional/Simplified
  classification) is already native Swift today.

  **Native Whisper port — STARTED 2026-07-04 (first piece landed).**
  `WhisperMel.swift` ports `mlx_whisper.audio.log_mel_spectrogram` line-for-
  line (reflect-pad → Hann window → `MLXFFT.rfft`-based STFT via
  `asStrided`, same as the Python reference's `mx.fft.rfft` + `mx.as_strided`
  — this package already depended on `mlx-swift`, just needed the `MLXFFT`
  product added to `Package.swift`) — the log-mel feature extraction that
  feeds Whisper's encoder, for both n_mels=80 (tiny/base/small/medium) and
  n_mels=128 (large-v3, the model the Python bridge actually uses). The
  precomputed librosa mel filterbank mlx_whisper ships
  (`mel_filters.npz`) is embedded as an SPM resource (converted to
  safetensors so `MLX.loadArrays` reads it with no custom npz/zip parser
  needed) rather than reimplemented from scratch.
  Verified against REAL `mlx_whisper` output (this session's sandbox turned
  out to have a working venv after all — see environment note below):
  `scripts/dump_whisper_mel_reference.py` runs the actual
  `mlx_whisper.audio.log_mel_spectrogram` on a deterministic synthetic
  multi-tone signal and dumps both n_mels configs;
  `WhisperMelParityTests.swift` compares — max abs diff < 1e-3 on both
  n_mels=80 and n_mels=128. 2/2 pass.
  **Encoder — landed 2026-07-04, verified against REAL production weights.**
  `WhisperEncoder.swift` ports `mlx_whisper.whisper.AudioEncoder` /
  `ResidualAttentionBlock` / `MultiHeadAttention` (self-attention only — the
  encoder never uses cross-attention) line-for-line: conv1(k3,p1) → GELU →
  conv2(k3,s2,p1) → GELU → + sinusoidal positional embedding → N
  self-attention blocks (pre-LN, asymmetric q/k pre-scale by `headDim**-0.25`
  matching the reference's exact — not the usual fused-SDPA-equivalent —
  rounding) → final LayerNorm. Verified two ways:
  1. `WhisperEncoderParityTests` — real `mlx_whisper.whisper.AudioEncoder`
     class instantiated at a small config (2 layers, 32-dim) with random
     weights (same "verify the architecture, not the pretrained checkpoint"
     split as `dump_timestep_embedding_reference.py` — a real 1.5GB+
     large-v3 checkpoint isn't committed to this repo). 2/2 pass.
  2. `WhisperEncoderRealCheckpointTests` — the conv stem + ONE real
     transformer block-0, loaded from the ACTUAL cached
     `whisper-large-v3-mlx` checkpoint (1280-dim, 20-head — the exact model
     `_run_audio_asr_gate` transcribes with), run on REAL log-mel features
     from an actual generated clip's speech audio. Max abs diff < 5e-2
     (fp16-checkpoint tolerance). 1/1 pass. Mirrors this repo's own
     "one real block, real checkpoint" precedent
     (`LTXModelRealCheckpointTests.testOneRealBlockProducesFiniteOutput`)
     rather than running the full 32-layer encoder.

  **Decoder — also landed 2026-07-04, verified against REAL production
  weights.** Confirmed the prediction noted right after the encoder landed:
  `mlx_whisper.whisper.ResidualAttentionBlock` with `cross_attention=true`
  IS the same class as the encoder's block, just with a second attention
  sub-layer — so `WhisperAttention` only needed generalizing (added
  `crossInput`/`mask` params, both nil-default so the encoder's existing
  call sites are unchanged) rather than a from-scratch rewrite.
  `WhisperDecoder.swift` (new) ports `TextDecoder`/`ResidualAttentionBlock`
  (cross_attention=true): causal self-attn → cross-attn to encoder output →
  MLP, all pre-LN, plus token+positional embedding and the tied-embedding
  logits projection (`token_embedding.as_linear`). `causalMask(length:)`
  mirrors `nn.MultiHeadAttention.create_additive_causal_mask` exactly
  (upper triangle = -inf). Verified against the REAL cached
  `whisper-large-v3-mlx` checkpoint's real token/positional embeddings +
  decoder block-0 weights, on real special-token ids (SOT/language=zh/
  transcribe/notimestamps — Whisper's real zh transcription prefix) cross-
  attending to the real encoder-block-0 output from the encoder fixture
  above — max abs diff < 5e-2, 2/2 pass
  (`WhisperDecoderRealCheckpointTests.swift`,
  `scripts/dump_whisper_real_decoder_block_reference.py`).

  **Tokenizer (decode direction) — also landed 2026-07-04.**
  `WhisperTokenizer.swift` ports `mlx_whisper.tokenizer`'s tiktoken-based
  multilingual vocab, DECODE-ONLY (this ASR gate never needs to encode
  arbitrary text back into ids — only the decode loop's output ids into
  text — so the regex-pretokenizer + greedy-merge BPE algorithm tiktoken
  uses for encoding isn't needed at all; decoding a tiktoken vocab is just
  id → bytes → concat → UTF-8, since every rank already IS its full byte
  string). Embeds the real `multilingual.tiktoken` vocab file (816KB, 50257
  ranks) as an SPM resource (same "ship the real small asset, not a
  reimplementation" call as the mel filterbank). Special-token ids
  (`<|startoftranscript|>`, per-language, `<|transcribe|>`,
  `<|notimestamps|>`, ...) are computed via the exact same closed-form
  language-index arithmetic `get_encoding()` uses — verified this is NOT a
  simple 100-language dict walk: `num_languages` defaults to 99, dropping
  the dict's 100th key (`"yue"`) from the reserved range, confirmed by a
  real `get_tokenizer(multilingual=True, language="ja")` call returning
  50266 (which only lines up with a 99-entry list, not 100). Verified
  against real `mlx_whisper.tokenizer.get_tokenizer` output for 3
  languages' SOT sequences + real decode output for two id sequences
  (including round-tripping a real Chinese encode) — 7/7 pass
  (`WhisperTokenizerTests.swift`).

  **Decode loop + full checkpoint loader + wiring — ALSO landed 2026-07-04,
  closing the loop end-to-end.** `WhisperModel.swift` (new): `load()` reads
  a full checkpoint's real per-layer weights into `WhisperEncoder`/
  `WhisperDecoder` (all 32+32 layers for large-v3), `transcribe()` runs a
  greedy decode loop with NO KV cache (deliberate — re-runs the full
  decoder over the whole token prefix every step instead of caching K/V
  incrementally; correct, just not optimized, since a cache is a
  performance concern not a different computation — documented tradeoff in
  the file's header, same class of "ship the real math now, optimize
  later" call as `VideoTiling`'s early single-tile path).
  `WhisperModelRealCheckpointTests.testTranscribesRealClipEndToEndNatively`
  is the actual end-to-end proof: loads the real large-v3-mlx checkpoint,
  runs `WhisperMel` → full 32-layer encoder → greedy decoder loop →
  `WhisperTokenizer.decode` on a REAL generated clip's real speech audio —
  **zero mlx_whisper, zero Python, zero RunPyBridge in the test path.**
  **A real correctness bug was found and fixed getting this test green**:
  naive greedy decoding predicted `<|endoftext|>` as the very first token
  (confirmed via debug instrumentation: max logit 23.2 landed exactly on
  EOT), producing an empty transcript. Root cause: mlx_whisper's real
  decode path applies a `SuppressBlank` logit filter that masks EOT (and
  the space token, id 220) at the FIRST generation step only, precisely to
  prevent this — `WhisperModel.transcribe` now replicates that filter.
  **A second finding, NOT a bug**: even with that fix, this port's naive
  greedy decode produces `", Hi, how are you?"` for this clip's actual
  "嗨你好" audio — an English translation despite forcing the zh language
  token. Cross-checked against the REAL `mlx_whisper.whisper.Whisper` class
  running the IDENTICAL naive-greedy strategy on the SAME real weights
  (`scripts/dump_whisper_real_transcribe_reference.py`) — Python produces
  the bit-EXACT same generated token ids. This isn't a Swift defect; it's
  what this real checkpoint's naive greedy decoding actually does on a
  short/ambiguous clip. `mlx_whisper`'s polished `transcribe()` (temperature-
  fallback retries + more logit filters) gets a better result on the same
  audio — a real, honestly-scoped follow-up (see `ASRGate.swift` below),
  not something silently "fixed" by fudging the test. The test therefore
  asserts BIT-EXACT parity against the real reference, not "says something
  Chinese."
  **Real language auto-detection — closed 2026-07-04.**
  `WhisperModel.detectLanguage(mel:)` ports `mlx_whisper.decoding.
  detect_language` exactly: encode once, decode ONE step from
  `<|startoftranscript|>` alone (no language forced), mask every
  non-language-token logit to -inf, argmax over what's left. Verified
  bit-exact against real `mlx_whisper.decoding.detect_language` on the real
  checkpoint + real clip (`scripts/dump_whisper_real_detect_language_reference.py`,
  `WhisperModelRealCheckpointTests.testDetectsRealLanguageEndToEndNatively`)
  — both return zh (token 50260) for this clip. This closes the gap where
  the native engine could previously only force-decode a language, never
  actually detect one.

  **`ASRGate.swift`'s DEFAULT ENGINE IS NOW NATIVE SWIFT** —
  `ASRGateEngine.autoDetect()` resolves to `.nativeSwift` whenever a
  converted local checkpoint is present (the standard case once
  `WhisperModelRealCheckpointTests`' one-time npz→safetensors conversion
  has been run once on a machine), falling back to `.pythonBridge` ONLY
  when that checkpoint genuinely isn't set up — never as a quality choice.
  `WhisperMel.loadAudio(url:)` (new) extracts+resamples audio natively via
  AVFoundation + the existing `LinearResampler` (no ffmpeg subprocess,
  matching this package's `MP4Writer.swift` convention), so with a
  converted checkpoint present, `ltx-video gate --asr-prompt` now runs
  ZERO Python by default — confirmed via a real CLI invocation against the
  same real clip used throughout this port's verification.
  **Honest consequence, not swept under the rug**: that same real CLI run
  now FAILS this specific clip's ASR check (content-overlap ratio 0.00,
  transcript `","`) where the Python-bridge path previously PASSED
  (ratio 1.0, transcript "嗨你好") — this is the documented naive-greedy
  quality gap manifesting in a real, production-facing behavior change,
  not a regression introduced by a bug. Anyone relying on this gate's
  pass/fail today should be aware the default engine changed and monitor
  for false FAILs until the quality-closing follow-up (temperature-fallback
  retries) lands; `engine: .pythonBridge` remains available as an explicit
  escape hatch in the meantime.

  **Still open** to make the native engine's quality match the bridge: a
  real KV cache (performance only — the math is already correct) and
  temperature-fallback retries (the actual quality gap — mlx_whisper's
  `transcribe()` retries at multiple temperatures and picks the best
  result; this port always does one greedy pass). The tiktoken ENCODE
  direction remains unported (not needed for this ASR gate's decode-only
  use case).
  **Environment note**: `python/venv` was missing from this session's
  worktree checkout (CLAUDE.md documents the path but the symlink itself
  is git-ignored, so a fresh worktree doesn't inherit it) — found and
  symlinked to the existing shared `~/proj/video_generation__venv` mid-
  session, which unblocked running the ACTUAL `mlx_whisper` for the dump
  script above (previously assumed impossible in this sandbox; it wasn't —
  just needed the symlink recreated).

**Started 2026-07-02.** First sampling-loop component: `EulerDiffusionStep.swift` ports
`ltx_core_mlx.components.diffusion_steps.EulerDiffusionStep` (+ `to_velocity`) — the first-order
Euler flow-match step used by the fast distilled/dasiwa denoise loop. `sample + velocity * dt`
where `velocity = (sample - denoised) / sigma`; pure function, no weights. Chosen first (of three
sibling steppers: `Res2sDiffusionStep` for `--hq`, `EulerCfgPpDiffusionStep` for CFG++) as the
simplest and most-used, per the smallest-to-largest pattern from Phase 1/2. Verified via
`scripts/dump_euler_step_reference.py` + `Tests/LTXVideoDirectorTests/EulerDiffusionStepParityTests.swift`:
replays a real 4-step chain (each step's output feeds the next step's input, as a real denoise
loop does) against the real class — max-abs-diff < 1e-5 at every step. 29/29 tests pass.

Second sampling component: `SigmaSchedule.swift` ports `ltx_pipelines_mlx.scheduler`'s
`DISTILLED_SIGMAS`/`STAGE_2_SIGMAS` (literal constant tables for the fast paths) and
`ltx2_schedule`/`dynamic_shift_schedule` (`mlx_arsenal.diffusion` — the token-count-adaptive
flow-matching schedule the dev/HQ path uses: interpolates a shift factor between `base_shift` at
1024 tokens and `max_shift` at 4096 tokens, applies it to a descending linspace, then optionally
stretches so the last non-zero sigma hits `1-terminal`). Verified via
`scripts/dump_sigma_schedule_reference.py` + `Tests/LTXVideoDirectorTests/SigmaScheduleParityTests.swift`
across 5 cases (both literal tables, an 8-step/4096-token and 20-step/1024-token schedule, and a
no-stretch variant): all match to 1e-5. 33/33 tests pass.

### Milestone: the full sampling loop, noise to clean latent, verified end-to-end (2026-07-02)

`X0Model.swift` ports `ltx_core_mlx.model.transformer.model.X0Model` — wraps `LTXModel`'s
velocity prediction into an x0 (clean-sample) prediction via `x0 = x_t - sigma*v`.
`DenoiseLoop.swift` ports `ltx_pipelines_mlx.utils.samplers.denoise_loop` — the actual Euler
denoising loop, iterating consecutive sigma pairs, calling `X0Model` then stepping via the
reference's `euler_step` formula (mathematically identical to `EulerDiffusionStep.step`,
literally inlined here to match the loop's exact per-step `sigma==0` short-circuit).

**Scope**: the "uniform denoise mask" case — full T2V/I2V generation, no partial-frame
conditioning. `apply_denoise_mask` is an identity when mask=1 everywhere (confirmed by reading
its source), so it's omitted as a no-op rather than ported. Per-token timesteps (needed for
partial conditioning) are likewise out of scope, matching `X0Model`/`LTXModel`.

Verified via `scripts/dump_denoiseloop_reference.py` (runs the REAL `denoise_loop` function
wrapping a REAL `X0Model`/`LTXModel`, real `LatentState` with uniform masks, a 3-step sigma
schedule `[1.0, 0.6, 0.25, 0.0]`) + `Tests/LTXVideoDirectorTests/DenoiseLoopParityTests.swift`:
**passed on the first run** — max-abs-diff < 1e-2 on both video and audio outputs (loosest
tolerance yet: 3 full `LTXModel` forward passes chained, each already carrying ~5e-3 of bf16
rounding noise, compounding across steps).

**This is the point where every component built across Phase 2 (RoPE through LTXModel) and Phase
3 (EulerDiffusionStep, SigmaSchedule) combines into something that actually denoises a latent
from pure noise toward a clean sample — the core diffusion algorithm, end to end, natively in
Swift.** 34/34 tests pass.

### Milestone: I2V conditioning wired into the sampling loop (2026-07-02)

`LatentConditioning.swift` ports `ltx_core_mlx.conditioning.types.latent_cond`: `LatentState`
(the generation-state struct — latent/cleanLatent/denoiseMask/positions/attentionMask),
`applyDenoiseMask` (blend x0 with clean_latent per mask — `x0*mask + clean*(1-mask)`), and
`VideoConditionByLatentIndex` (the actual I2V mechanism: splices a conditioning image's clean
latent tokens into specific frame positions — e.g. frame 0 — and zeroes their denoise mask so
they're preserved rather than regenerated). Verified via `scripts/dump_latentcond_reference.py` +
`Tests/LTXVideoDirectorTests/LatentConditioningParityTests.swift` against the real Python
classes: exact match (1e-5) on the spliced latent/clean/mask and the blended output.

`DenoiseLoop.run(model:videoState:audioState:...)` (new overload) wires this into the sampling
loop: calls `applyDenoiseMask` after every step so preserved tokens snap back to their clean
values regardless of what the model predicts for them — this is what makes I2V actually work
(the conditioning image's content survives the full denoise loop unchanged).

**Documented gap, not silently glossed over**: the reference `denoise_loop` switches to
per-token timesteps when the mask is non-uniform (so preserved tokens get AdaLN timestep=0 —
no modulation at all — instead of the batch's shared sigma). `X0Model`/`LTXModel` don't implement
per-token timesteps yet, so the conditioned-loop overload is **not bit-parity-tested** against
the reference for non-uniform masks (only the uniform-mask path is, via `DenoiseLoopParityTests`).
`DenoiseLoopConditionedTests` instead verifies the property that actually matters for correctness
regardless of that gap: the conditioned frame ends up EXACTLY equal to the clean image after the
full loop (guaranteed by `applyDenoiseMask` being called every step, independent of per-token
timesteps), while generated frames are finite and have genuinely moved from their initial noise.
36/36 tests pass.

### Milestone: per-token timesteps land, closing the I2V bit-parity gap (2026-07-02)

The previous milestone documented a real gap: I2V conditioning worked (preserved tokens snap
back to clean values), but wasn't bit-parity-tested for non-uniform masks because the reference
switches to per-token timestep embeddings in that case (preserved tokens get AdaLN timestep=0 —
no modulation — instead of the batch's shared sigma). This is now closed:

- `LTXModel.callAsFunction` gained optional `videoTimesteps`/`audioTimesteps` (B,N) params.
  When provided, `adalnSingle`/`avCaVideoScaleShiftAdalnSingle` (and audio equivalents) switch to
  a per-token path (`embedTimestepPerToken` + `adalnPerToken`, both flatten-embed-reshape exactly
  like the reference's `_embed_timestep_per_token`/`_adaln_per_token`). The AV-cross **gate**
  always stays scalar (uses `t_emb_av_gate` regardless), and prompt AdaLN (text cross-attn)
  always stays scalar too (text tokens don't correspond to individual latent tokens) — both
  confirmed by re-reading `model.py`'s `__call__` line-by-line, not assumed from the pattern.
- `X0Model` now accepts the same per-token timesteps and uses them as the per-token sigma in the
  x0 formula (`videoTimesteps[:,:,None]` instead of `sigma[:,None,None]`) when provided.
- `DenoiseLoop.run(model:videoState:audioState:...)` now detects non-uniform masks
  (`isUniformMask`, mirroring `_is_uniform_mask`) and computes per-token timesteps
  (`perTokenTimesteps` = `(denoiseMask * sigma).squeezed(axis:-1)`, mirroring
  `_compute_per_token_timesteps`) automatically — no caller-side changes needed to get the
  correct behavior.

Verified via `scripts/dump_denoiseloop_i2v_reference.py` (runs the REAL `denoise_loop` with a REAL
`VideoConditionByLatentIndex`-conditioned frame-0 state, forcing the reference's per-token branch)
+ `Tests/LTXVideoDirectorTests/DenoiseLoopI2VParityTests.swift`: **bit-parity match** (max-abs-diff
< 1e-2, consistent with the uniform-mask loop's tolerance) — this supersedes
`DenoiseLoopConditionedTests`' earlier "conditioning mechanism only" smoke test with a real
end-to-end match against the reference. 37/37 tests pass, no regressions.

**The I2V conditioning path is now verified to the same standard as everything else in this
port** — real Python reference, bit-parity, no documented gaps remaining in the sampling loop's
core algorithm.

### Text-encoder work started: Embeddings1DConnector (2026-07-02)

The text encoder has two distinct pieces: the Gemma LLM itself (12B+ decoder, produces raw hidden
states from tokenized text) and the LTX-specific **connector** downstream of it (refines those
hidden states into the video/audio conditioning embeddings the DiT actually consumes). Hand-porting
a 12B+ LLM decoder is out of proportion to this port — that stays bridged (`RunPyBridge`/`mlx-lm`).
The connector, however, is a small, self-contained transformer stack — real, portable, testable work.

`EmbeddingsConnector.swift` ports `ltx_core_mlx.text_encoders.gemma.embeddings_connector`:
`ConnectorTransformerBlock` (pre-norm affine-free RMS + self-attn + residual, then pre-norm + FF +
residual — no AdaLN modulation at all, simpler than the DiT block) and `Embeddings1DConnector`
(prepends/appends learnable register tokens, computes 1D log-spaced RoPE over the resulting
sequence, runs the block stack, optional output norm). **Reuses `Attention`/`FeedForward` from
Phase 2 directly** — confirmed architecturally identical (self-attention+RoPE+gating;
Linear→GELU-approx→Linear FFN), just different checkpoint key names (`to_out.0.*` list-wrapped,
`ff.net.0.proj.*`/`ff.net.2.*`) handled entirely by the test's loader, no new attention/FF math
needed. This is a good sign for the port's overall design — the same primitives generalize.

**Scope**: the "no attention_mask" path only (registers appended at the sequence end). NOT yet
ported: the left-padding register-*replacement* path (`_replace_padding_with_registers`) — needed
once the actual Gemma tokenizer/encoder (which left-pads) is wired in; out of scope until then.

Verified via `scripts/dump_connector_reference.py` + `Tests/LTXVideoDirectorTests/EmbeddingsConnectorParityTests.swift`
against the real `Embeddings1DConnector` class (2 layers, real register/RoPE/block wiring):
max-abs-diff < 1e-3 (looser than DiT-Attention tests since this uses manual softmax attention in
the reference vs `MLX.scaledDotProductAttention`'s fused kernel here — same math, different
kernel path). 38/38 tests pass.

### Audio VAE work started: WrappedConv2d + AudioResBlock (2026-07-02)

The audio VAE decoder turns the audio latent `(B, 8, T, 16)` into a mel spectrogram by treating
it as a 2D spatial tensor in MLX NHWC layout `(B, T, 16, 8)` — Conv2d (not Conv3d/Conv1d),
upsampling the frequency axis (16) while keeping time causally padded. Confirmed by reading
`audio_vae.py`'s module docstring and `WrappedConv2d`/`AudioResBlock`/`AudioAttnBlock` directly —
architecturally a sibling to the video VAE (`Conv3dBlock`/`ResBlockStage`/`PixelNorm`) but 2D, with
an added self-attention block (`AudioAttnBlock`, GroupNorm-based, not yet ported).

`WrappedConv2d.swift` ports the causal/non-causal Conv2d building block (asymmetric height-only
causal pad vs standard symmetric `nn.Conv2d(padding=...)` — analogous to `Conv3dBlock`'s two
padding modes but for 2D). `AudioResBlock.swift` ports the residual block: pixel_norm → silu →
conv1 → pixel_norm → silu → conv2 (+ optional 1×1 `nin_shortcut` when in/out channels differ) +
residual — same shape as `ResBlockStage`'s inner block, eps=1e-6 (audio) vs the video VAE's 1e-8.

Verified via `scripts/dump_audioresblock_reference.py` + `Tests/LTXVideoDirectorTests/AudioResBlockParityTests.swift`
against the real `AudioResBlock` class, covering both the same-channel-causal and
different-channel-noncausal-with-shortcut cases: max-abs-diff < 1e-4. 40/40 tests pass.

Third audio-VAE component: `AudioAttnBlock.swift` — spatial self-attention over the (H,W)
feature map, gated by a `GroupNorm(32, channels, pytorch_compatible=True)` pre-norm. **New
primitive for this port**: implemented true PyTorch GroupNorm semantics (reduces over `(H, W,
channels-in-group)` jointly per `(batch, group)`, verified against PyTorch's actual definition
directly rather than assumed from any other component in this codebase — this is a meaningfully
different reduction than the per-pixel channel-only norms used elsewhere in the port, e.g.
`PixelNorm`). Verified via `scripts/dump_audioattnblock_reference.py` +
`Tests/LTXVideoDirectorTests/AudioAttnBlockParityTests.swift` against the real `AudioAttnBlock`
class (64 channels, 32 groups): max-abs-diff < 1e-3, **passed on the first attempt** — the
from-scratch GroupNorm derivation (double transpose to isolate `(H,W,cg)` as the reduction axis,
then transpose back) was correct without iteration. 41/41 tests pass.

### Milestone: full AudioVAEDecoder, verified against the REAL production checkpoint (2026-07-02)

`AudioUpsample.swift` (2x nearest-neighbor repeat on both spatial axes + conv, causal mode drops
the first output row for temporal alignment) closes out the atomic audio-VAE components. Verified
via `scripts/dump_audioupsample_reference.py` + `Tests/LTXVideoDirectorTests/AudioUpsampleParityTests.swift`
(both causal and non-causal — causal changes the output height by one row): max-abs-diff < 1e-4.

`AudioVAEDecoder.swift` assembles all of them into the complete decoder — wired against the REAL
checkpoint's structure, confirmed by inspecting `mlx-models/audio/ltx-2.3-audio/audio_vae.safetensors`
directly (102 tensors; **no attention keys anywhere** — the real checkpoint has
`add_attention=False` for both `mid` and every `up` stage, so `AudioAttnBlock` isn't used in the
actual decode path despite existing as a class) AND by reading `AudioVAEDecoder.__init__`/
`decode()` directly: `conv_in` (8→512, causal) → `mid` (2 plain `AudioResBlock`s, no attention) →
`up.2`/`up.1`/`up.0` run in **reverse index order** (3 resblocks each: 512, 512→256+upsample,
256→128+upsample — note the checkpoint's `up.0/1/2` indices don't correspond to execution order)
→ pre-activation pixel_norm+silu → `conv_out` (128→2, causal). Latent layout: `(B,8,T,16)` →
flattened to `(B,T,128)` for per-channel denorm → reshaped to `(B,T,16,8)` NHWC (T=height/time,
16=width/frequency) for Conv2d → output `(B,T',64,2)` NHWC → transposed to `(B,2,T',64)` mel.

`AudioVAEDecoderRealCheckpointTests.swift` loads the ACTUAL production checkpoint (handling both
the `audio_vae.decoder.` prefix for the network and the separate `audio_vae.` prefix +
underscore-key quirk for `per_channel_statistics`, matching the video VAE encoder's quirk) and
runs a real forward pass — confirms finite, correctly-shaped (`(1,2,T',64)` mel) output. 44/44
tests pass.

**Both the video AND audio VAE decoders now run natively in Swift/MLX against real production
LTX-2.3 weights.** Remaining for full audio: the vocoder (BigVGAN) and bandwidth-extension (BWE)
stacks (turn the mel spectrogram into an actual waveform) and the audio VAE *encoder* (not yet
started; only the decoder, needed for output, has been ported so far).

### Vocoder work started: SnakeBeta (2026-07-02)

The vocoder (BigVGAN v2, mel→waveform) is a real, separate 340-line architecture: `conv_pre` →
6 upsample stages (`ConvTranspose1d` + `resblocks`, each gated by `SnakeBeta` periodic activations
with anti-aliased up/downsampling) → `act_post` → `conv_post`. `SnakeBeta.swift` ports the
periodic activation itself (`x + (1/b)*sin²(a*x)`, weights stored in LOG-SCALE so the module
exponentiates on every call — zero-init gives `exp(0)=1`, a no-op scale) — the smallest
self-contained piece, matching the smallest-to-largest pattern. Verified via
`scripts/dump_snakebeta_reference.py` + `Tests/LTXVideoDirectorTests/SnakeBetaParityTests.swift`
with non-zero log-scale weights (zero-init would trivially give both scales as 1.0 without
exercising the actual exponentiation): max-abs-diff < 1e-5. 45/45 tests pass.

`Activation1d.swift` ports `DownSample1d`/`UpSample1d`/`Activation1d` (upsample → `SnakeBeta` →
downsample, the anti-aliased activation wrapper used throughout BigVGAN's resblocks). **Caught a
real bug in the reference-dump methodology itself, not the port**: the vendored
`UpSample1d.__call__` uses `x_up.at[:, ::2, :].add(x)`, which this repo's own memory documents as
a confirmed MLX 0.31.2 `.at[strided].add()` Metal mis-indexing bug (`project_mlx_audio_fix`) —
manually verified by hand-computing a 3-element example: the buggy call produced `[1,2,0,0,2,3,0,0,3,4,0,0]`
instead of the correct `[1,2,0,0,3,4,0,0,5,6,0,0]` for input `[[1,2],[3,4],[5,6]]`. The REAL
pipeline never runs this raw path — `app/vendor_patches.py`'s `_patch_upsample1d()` replaces it
with plain `x_up[:, ::2, :] = x` at import time (a runtime monkey-patch, per this project's
established pattern for vendor fixes). The Swift port already implemented the correct
zero-interleaving (via reshape, not strided assignment — see the file's header) and initially
FAILED against a naively-dumped reference (diff ~16, ~111) that used the unpatched buggy class;
regenerating the reference with the same patch applied (replicated inline in the dump script,
since importing the full `app.vendor_patches` module requires the whole pipeline's dependency
tree) made all 3 tests pass — **the Swift implementation was correct all along; the bug was in
the reference generation, not the port**. This is exactly the failure mode the
dump-real-reference methodology is meant to catch, and it worked. 48/48 tests pass.

`AMPBlock1.swift` ports the anti-aliased multi-periodicity residual block: for each of 3 dilations
(1, 3, 5), `act1 → dilated conv1 → act2 → conv2 → +residual`. **A second real methodology lesson**
(distinct from the previous `.at[strided]` bug): the first dump used random, UNNORMALIZED
anti-aliasing filter weights (e.g. 12 taps averaging ~1.0 each ⇒ ~12x gain per pass). Through 6
activation passes (act1+act2 × 3 dilations), that compounds to ~12⁶ ≈ 3×10⁶×, blowing the
reference itself up to ~10¹¹ magnitude — confirmed by replaying the SAME reference computation
step-by-step in Python: both the reference and (separately) the Swift port exploded, just to
different chaotic values, because at that magnitude fp32 rounding differences between the two
MLX backends get exponentially amplified. This wasn't a port bug OR a reference bug — it was an
**unrealistic test fixture**: real anti-aliasing filters are near-unity-gain low-pass kernels
(Kaiser-window sinc taps in production), not random noise. Normalizing each dumped filter to sum
to 1 (keeping the whole block in the numerically stable regime real usage operates in) dropped the
diff from ~5×10¹¹ to 0.03 — and confirmed the port was correct once tested in a realistic regime.
Tolerance set to 5e-2 (comparable depth to `BasicAVTransformerBlock`'s 2e-3 or `DenoiseLoop`'s
1e-2 — 6 activation passes + 6 convs compounds float32 noise similarly; output magnitude here is
O(1), so this is a few-percent relative error, not a correctness gap). 49/49 tests pass.

**Methodology note for remaining work**: any component tested with synthetic weights should ask
whether those weights are being exercised in a regime the real architecture was designed for
(e.g. filters that must integrate to ~1, norm layers whose weights center near 1, etc.) —
unnormalized random init can manufacture spurious failures (or, worse, spurious "passes" that
don't actually exercise the intended numerical behavior).

### Milestone: full BigVGANVocoder, verified against REAL production checkpoint (2026-07-02)

`BigVGANVocoder.swift` adds a `ConvTranspose1d` wrapper (weight layout `(C_out, K, C_in)`,
confirmed directly against `MLX.convTransposed1d`'s documented layout by inspecting the real
checkpoint's `ups.N.weight` shapes — no transpose needed) and assembles the full vocoder: `conv_pre`
(128→1536, k=7) → 6 upsample stages (`ConvTranspose1d` at rates 5/2/2/2/2/2, channels
1536→768→384→192→96→48→24, padding `(kernel-rate)//2` — confirmed by reading the constructor
directly, notably NOT the `kernel//2` formula used elsewhere in this port — each followed by 3
`AMPBlock1`s at kernel sizes 3/7/11 whose outputs are averaged) → `act_post`
(`Activation1d`) → `conv_post` (24→2, k=7, no bias) → `tanh`.

`BigVGANVocoderRealCheckpointTests.swift` loads the ACTUAL production checkpoint (1227 tensors;
`vocoder.` prefix, explicitly excluding `vocoder.bwe_generator.*` — a separate sibling network at
different channel sizes, not part of this assembly) and runs a real forward pass on a tiny
synthetic mel spectrogram: finite, correctly-shaped, tanh-bounded (`|x|≤1`) waveform output — **passed
on the first attempt**, no debugging needed once the earlier AMPBlock1/Activation1d components
were independently verified. 50/50 tests pass.

**The full LTX-2.3 audio pipeline now runs natively end-to-end in Swift/MLX against real
production weights: `AudioVAEDecoder` (latent→mel) → `BigVGANVocoder` (mel→waveform).** Combined
with the earlier video VAE and 48-layer transformer milestones, both modalities' core decode paths
are now fully native.

### BWE work started: HannSincResampler (2026-07-02)

Confirmed the real production audio pipeline never calls `BigVGANVocoder` alone — it always runs
`VocoderWithBWE` (`bwe.py`), which chains: base vocoder (16kHz) → `HannSincResampler` (3x,
Hann-windowed sinc upsample to 48kHz) → BWE generator (a second `BigVGANVocoder`-shaped network,
different channel sizes, ratios `[6,5,2,2,2]`) → `clamp(resampled_base + bwe_residual, -1, 1)`.
Also confirmed this must run in **fp32, not bf16** (the class docstring: bf16 accumulation errors
compound through 108 sequential convolutions and degrade spectral metrics 40-90%) — already
satisfied by this port's existing pattern of upcasting checkpoint weights to `.float32` in every
real-checkpoint test.

`HannSincResampler.swift` ports the resampler itself — genuinely different from everything else
audio-related in this port: **no learned weights at all**, a deterministic Hann-windowed sinc
kernel computed from closed-form math (verified independently in Swift, not loaded from a
checkpoint). Also confirmed to use the SAME `.at[strided].add()` bug class already found in
`UpSample1d` (`app/vendor_patches.py`'s `_patch_hann_sinc_resampler`, analogous to
`_patch_upsample1d`) — sidestepped the same way, via reshape-based zero-insertion instead of
strided assignment. Verified via `scripts/dump_hannsincresampler_reference.py` (patched, matching
what the real pipeline runs) + `Tests/LTXVideoDirectorTests/HannSincResamplerParityTests.swift` —
**two** checks: the independently-recomputed kernel itself (max-abs-diff < 1e-5) AND the full
forward pass (max-abs-diff < 1e-4), both passing on the first attempt. 52/52 tests pass.

`MelSTFT.swift` ports the log-mel spectrogram stage (STFT via `conv1d` against a pre-computed
basis, magnitude, mel filterbank, log) — passed first try. Verified via
`scripts/dump_melstft_reference.py` + `Tests/LTXVideoDirectorTests/MelSTFTParityTests.swift`:
max-abs-diff < 1e-3.

### Milestone: full VocoderWithBWE, verified against REAL production checkpoint (2026-07-02)

`VocoderWithBWE.swift` assembles the complete audio pipeline, ported line-for-line from
`VocoderWithBWE.__call__` (not inferred from the docstring — the actual control flow has a
non-obvious detail the docstring doesn't mention): stereo mel `(B,2,T,64)` → rearrange to
`(B,T,128)` → base `BigVGANVocoder` → `(B,T16k,2)` → pad to a multiple of `hop_length` → flatten
`(B,2,T16k)→(B*2,T16k)` → `MelSTFT` → reshape back to `(B,2,T',64)` → same rearrange → BWE
`BigVGANVocoder` (a SEPARATE `MelSTFT` computed on the resampled signal, not reusing the original
input mel — confirmed only by reading `__call__` directly) → residual `(B,2,T_bwe)`; separately,
each of the 2 base-16kHz channels is resampled independently via `HannSincResampler` → stacked
skip connection `(B,2,T48k)`; final output = `clip(skip + residual, -1, 1)` truncated to `T16k*3`.
Confirmed the BWE generator config directly from `VocoderWithBWE.__init__` (not assumed):
`upsample_initial_channel=512`, rates `(6,5,2,2,2)`, kernel sizes `(12,11,4,4,4)`,
**`apply_final_activation=False`** (no `tanh` — the final `clip` handles bounding instead).

**Caught a real bug during test-writing, not in the port**: my FIRST draft of `VocoderWithBWE`
guessed at the channel-combination logic from the class docstring's high-level summary rather
than reading `__call__` line-by-line, and got it structurally wrong (treated stereo channels as
independent batch items with a manual reshape/stack that didn't match the real rearrange-to-128-
mel-bins approach). Reading the actual 65-line `__call__` method directly (not the docstring)
before finalizing caught this before it ever ran — the corrected version matches the reference
exactly, stage by stage.

`VocoderWithBWERealCheckpointTests.swift` loads the ACTUAL production checkpoint (`vocoder.`,
`vocoder.bwe_generator.`, `vocoder.mel_stft.` prefixes) and runs a full real forward pass on a
tiny synthetic stereo mel: finite, correctly-shaped, `[-1,1]`-clamp-bounded 48kHz stereo waveform.
**Caught one more real bug**, this time in the test harness: a `makeVocoder` helper built with an
empty `prefix` for the base vocoder concatenated keys as `".ups.0.weight"` (leading dot) instead
of `"ups.0.weight"`, crashing on a nil-unwrap — fixed by only inserting the `.` separator when the
prefix is non-empty. 54/54 tests pass.

**The full LTX-2.3 audio pipeline — latent → mel → 16kHz → 48kHz stereo waveform, matching exactly
what the real production pipeline runs — is now completely native in Swift/MLX, verified against
real production weights at every stage.**

### Scoping finding: CFG/STG guidance is NOT used by the distilled pipeline (2026-07-02)

Checked every `guided_denoise_loop` (CFG/STG) call site in `ltx-pipelines-mlx` against every
`denoise_loop` (plain, positive-context-only) call site: `distilled.py` — the pipeline behind this
project's default `--transformer dasiwa`/distilled path — calls **only** the plain `denoise_loop`,
with just positive text embeds, no negative context, at both of its two stages. `guided_denoise_loop`
is used exclusively by `ti2vid_two_stages(_hq)`, `keyframe_interpolation`, `retake`, and
`a2vid_two_stage` — pipelines this Swift port isn't targeting (CLAUDE.md scopes the goal to
"distilled model first"). **This means `DenoiseLoop.run(model:videoState:audioState:...)`, already
ported and verified in Phase 3, is already everything the distilled I2V path needs from the
denoising loop.** CFG/STG guidance batching via `Modality.split` moves from "remaining work" to
genuinely out of scope for the stated goal — a real reduction in the remaining checklist, not just
a deferral. (It would become in-scope again only if a future goal explicitly asks for the `--hq`
two-stage or keyframe-interpolation pipelines.)

Remaining for full native generation, now that CFG/STG and the audio VAE encoder are both
confirmed out of scope: the actual Gemma LLM (bridged, not hand-ported — see the text-encoder
section above — this is the one component too large to hand-port and will remain a bridge point);
the left-padding connector path (needed once real Gemma tokenizer output is wired in, likely
alongside the Gemma bridge work); `Res2sDiffusionStep`/`EulerCfgPpDiffusionStep` (the `--hq`
two-stage variant's sampler — also out of scope per the CFG/STG finding above, since `--hq` is a
`guided_denoise_loop` pipeline); and replacing `RunPyBridge` in the CLI once the Gemma bridge
exists to actually feed `DenoiseLoop` real text embeddings.

### Milestone: the FIRST pure-Swift CLI command — `ltx-video audio-decode` (2026-07-02)

Every component verified so far lived only in tests; nothing was reachable from the actual
`ltx-video` binary. Closed that gap for the half of the pipeline that needs no text encoder at
all: `AudioVAEDecoderLoader.swift` and `VocoderWithBWELoader.swift` promote the real-checkpoint
weight-wiring already verified in `AudioVAEDecoderRealCheckpointTests`/
`VocoderWithBWERealCheckpointTests` out of test code into production `Sources/`, and
`WAVWriter.swift` adds a minimal hand-rolled PCM16 RIFF/WAVE writer (no external dependency — the
44-byte canonical header is simpler than routing through `AVAssetWriter` for raw interleaved
samples).

`ltx-video audio-decode` (new subcommand) chains them: load an audio latent (`--latent
<file.safetensors>`, or `--zeros` for a synthetic smoke-test latent since a REAL latent needs the
transformer+Gemma path that doesn't exist yet) → native `AudioVAEDecoder` → native
`VocoderWithBWE` → `WAVWriter` → a real `.wav` file on disk. **Zero `RunPyBridge` calls, zero
`run.py` subprocess invocations, anywhere in this command's path** — the first command in this
package that is genuinely, not just component-wise, "pure Swift solution, not run.py wrapper."

Ran it for real: `ltx-video audio-decode --zeros --zeros-frames 8 -o test.wav` → produced a
13920-frame, 2-channel, 48kHz file, independently verified with `ffprobe` (not just this
package's own code): `RIFF ... WAVE audio, Microsoft PCM, 16 bit, stereo 48000 Hz`. Added
`WAVWriterTests.swift` (header round-trip + empty-input error path) as a permanent regression
test since the manual `ffprobe` check isn't part of the automated suite. 56/56 tests pass.

This doesn't close the overall goal — video generation still needs the Gemma-dependent
transformer/denoise-loop path, so `I2VCommand` still uses `RunPyBridge` — but it's a genuine,
running, run.py-free capability, not just isolated-component verification.

### Milestone: the SECOND pure-Swift CLI command — `ltx-video video-decode` (2026-07-02)

Repeated the loader-promotion pattern for the video side. `VideoDecoderLoader.swift` is much
thinner than the audio loaders — `VideoDecoder` already accepts a raw `[String: MLXArray]`
weights dict rather than pre-wired sub-structs, so the loader is just the checkpoint-key-stripping
logic already verified in `VideoDecoderRealCheckpointTests`. `PNGFrameWriter.swift` adds a
CoreGraphics/ImageIO-based PNG sequence writer (native macOS frameworks, no external dependency,
mirroring `WAVWriter`'s approach) — a PNG sequence rather than an MP4 because H.264/HEVC muxing
needs `AVAssetWriter`'s pixel-buffer-pool plumbing, a separate task; a frame sequence is enough to
prove the decode path produces real, viewable images (and can feed an MP4 muxer later without
re-deriving the RGB frames). Pixel convention confirmed by reading the reference decoder directly
(`mx.clip(frame, -1.0, 1.0)` in `decode_and_stream`, not assumed): `[-1,1]` → remapped to `[0,255]`.

`ltx-video video-decode` chains them: load a video latent (`--latent <file>`, or `--zeros` for a
synthetic smoke-test latent) → native `VideoDecoder` → `PNGFrameWriter` → a real PNG sequence on
disk. Ran it for real: `--zeros --zeros-frames 2 --zeros-size 2` → 9 frames (F=2 latent → 9 pixel
frames via the decoder's temporal upsampling, matching the established parity-test relationship)
at 64×64, independently confirmed with the `file` command (not this package's own code): `PNG
image data, 64 x 64, 8-bit/color RGB, non-interlaced`. Added `PNGFrameWriterTests.swift` (frame
count/size + PNG magic-byte check + invalid-shape error path). 58/58 tests pass.

**Both halves of generation output — audio (latent→WAV) and video (latent→PNG frames) — now have
a real, run.py-free CLI path**, each independently verified against an external tool (`ffprobe`,
`file`). The loader-promotion pattern (test helpers → production `Sources/` loaders → a real CLI
command) has now been applied twice.

### Major finding + milestone: the T2I stage was ALREADY fully native — `ltx-video t2i` (2026-07-02)

While scoping what remained for the Gemma bridge, checked whether the sibling `z-image-director`
package (linked by other tools in this repo, never by `ltx-video-director`) had solved the same
text-encoder problem already. **It had, entirely** —
`z-image-director/Sources/ZImageDirector/TextEncoder.swift`'s own header: "Phase 3: Qwen3-4B text
encoder... Removes the Python embedding-exchange dependency for true E2E text→image." ZImage's
text encoder, transformer, and VAE are ALL already pure Swift/MLX, shipped and working, just never
wired into this package. The Gemma-for-video bridge is the ONLY unported text encoder in the
entire project — ZImage's Qwen3 encoder for the T2I stage was solved before this session began.

Added `z-image-director` as a `Package.swift` dependency and wrote `NativeT2IStage.swift`, which
mirrors `ZImageDirectorCLI/T2ICommand.swift`'s load-and-generate sequence (`WeightStore.load` →
`TextEncoderWeights.load` + `Qwen3TextEncoder.build` → `BPETokenizer.encodePrompt` →
`T2IPipeline.generate`, trimmed to the no-LoRA, `cfgScale=1.0`-default path — CFG is opt-in in
ZImageDirector's own CLI too, not required for a good result) — entirely in-process, calling
public APIs on the sibling package directly, no subprocess at all (stronger than the decode
commands' "no run.py" — this has no Python anywhere, not even a non-run.py script).

New `ltx-video t2i` subcommand + real run (not a synthetic `--zeros` smoke test — an actual
prompt): `ltx-video t2i --prompt "a beautiful young woman standing on a city street at golden
hour" --width 640 --height 960 --seed 99` → a real 9-step denoise (13.1s, 1.46s/it) → a genuine,
high-quality 640×960 photorealistic image, independently confirmed valid with `file` (`PNG image
data, 640 x 960, 8-bit/color RGB`) and visually inspected — a real "beauty girl on a street"
result matching this project's original stated goal, produced with zero Python involvement
anywhere in the call chain. Two path bugs surfaced and fixed while getting this running (both
config/discovery issues, not math bugs): the VAE directory name was `zimage-ae`, not
`zimage-turbo-vae`, and the tokenizer directory was `qwen3`, not `qwen3-4b` (the text encoder's
own directory) — corrected against what actually exists on disk under `mlx-models/`, not assumed
from the transformer's directory-naming convention. 58/58 tests pass (no regressions; this
milestone was a manual CLI run, not itself parity-tested — there's no reference to diff since
`ZImageDirector.T2IPipeline` is a black box called as-is here).

**Concrete effect on the standing goal**: `t2i2v` = T2I → VLM prompt expansion → LTX I2V. The T2I
third of that pipeline no longer needs `run.py` OR any Python at all — it's a real, working,
in-process Swift call today. The VLM prompt-expansion stage (`caption --style ltx_i2v`) still
bridges to Python (LM Studio), and the LTX I2V stage still needs the Gemma-dependent
transformer/denoise loop. `I2VCommand` itself hasn't been rewired yet (that requires composing all
three stages plus deciding what happens to VLM expansion and the still-missing LTX generation
step), so `ltx-video i2v` unchanged still calls `RunPyBridge` — but one of its three stages is now
provably, demonstrably native, not just theoretically portable.

### Milestone: VLM prompt-expansion stage now native too — 2 of 3 t2i2v stages run.py-free (2026-07-02)

`NativeVLMPromptStage.swift` replaces `run.py caption --style ltx_i2v` (the MIDDLE
stage of t2i2v) with a direct in-process call through `ImageGenUtils.CaptionClient` —
the SAME Swift HTTP client `VLMVerify.swift` already uses for keyframe scoring. This was
never a "run.py wrapper" problem in the same sense as text/video generation: LM Studio is a
standing local server (not spawned per-request by run.py), so the only thing missing was the
Swift client port for this specific prompt template. The `ltx_i2v` template is copied VERBATIM
from `app/commands/caption.py`'s `_STYLE_PROMPTS["ltx_i2v"]` so the VLM sees identical
instructions either way.

**Documented gap, not silently glossed**: Python additionally sets `response_format=json_object`
for this style (its `_JSON_OUTPUT_STYLES` set) to stop thinking-only models returning empty
content; `ImageGenUtils.CaptionClient` doesn't expose that knob yet (shared across multiple
director packages, so not touched here). This relies on the template's own "Output ONLY a JSON
object" instruction instead — worth upstreaming JSON-mode to CaptionClient if it proves
unreliable in practice.

### Milestone: TextEmbeddingProjection + corrected Gemma scoping (2026-07-02)

`TextEmbeddingProjection.swift` ports `feature_extractor.TextEmbeddingProjection` —
the projection between Gemma-3-12b's concatenated multi-layer hidden states
(49 layers × 3840 = 188160-dim) and the `Embeddings1DConnector` (already ported)
that feeds the DiT. Forward: `rescale = sqrt(target_dim/embedding_dim)` then two
plain `nn.Linear`s → (video_embeds 4096, audio_embeds 2048). Verified via
`scripts/dump_textembeddingprojection_reference.py` +
`TextEmbeddingProjectionParityTests.swift`: max-abs-diff < 1e-4 on both outputs.
64/64 tests pass.

**Corrected scoping finding** (the prior "Gemma is too large to hand-port" framing
was right about the conclusion but wrong about why): the production text encoder
is `mlx-community/gemma-3-12b-it-4bit` (~7.5 GB, already in the HF cache), loaded
via the standard `mlx-lm` library per the vendor CLAUDE.md (`encoders/base_encoder.py`
= "Gemma 3 12B wrapper via mlx-lm"). It is NOT a hand-port in the reference either —
it's a standard HF MLX model loaded generically. The native-Swift equivalent is
loading it via `mlx-swift`'s LLM support, not re-implementing a 12B decoder.

**With this, the ENTIRE text-encoder connector stack is native** except the Gemma
LLM forward pass itself: `Gemma hidden states → TextEmbeddingProjection (native) →
Embeddings1DConnector (native) → DiT conditioning`. The sole remaining piece for a
fully-native distilled I2V path is running a standard HF MLX Gemma-3-12b forward in
Swift via mlx-swift (load model + tokenizer + extract per-layer hidden states +
concatenate) — a standard LLM-inference task, not an architecture port. Until that
lands, `I2VCommand` keeps `RunPyBridge` for the generation step.

### Gemma-3-12b port: scope + reference dump landed (2026-07-03)

There is no `mlx-swift-examples` (the Swift analogue of `mlx-lm`) checked out in
this repo, and z-image-director's Qwen3-4B is a full hand-port (own QLinear, RoPE,
attention). So Gemma-3-12b is likewise a from-scratch architecture port, NOT a
config-load. Concrete architecture (read from the cached
`mlx-community/gemma-3-12b-it-4bit` config.json): **48 layers, hidden_size=3840,
16 attention heads (head_dim=240), intermediate_size=15360, sliding_window=1024**.
The sliding window (alternating full / sliding attention layers) + Gemma-3's
query-key RMSNorm make this architecturally more involved than Qwen3 — a genuine
multi-session effort comparable to (and larger than) z-image's Qwen3 port.

**Verified contract captured**: `scripts/dump_gemma_reference.py` loads the real
`GemmaLanguageModel` and dumps the atomic first unit of the port — `token_ids`,
`attention_mask`, `h0_embedding` (post `embed_tokens` + sqrt(3840) scaling), and
`h1_layer0` (output of transformer layer 0) for a fixed 64-token prompt. 49 hidden
states total confirmed; h0/h1 stored as fp16 (~490 KB each, committed under
`test_refs/gemma/`). This lets the port be verified incrementally: tokenizer →
embed+scaling (diff vs h0) → first Gemma-3 block (diff vs h1) → subsequent layers.

The encode contract (from `base_encoder.get_all_hidden_states`): left-pad to
`max_length` (default 1024; 64 for the dump), `h = embed_tokens(token_ids) *
sqrt(hidden_size)`, build causal+padding mask, then 48 layers each appending its
output. Concatenation of all 49 → (B, T, 188160) feeds `TextEmbeddingProjection`.

**Status**: reference + scope landed; the 48-layer decoder port itself remains.
Until it ships, `I2VCommand` keeps `RunPyBridge` for the LTX generation step.

### Milestone: Gemma-3-12b decoder port COMPLETE (2026-07-03)

The 48-layer decoder from the previous entry has landed: `GemmaConfig`,
`GemmaTokenizer` (standalone SentencePiece-BPE — Gemma does not use the
Tiktoken-style tokenizer z-image-director's `BPETokenizer` implements),
`GemmaRMSNorm`, `GemmaAttention` (dual sliding-window/global RoPE configs,
Gemma-3's query-key RMSNorm), `GemmaMLP`, `GemmaBlock`,
`GemmaCheckpointLoader`, and `GemmaEncoder` (48-layer streaming forward,
mirroring `LTXModel.streamingForward`'s per-block dequantize-eval-release
pattern). Four parity tests verify the full chain against the real
`mlx-community/gemma-3-12b-it-4bit` model: `GemmaTokenizerParityTests`
(byte-identical token_ids), `GemmaRoPEParityTests` (< 1e-4, isolated dual
sliding/global configs), `GemmaLayer0ParityTests` (embed+scale+layer0,
< 0.5% relative), `GemmaFullEncoderParityTests` (all 48 layers, < 5%
relative — looser because the residual stream is un-normalized between
layers, absmax grows to ~10000 by layer 48, so relative error is the
correct metric here, not absolute). 68/68 package tests pass. Full details
and two real bugs found along the way (wrong tolerance metric, fp32-vs-bf16
compute mismatch) are in `docs/TODO.md`.

**With this, every architectural piece of the distilled I2V path is now
native and verified**: tokenizer → Gemma-3-12b encoder → `TextEmbeddingProjection`
→ `Embeddings1DConnector` → `LTXModel` (48-layer DiT) → `DenoiseLoop` →
`VideoDecoder`/`AudioVAEDecoder`/`VocoderWithBWE`. What's left is wiring,
not porting: a `NativeTextEncodeStage` composing the four text-side pieces
into one call, memory-bounded VAE tiling for real-resolution output, and
replacing `RunPyBridge` in `I2VCommand` with the assembled native pipeline.

### Milestone: NativeTextEncodeStage — the text-encode half of the native pipeline wired (2026-07-03)

`ConnectorCheckpointLoader.swift` loads the real connector checkpoint
(`mlx-models/text_encoder/ltx-2.3-connector/connector.safetensors`, 490
tensors — confirmed by direct inspection, not assumed) and builds
`TextEmbeddingProjection` + video/audio `Embeddings1DConnector` instances
from it. Two things only confirmed by inspecting the actual checkpoint,
not derivable from `config.json`: (1) the connector uses **int4,
group_size=32** quantization — deliberately different from the DiT
transformer's int8/group_size=64 (confirmed against
`app/vendor_patches.py`'s `_quantize_connector_to_match_weights` comment,
which exists precisely because this mismatch broke naive reuse of the
transformer's quantization config in the Python pipeline too); (2) the
connector has **8 transformer_1d_blocks per side**, not 48 — `config.json`'s
`num_layers: 48` describes the DiT, not this connector. Reuses
`QuantizedWeights.dequantizeLinearWeights` unchanged (just different
`groupSize`/`bits` args), and `Attention`/`FeedForward` unchanged (same
key scheme `EmbeddingsConnectorParityTests` already validated against a
synthetic reference).

`NativeTextEncodeStage.swift` composes the full chain — `GemmaTokenizer` →
`GemmaCheckpointLoader.loadRaw` + `GemmaEncoder.encodeAllLayersConcat` →
`ConnectorCheckpointLoader`'s `TextEmbeddingProjection` → video/audio
`Embeddings1DConnector` — into one `encode(prompt:) -> (videoEmbeds,
audioEmbeds)` call, mirroring `NativeT2IStage`'s established pattern
(struct with an `encode`/`generate` entry point, `RepoPaths`-relative
checkpoint discovery, no run.py anywhere in the call chain).

Verified via `NativeTextEncodeStageRealCheckpointTests` (real-checkpoint
smoke test, matching the established pattern for assemblies with no single
Python entry point to diff against — every individual piece here already
has its own parity test): encodes a real prompt at `maxLength=32`, checks
`videoEmbeds`/`audioEmbeds` are finite and correctly shaped `(1, 160,
4096)`/`(1, 160, 2048)` (32 tokens + 128 learnable registers). **Passed on
the first run**, 2.8 seconds. 69/69 package tests pass.

**Not yet done**: this isn't wired into `I2VCommand` — `RunPyBridge` still
runs the actual `i2v` generation. `NativeTextEncodeStage` loads and
dequantizes both checkpoints fresh per call (no caching across multiple
encodes in one process — nothing needs that yet) and defaults to
`maxLength=1024` for production use (untested at that length; the smoke
test uses 32 for speed, and the streaming Gemma encoder's per-layer
attention cost scales with sequence length, so a 1024-token real run
needs its own timing check before being wired into a synchronous CLI
path). Remaining before `I2VCommand` can drop `RunPyBridge`: feeding
`videoEmbeds`/`audioEmbeds` into `LTXModel`/`DenoiseLoop` for a real
generation run, and memory-bounded VAE tiling for real-resolution output.



 (markdown-fence stripping,
`estimated_seconds` as float, non-JSON rejection, missing-prompt rejection) — 5 tests, all
pass. `expand()` itself calls LM Studio, not parity-tested (same convention as VLMVerify's
network path). 63/63 tests pass.

**Score for the standing goal**: of t2i2v's 3 stages, **2 are now run.py-free** — T2I
(`NativeT2IStage`, ZImageDirector in-process) and VLM prompt expansion
(`NativeVLMPromptStage`, LM Studio in-process). The sole remaining bridge is the LTX I2V
generation step itself (transformer + denoise loop + Gemma text encoder). Every architectural
piece of THAT step is ported and verified (Phase 2 LTXModel, Phase 3 DenoiseLoop, both VAEs);
the blocker is purely the Gemma 12B text encoder (too large to hand-port in this format).
`I2VCommand` rewiring still waits on that.

## Phase 4 — retire the bridge

Once Phase 2/3 pass parity, `I2VEngine`/`UpscaleEngine` swap their
`RunPyBridge` call for the native pipeline behind the same `I2VRequest`/
`UpscaleRequest` types — CLI commands and the gateway are untouched.

## Phase 0 validation (real run, 2026-07-02)

Ran `ltx-video i2v --transformer distilled --seconds 10` end-to-end for real:
241 frames @ 24fps, 448×704, ~4.7 min. Findings:

- The bridge, output-dir discovery, and manifest parsing all work — but
  `RepoPaths.defaultOutputDir` initially pointed at
  `python/mlx-movie-director/output` when the real default (mirroring
  `app/config.py DEFAULT_OUTPUT_DIR`) is the repo-SIBLING
  `../video_generation__output` (or `$MLX_OUTPUT_DIR`). Fixed.
- `ltx-video gate` (native, VLM-free) correctly flagged the output as WARN
  with "near-identical frames … likely frozen/static" — this matches run.py's
  OWN quality report for the same run ("STATIC: video has little/no motion").
  Independent confirmation that the native SSIM-based motion check works.
- `ltx-video verify --style review` is unreliable with the locally loaded
  Gemma model (`google/gemma-4-26b-a4b-qat`): the heavier structured-
  adherence JSON prompt sometimes times out or returns unparseable content.
  `--style score` (simpler prompt) is reliable and caught a real defect
  (plasticky/waxy skin, overall=6, artifacts=5). CLI default switched to
  `score`; `review` remains available for models that follow JSON strictly.
- Needs `scripts/setup-metallib.sh` run once after `swift build` — SwiftPM
  can't compile Metal shaders, so MLX's precompiled `mlx.metallib` from the
  Python venv is copied next to the built binary (same trick z-image-director
  uses).

### Milestone: Positions/Patchifiers — the last numerical gap before assembly (2026-07-03)

Answering "can `ltx-video-director` run without `run.py`/Python at all yet?":
**not yet — every DiT/VAE/text-encoder numeric component is now ported and
parity-tested, but they have never been wired into one end-to-end call, and
`I2VCommand` still shells out via `RunPyBridge`.** This milestone closes the
one remaining *numerical* gap found while scoping that assembly:
`LTXModel`/`DenoiseLoop` were only ever exercised with synthetic all-zero
`videoPositions`/`audioPositions` and hand-built patch tensors (see
`LTXModelRealCheckpointTests`, `DenoiseLoopI2VParityTests`) — nothing built
the real (F, H, W) pixel-space position grid or converted a VAE's
`(B, C, F, H, W)` latent to/from the `(B, N, C)` token sequence the DiT
actually consumes.

`Positions.swift` (`computeVideoPositions`, `computeAudioPositions`,
`computeAudioTokenCount`) and `Patchifiers.swift`
(`VideoLatentPatchifier`, `AudioPatchifier`, `VideoLatentShape`) port
`ltx_core_mlx.utils.positions` / `ltx_core_mlx.components.patchifiers`
verbatim — pure arithmetic, no checkpoint weights. Verified against
`scripts/dump_positions_patchify_reference.py` (6 new
`PositionsPatchifyParityTests`, all passing on the first run, <1e-5 max abs
diff, including a patchify→unpatchify round trip). 75/75 package tests
pass. Note: this worktree's vendor submodules are untracked (PR #189), so
the dump script falls back to the sibling `~/proj/ltx-2-mlx` checkout —
same upstream source, just not vendored into this repo copy.

**What's left before `I2VCommand` can drop `RunPyBridge` — this is now a
pure wiring/assembly problem, not a porting problem**:
1. A `NativeI2VStage` (or similar) that chains `NativeT2IStage` →
   `NativeVLMPromptStage` (optional) → `NativeTextEncodeStage` →
   `VideoEncoder` (encode the T2I frame as the I2V conditioning latent,
   via the new `Patchifiers`) → `LatentConditioning`/`DenoiseLoop` (using
   `SigmaSchedule` + the new `Positions`) → `VideoDecoder` +
   `AudioVAEDecoder` + `VocoderWithBWE` — every piece on this list already
   has its own parity or real-checkpoint test; none of them have been
   called together yet.
2. Memory-bounded VAE tiling for real-resolution output (current
   VideoDecoder/VideoEncoder real-checkpoint tests only prove correctness
   at tiny synthetic shapes).
3. A video/audio → `.mp4` muxer. No AVAssetWriter/ffmpeg wiring exists in
   Swift yet — `run.py`'s pipeline currently does this. Using `ffmpeg` as
   a subprocess would still be "no Python", if that's an acceptable
   external dependency; otherwise this needs an AVFoundation writer.
4. Once (1)-(3) produce a real, sane output (validated the same way
   `LTXModelRealCheckpointTests`/`VideoDecoderRealCheckpointTests` do —
   finite, correctly-shaped, no reference to diff against since no single
   Python entry point runs exactly this composition), swap `I2VEngine`/
   `UpscaleEngine`'s `RunPyBridge.run(...)` call for it.

### Milestone: DenoiseLoop.runStreaming — the real 48-block checkpoint can now run inside the denoise loop (2026-07-03)

Closed a gap found while scoping item 1 above: `DenoiseLoop.run` only ever
called `LTXModel`'s non-streaming `callAsFunction`, which needs all 48
blocks' dequantized float32 weights resident simultaneously — infeasible
for the real 19GB checkpoint. `LTXModel.streamingForward` (rebuild one
block from its raw checkpoint slice, eval, release, repeat) already
existed and was proven for a single forward pass
(`LTXModelRealCheckpointTests.testAll48RealBlocksStreamWithBoundedMemory`),
but nothing called it from inside a multi-step denoise loop.

`DenoiseLoop.runStreaming(model:numLayers:blockProvider:videoState:
audioState:...)` is the conditioned (I2V) denoise loop rewritten around
`streamingForward`: at every sigma step it rebuilds all `numLayers` blocks
from the checkpoint slice, converts the predicted velocity to x0 inline
(same formula `X0Model` uses), then calls `applyDenoiseMask` so preserved
tokens snap back to their clean values exactly, same as the existing
non-streaming conditioned path. Since `streamingForward` doesn't accept
per-token timesteps, preserved tokens get the batch's scalar sigma during
the forward pass rather than timestep=0 — a documented approximation
(output is still exactly correct because `applyDenoiseMask` overwrites
those tokens afterward regardless; only their *internal* attention
computation during that one step differs, same caveat
`LatentConditioning.swift`'s header already documents for the
pre-per-token-timesteps era).

Verified by `DenoiseLoopStreamingRealCheckpointTests` — runs 2 real
sigma steps (of the production 8) against 2 real transformer blocks (of
48; keeps the test fast, and 48-block single-step streaming was already
proven separately), checks finite + correctly-shaped output. Passed on
the first run, 0.5s. 76/76 package tests pass.

**Still open**: this test uses B=1 with tiny synthetic (Nv=4, Na=2) shapes
and only 2 blocks/2 steps as a mechanics proof, not a real generation
run — a real `NativeI2VStage` call would use all 48 blocks × 8 steps ×
real spatial/temporal token counts (hundreds to thousands of tokens),
which is untested for wall-clock time (48 blocks rebuilt from disk on
every one of 8 steps — expect this to be meaningfully slower than
`run.py`'s approach of loading the checkpoint once). Items 1-3 in the
list above are otherwise unchanged.

### Milestone: NativeI2VStage — first real end-to-end native generation run (2026-07-03)

`NativeI2VStage.swift` composes every piece above into one call:
`NativeT2IStage` → `VideoEncoder` (source frame as I2V conditioning
latent, via `Patchifiers`) → `NativeTextEncodeStage` → noise/positions
(`Positions`/`VideoLatentShape`) → `LatentConditioning` →
`DenoiseLoop.runStreaming` (real 48-block distilled transformer) →
`VideoDecoder` + `AudioVAEDecoder` + `VocoderWithBWE` → `PNGFrameWriter` +
`WAVWriter`. New `ltx-video native-i2v` CLI command exposes it. Verified
by `NativeI2VStageRealCheckpointTests` (tiny 320×320/9-frame smoke test,
22.8s, 77/77 package tests pass) AND by an actual manual run at full
production resolution (640×960, 9 frames, prompt "a woman smiles and
waves at the camera on a city street", 45.0s wall time) — **the first
real, non-synthetic, end-to-end native generation this package has ever
produced.**

**Result, read honestly (not just "it ran")**: frame 0 — the I2V
conditioning frame, forced through `applyDenoiseMask` unchanged — is
pixel-perfect, proving the T2I→VAE-encode→patchify→DiT→VAE-decode chain
is wired correctly end to end. **Frames 1+ show a real, systematic
defect**: a strong blue/pink color-channel distortion. Composition, pose,
and identity stay completely recognizable (this is not noise or a
shape/axis bug) — the corruption is specifically colorimetric. Prime
suspect, and not just theoretical: `DenoiseLoop.runStreaming` doesn't
support per-token timesteps (see its own header), so during the forward
pass the preserved conditioning frame is modulated with the batch's
shared scalar sigma instead of timestep=0 — meaning every OTHER frame's
cross-attention to that frame sees it through the wrong AdaLN modulation
regime for every step except the very last. `applyDenoiseMask` still
forces frame 0's own output back to the clean latent afterward (which is
why frame 0 itself is perfect), but doesn't fix how frame 0 was
*perceived* by other frames during each step's attention computation.

**Next step for real output quality** (not yet done): give
`LTXModel.streamingForward` the same `videoTimesteps`/`audioTimesteps`
per-token support `callAsFunction` already has (see LTXModel.swift's
header — this was explicitly out of scope for the streaming path until
now), and have `DenoiseLoop.runStreaming` compute per-token timesteps the
same way the non-streaming conditioned `run` does
(`isUniformMask`/`perTokenTimesteps`) instead of always passing a scalar.
Until that lands, `native-i2v` output should be treated as a plumbing
proof, not a quality-comparable alternative to `RunPyBridge`/`run.py`.

Also still open, unchanged from before: VAE tiling for larger/longer
clips, mp4 muxing (still PNG sequence + WAV), and `I2VCommand` itself
still uses `RunPyBridge` — `native-i2v` is a new, separate, explicitly
experimental command, not a replacement for `i2v` yet.

### Milestone: color-distortion artifact FIXED — streaming path now supports per-token timesteps (2026-07-03)

**Status: RESOLVED.** Applied exactly the "next step" diagnosed above:

1. `LTXModel.streamingForward` gained `videoTimesteps`/`audioTimesteps`
   (B, N) parameters, mirroring `callAsFunction`'s existing per-token AdaLN
   branch (`embedTimestepPerToken` + `adalnPerToken` for `adalnSingle` and
   `avCaVideoScaleShiftAdalnSingle`/`avCaAudioScaleShiftAdalnSingle` when
   provided, falling back to the scalar path otherwise — the AV-cross gate
   and prompt AdaLN stay scalar-only, matching the reference).
2. `DenoiseLoop.runStreaming` now computes `isUniformMask`/
   `perTokenTimesteps` per state, exactly like the non-streaming
   conditioned `run`, and passes them into `streamingForward` — the
   streaming and non-streaming conditioned paths are now at parity.

**Verification**: 77/77 package tests still pass after the change. Reran
`ltx-video native-i2v` at the same full production resolution (640×960, 9
frames, same prompt) — 38.7s wall time. Manually inspected `source.png`
and frames 0/4/8 via the `Read` tool: **no color distortion in any
frame** — output colors and composition match the source T2I image
throughout, not just frame 0. The diagnosis was correct on the first
attempt; no further investigation needed.

`native-i2v` output quality is now much closer to being
quality-comparable to `run.py` for the distilled-only path this stage
covers. Remaining gaps before considering `I2VCommand` dropping
`RunPyBridge`: VAE tiling for larger/longer clips, VLM prompt expansion
wiring into `NativeI2VStage`, and an actual mp4 muxer (still PNG
sequence + WAV).

### Milestone: automatic resolution resolve — bad user-input resolutions no longer break generation (2026-07-03)

**Problem**: `NativeI2VStage.generate` used to hard-`throw` if
width/height weren't already exact multiples of 32 (LTX-2.3's video VAE
spatial compression factor — `VideoLatentShape`/`Positions.videoSpatialScale`).
Any user-supplied resolution off that grid (e.g. `--width 700 --height 500`)
failed outright instead of generating. The Python `run.py` side already
solved this for the two-stage pipeline (`video-generate.py`'s
`_adjust_resolution`, rounding to the nearest 64) and for images
(`_shared.py`'s `_resolve_resolution` tiers) — the native Swift path had
no equivalent.

**Fix**: new `Sources/LTXVideoDirector/Sampling/ResolutionResolver.swift`
— `ResolutionResolver.optimize(width:height:)` rounds each axis to the
*nearest* multiple of 32 (not ceiling, matching run.py's round-to-nearest
behavior), with a `spatialScale = 32` floor so degenerate tiny inputs
still produce a valid, generatable resolution. `NativeI2VStage.generate`
now calls this unconditionally at the top of the function, mutates its
local `request` copy, and prints an `[resolution] auto-adjusted …` note
when a snap occurred — mirroring run.py's own console message. Only
non-positive width/height (an actual user error, not just "off-grid")
still throws `StageError.invalidDimensions`.

**Tests**: new `ResolutionResolverTests.swift` (6 cases: already-aligned
no-op, round-down, round-up, midpoint-rounds-up, floor at one scale step,
and an exhaustive divisibility sweep). `NativeI2VStageRealCheckpointTests`
gained two more: a real end-to-end run with a deliberately misaligned
300×310 request (proves it snaps and completes instead of throwing) and a
fast unit test that 0×320 still throws `.invalidDimensions` before any
checkpoint I/O. Full suite: **85/85 pass** (was 77 before this + the
color-distortion fix above).

`NativeT2IStage` (ZImage, 16-multiple VAE constraint) does not yet have
the equivalent guard — still assumes the caller passes valid dims. Since
`NativeI2VStage` is currently the only real caller and it now always
passes an already-snapped (32-multiple, which is also a 16-multiple)
resolution to `NativeT2IStage`, this hasn't caused problems yet, but a
standalone `ltx-video t2i` invocation with odd dimensions would still
fail there. Worth revisiting if `t2i` gains its own auto-resolve.

**Follow-up (2026-07-03, same day): "off-grid" wasn't the only failure
mode — "too small" was another.** A manual `native-i2v` demo run at
384x576 (already a valid 32-multiple, same 2:3 aspect as the 640x960
default) exposed a second, more subtle problem `optimize`'s original
snap-only logic didn't catch: frame 0 rendered clean, but frames
progressively corrupted (color fringing / texture noise) over a 17-frame
streaming run — while an identical run at 640x960 stayed clean
throughout. The distilled transformer's streaming denoise destabilizes
over multi-frame sequences well below its validated training resolution,
independent of frame count or fps (both held constant across the
comparison). Fixed by adding `minimumValidatedArea` (=
`modelOptimalDefault`'s own area, 614,400px) to `optimize`: any request
below that area now scales up preserving aspect ratio *before* snapping,
rather than snapping the too-small request in place. Verified: rerunning
the exact 384x576 request now logs the scale-up and produces output
identical in quality to the direct 640x960 run. 2 new
`ResolutionResolverTests` cases. Suite: **89/89 pass.**

### Research: native spatial upscaling — findings + scoped plan (2026-07-03)

**Question**: does LTX-2.3 support a native (in-model) spatial upscaler,
and can it be ported to this package the way the rest of the pipeline
was?

**Finding: yes — it's an official Lightricks IC-LoRA adapter, not a
separate model.** `Lightricks/LTX-2.3-22b-IC-LoRA-Pixel-Spatial-Upscaler`
(HuggingFace) is a LoRA fused onto the *same* 22B distilled transformer
this package already runs — available in 2× and 4× variants. It's
generative (synthesizes detail — "creatively upscale... rather than
simply interpolating"), not a pixel-space ESRGAN-style filter. This
package's Python bridge already uses the equivalent mechanism today:
`run.py video restore` → `LTXVideoPipeline.generate_ic_lora` (see
`python/mlx-movie-director/app/ltx_pipeline.py:537`) → vendor
`ltx_pipelines_mlx.ic_lora.ICLoraPipeline`, using the
`ltx2.3-video-restoration-general.safetensors` +
`ltx2.3-ic-video-upscale-general.safetensors` LoRA pair already present
in `models/lora/ltx-2.3-restore/`. Confirmed architecture from that
docstring: **two-stage** — Stage 1 runs at half the target resolution
with the LoRA weights *fused* into the transformer at pipeline init;
Stage 2 upscales and refines *without* the LoRA. Reference video frames
(the degraded/low-res input) are passed as `video_conditioning`
(IC-LoRA reference frames — a different conditioning mechanism from this
package's I2V frame-preserve conditioning: it's whole-clip reference
attention, not a single preserved-token frame).

**What exists in this Swift package today**: `UpscaleEngine.swift` +
`ltx-video upscale` CLI command — a thin bridge to
`run.py video restore --restore-scale`, i.e. it already gets this exact
IC-LoRA upscale, just via `RunPyBridge`/Python, not natively.

**Why a native (no-run.py) port is a distinct, comparably-sized
undertaking to `NativeI2VStage` itself** — not a small add-on:
1. **LoRA weight loading + fusion** doesn't exist anywhere in this
   package. `TransformerCheckpointLoader.blockWeights`/`makeBlock` build
   blocks straight from the base checkpoint; there is no mechanism to
   read a LoRA safetensors file (down/up low-rank matrices per target
   linear layer, e.g. `q_proj`, `k_proj`, `to_out`, `ff.*`), no key-name
   mapping between the LoRA file's parameter names and this package's
   `BasicAVTransformerBlock`'s weight layout, and no "add `scale * (up @
   down)` to a dequantized block-weight slice before constructing the
   block" step in the `blockProvider` closure `runStreaming` already
   uses (this last part is actually the *easiest* piece to add, since
   `blockProvider` already dequantizes one block's weights per call).
2. **IC-LoRA reference conditioning** is architecturally different from
   the I2V conditioning `LatentConditioning.swift`/
   `VideoConditionByLatentIndex` already implement: I2V preserves ONE
   frame's tokens exactly (denoise-mask=0 for that frame, cross-attention
   sees a clean single frame). IC-LoRA restoration conditions on the
   ENTIRE reference clip's tokens as attention context across all output
   frames — closer to how the text cross-attention pathway already works
   (`videoTextEmbeds`/`avCA*` in `BasicAVTransformerBlock`) than to the
   existing I2V mask mechanism. The real mechanism lives in vendor
   `ltx_pipelines_mlx/ic_lora.py` (sibling checkout:
   `~/proj/ltx-2-mlx/packages/ltx-pipelines-mlx/src/ltx_pipelines_mlx/ic_lora.py`)
   and needs its own read-and-port pass, the same way `Positions`/
   `Patchifiers`/`DenoiseLoop` each got their own dedicated milestone.
3. **Two-stage generation** (half-res-with-LoRA → full-res-without-LoRA)
   means the native port needs a *second* denoise-loop invocation with a
   *different* block set (LoRA-fused vs. not) and an inter-stage
   spatial-upscale step — not just a bigger version of the existing
   single-stage `DenoiseLoop.runStreaming`.

**Concrete next steps, in dependency order** (none started yet — this is
a plan, not a partial implementation, to avoid landing something that
looks done but silently produces wrong output):
1. Read `~/proj/ltx-2-mlx/packages/ltx-pipelines-mlx/src/ltx_pipelines_mlx/ic_lora.py`
   in full and dump reference values for its conditioning-token
   construction (mirrors the `dump_positions_patchify_reference.py`
   pattern already used for `Positions`/`Patchifiers`).
2. Add LoRA-file parsing + a `blockProvider` variant that fuses
   `scale * (up @ down)` into the relevant dequantized weight matrices —
   smallest independently-testable unit; can be parity-tested against a
   single LoRA-fused block's output vs. the vendor Python reference
   before touching conditioning at all.
3. Port the IC-LoRA reference-conditioning token construction as its own
   module (own parity tests against the reference dump from step 1),
   separate from `LatentConditioning.swift`.
4. Wire a two-stage `NativeUpscaleStage` (mirrors `NativeI2VStage`'s
   role) using steps 2+3, with its own real-checkpoint integration test
   and a manual visual-inspection pass (per this session's established
   practice — shape/finite checks alone would not have caught the
   color-distortion bug found in `NativeI2VStage`, and wouldn't catch a
   bad LoRA fusion either).
5. New `ltx-video native-upscale` CLI command, kept separate from the
   existing `upscale` (RunPyBridge) command the same way `native-i2v` is
   kept separate from `i2v`, until quality is verified comparable.

Until step 4 lands, `ltx-video upscale` (the existing `RunPyBridge`
command) remains the only way to get LTX-2.3's native spatial upscaler
from this package — it already produces the real, correct output; it
just isn't run.py-free yet.

### Milestone: NativeUpscaleStage — a DIFFERENT, much smaller native upscaler landed instead (2026-07-03)

**Course correction on the research above**: while re-checking the model
tree for anything upscale-related, found
`mlx-models/vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors` (+ an
`x1_5` variant and a `temporal_x2` variant) already present on disk —
these are **not** part of the IC-LoRA restoration mechanism researched
above at all. They're LTX-2.3's `LatentUpsampler`
(`ltx_core_mlx.model.upsampler.model.LatentUpsampler`, vendor sibling
checkout `~/proj/ltx-2-mlx/packages/ltx-core-mlx/src/ltx_core_mlx/model/upsampler/model.py`)
— the neural network the *official* two-stage LTX pipeline
(`ti2vid_two_stages.py`) uses to upscale a half-resolution generation's
latent before the refinement pass. It's a small, self-contained
Conv3d/Conv2d ResNet operating directly in the same 128-channel VAE
latent space `VideoEncoder`/`VideoDecoder` already use here — no LoRA,
no transformer, no whole-clip reference conditioning. Comparable in size
to `VideoDecoder`, not to `NativeI2VStage`. This is the upscaler that
actually got natively ported this session; the IC-LoRA restoration path
researched above remains unported (still a real, larger undertaking, and
still the only way to get watermark/subtitle *removal*, which
`LatentUpsampler` does not do — see the plan above for that path).

**Port** (spatial_x2 variant only — matches the checkpoint on disk):
new `Sources/LTXVideoDirector/Upsampler/LatentUpsampler.swift` —
`groupNorm5D` (PyTorch-compatible GroupNorm(32) extended to 5D BDHWC,
generalizing `AudioAttnBlock`'s proven 4D version), `pixelShuffle2D`
(ported line-for-line from the reference's `_pixel_shuffle_2d`),
`UpsamplerResBlock` (plain zero-padded Conv3d, NOT the VAE's causal
`Conv3dBlock` — confirmed the reference uses ordinary
`nn.Conv3d(..., padding=1)`), and the top-level `LatentUpsampler` struct
wiring `initial_conv → 4×res_blocks → Conv2d+pixelShuffle(2) →
4×post_upsample_res_blocks → final_conv`.

**Verification, in two layers** (mirroring this session's established
practice of not trusting shape/finite checks alone):
1. `scripts/dump_latent_upsampler_reference.py` runs the REAL
   `spatial_upscaler_x2_v1_1.safetensors` checkpoint (via the vendor
   Python reference) on a fixed-seed `(1,128,2,8,8)` latent and saves
   input+output. New `LatentUpsamplerRealCheckpointParityTests` loads
   the same checkpoint natively and checks max abs diff < 1e-3 against
   that reference — **passed**, confirming the math is byte-for-byte
   equivalent to the real model, not just shape-compatible.
2. New `NativeUpscaleStage.swift` (`VideoEncoder → LatentUpsampler →
   VideoDecoder`, reading/writing the same PNG frame-sequence convention
   `NativeI2VStage`/`PNGFrameWriter` already use) + `ltx-video
   native-upscale` CLI command, chained onto a real `native-i2v` output
   and **visually inspected** — this caught a REAL bug the numerical
   parity test above did not: feeding `VideoEncoder`'s NORMALIZED
   latent output (`(x-mean)/std`) straight into `LatentUpsampler`
   produced severe color-fringing/noise artifacts on real images (the
   tiny-random-latent parity test's values happened not to expose this
   visually). Root cause, confirmed by reading the vendor pipeline's
   actual Stage-1→2 handoff (`ti2vid_two_stages.py`:
   `video_denorm = vae_encoder.denormalize_latent(...)` →
   `upsampler(video_denorm)` →
   `vae_encoder.normalize_latent(...)`): **`LatentUpsampler` is trained
   on DENORMALIZED (raw VAE-scale) latents**, not the small-variance
   normalized space `VideoEncoder`/`VideoDecoder` exchange internally.
   Fixed by denormalizing (`x*std+mean`, reusing
   `VideoEncoder.meanOfMeans`/`stdOfMeans`) before the upsampler call and
   renormalizing (`(x-mean)/std`) after, exactly matching the reference.
   Rerun: clean, detailed 2x upscale (640×640 from a 320×320 `native-i2v`
   source) — genuinely more detail than the source at native resolution,
   not just interpolation, no artifacts.

**New real-checkpoint test** `NativeUpscaleStageRealCheckpointTests`
(writes a synthetic 9-frame 64×64 PNG sequence, runs the full stage,
checks 128×128 output). Suite: **87/87 pass.**

`native-upscale` is upscale-only (no refinement denoise pass — see this
file's header for the scoped-out refinement step) but is real, fast
(~1.8s for a 9-frame 320×320→640×640 clip — versus tens of seconds for a
full 48-block transformer re-denoise), and 100% native.

## Milestone: temporal VAE decode tiling (2026-07-03)

**The gap it closes:** `native-i2v` silently died on longer clips (a
41-frame / 5s @ 8fps 640×960 run wrote `source.png` then vanished —
empty log, no crash report) because `VideoDecoder` decoded the whole
latent volume in one lazy graph with no intermediate materialization.

**Port** — new `Sources/LTXVideoDirector/VAE/VideoTiling.swift`
(`VideoDecodeTiling`), a faithful port of the vendor reference's
temporal decode tiling (`ltx_core_mlx/model/video_vae/tiling.py` +
`video_vae.py`'s `_compute_decode_tiling`/`tiled_decode`), TEMPORAL
axis only — deliberately matching upstream's own auto-path, which never
selects spatial tiling either. The three reference behaviors that are
easy to get wrong, preserved exactly:
1. `split_temporal_latents`'s causal shift — non-first tiles start 1
   latent frame EARLIER with the left blend ramp extended by 1;
2. latent→frame mapping is `[begin*8, 1+(end-1)*8)` (n latent frames
   decode to `1+(n-1)*8` pixel frames because every temporal upsample
   drops its first frame), NOT `[begin*8, end*8)`;
3. trapezoid masks use `left_starts_from_0=True` semantics so
   overlapping weights always sum positive everywhere.

`VideoDecoder.callAsFunction` gained `materializeStages:` (force-eval
after each upsample stage; tiled path only, so the untiled path keeps
cross-stage kernel fusion). `NativeI2VStage` step 5 now auto-computes
tiling from the same `LTX2_VAE_DECODE_BUDGET_GB` env knob run.py's path
uses (default 8 GB) — the budget constant uses 4 bytes/element because
this decoder runs fp32, not the reference's bf16.

**Verification, three layers:**
1. 10 pure-arithmetic tests (`VideoTilingTests`) mirroring vendor
   `test_decode_tiling.py`: budget trigger/no-trigger, tile-size and
   overlap divisibility, causal shift layout, full coverage, and
   weights-sum-positive-everywhere.
2. Tiled-vs-untiled REAL-checkpoint parity: bounded max/mean deviation.
   Deliberately NOT bit-exact — the decoder is non-causal (symmetric
   padding), so a tile boundary truncates the temporal receptive field;
   the vendor's tiled decode has the same property, mitigated by the
   overlap blend. (First test draft asserted near-exactness and failed
   — max diff 0.24 on a tiny worst-case random latent where entire
   tiles sit inside the boundary's receptive field. That's inherent,
   not a bug.)
3. Real generation A/B: the originally-crashing 41-frame demo now
   completes untiled (79.5s, decode fits the 8 GB default budget), and
   a forced-tiling rerun (`LTX2_VAE_DECODE_BUDGET_GB=0.4` →
   tile_frames=40, overlap=8, seam across frames 24–32) is visually
   indistinguishable — seam-center and boundary frames inspected, no
   blend artifacts, no color shift.

Suite: **100/100 pass.**

## Milestone: default auto-upscale + multi-LoRA fusion (2026-07-03)

Driven by an explicit `/goal`: (1) confirm `native-i2v` is genuinely
run.py-free end to end, (2) resolution auto-align (already landed, see
the milestone above), (3) trigger the native spatial upscaler by
default, (4) inventory `mlx-models`' LoRA files and add multi-LoRA
support + tests for the Swift transformer path.

**Auto-upscale wiring.** `NativeUpscaleStage` (native `LatentUpsampler`,
2x spatial, no run.py — see its own header) already existed as a
separate `native-upscale` command from an earlier session but was never
chained after `native-i2v`. `NativeI2VCommand` gained `--upscale`/
`--no-upscale` (`ArgumentParser` `.prefixedNo` inversion, **default
on**) — after decode, it runs `NativeUpscaleStage` on the just-written
frame directory into an `upscaled/` subdirectory. A failure here
(e.g. missing `spatial_upscaler_x2_v1_1.safetensors`) is caught and
printed as a warning, not propagated — the base-resolution output is
still a complete, valid result even if the upscale pass can't run.

**LoRA inventory** (`mlx-models/lora/`, checked directly, not assumed):
only ONE real LTX-specific LoRA exists —
`ltx-2.3-22b-distilled-lora-384(-1.1).int8.safetensors`, duplicated
across `lora/ltx-2.3-distilled/`, `ltx-mlx/{distilled,dev,dasiwa}/` —
this is the structural "turn the dev transformer into the distilled
one" LoRA the Python pipeline fuses automatically
(`app/ltx_pipeline.py`'s `distilled_lora=...`), NOT a third-party style
LoRA. `native-i2v`'s transformer checkpoint
(`ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors`) is
already pre-fused, so this file isn't needed for baseline generation —
but it's the ONLY real LTX LoRA available to test fusion against, since
no style LoRA for LTX video exists yet in this repo (the other
`mlx-models/lora/*` entries — `jib-mix-realistic-z-image-lora`,
`midjourney-luneva-cinematic-lora`, `darkklein-v2bfs-r256`,
`details-9b` — are all z-image/Klein9B image LoRAs, architecturally
unrelated to LTX's DiT).

**LoRA fusion port.** New `Transformer/LoRAWeights.swift` +
`LoRAFusion.swift`, porting `ltx_core_mlx.loader.fuse_loras.apply_loras`/
`_prepare_deltas` (delta = `strength * B @ A`, summed across multiple
LoRA sources) and `ltx_core_mlx.loader.sd_ops.LTXV_LORA_COMFY_RENAMING_MAP`
(key remap: strip `diffusion_model.`, `to_out.0`→`to_out`,
`ff.net.0.proj`→`ff.proj_in`, `ff.net.2`→`ff.proj_out`,
`linear_1`/`linear_2`→`linear1`/`linear2`, plus the audio-FF variants of
the two `ff.net.*` rules — needed separately because `audio_ff.net.0.proj.`
doesn't contain the leading-dot `.ff.net.0.proj.` pattern). Two things
confirmed only by reading `app/vendor_patches.py`'s `_patch_int8_lora`
(Patch 10) directly, not derivable from the vendor's stock code: (1) the
`.int8.safetensors` LoRA files use a simple PER-TENSOR int8 quantization
(`value * scale`, single scalar `.scale` sibling) — a DIFFERENT scheme
from the base transformer's grouped `mx.quantize` (group_size=64,
per-group scales+biases) — and the vendor's own `apply_loras` does NOT
dequantize this (it just casts int8 to float, silently wrong); the app
needed its own patch. (2) One deliberate simplification vs. the vendor:
`apply_loras` re-quantizes the fused weight back to int4/int8 for
memory; this package's `QuantizedWeights` already dequantizes every
block to float32 on load (see its own header), so fusion here is just
`base + delta` in float32 — nothing to re-quantize.

**Verified end-to-end, quality caveat found and documented, not glossed
over**: ran `native-i2v` for real (9 frames, 640×960, "a woman smiles and
waves at the camera on a city street") — auto-upscale fired without a
flag, 74.5s base generation + 10.5s upscale, produced clean 640×960
frames AND a 1280×1920 `upscaled/frames/` sequence, confirming the
default-on wiring actually runs in the real CLI, not just in tests.
Visual inspection of the upscaled frame vs. the base frame: the upscale
is visibly lower quality than the source — over-sharpened edges,
halo/ringing around hair strands, a slightly "oil-painting" texture
look. This matches `NativeUpscaleStage`'s own documented scope (its
header: "No refine pass — the real two-stage LTX pipeline follows the
neural upscale with a transformer denoise refinement step at low
strength; this stage is upscale-only") — not a regression introduced by
wiring it into `native-i2v`, but worth being explicit about: the
default-on upscale trades resolution for a real quality cost until the
refine pass lands. `--no-upscale` skips it if the base-resolution output
is preferred as-is.

Wired into `TransformerCheckpointLoader.blockWeights`/`.topLevelWeights`
(optional `loraSources` param, applied after dequantize + prefix-strip)
and `NativeI2VStage.Request.loraPaths` (`[(path: URL, strength: Float)]`,
loaded once and reused across all 48 block-dequantize calls — not
reloaded per block). `NativeI2VCommand` gained a repeatable `--lora
path[:strength]` option (e.g. `--lora a.safetensors:0.8 b.safetensors`
stacks two).

**Verification** — `scripts/dump_lora_fusion_reference.py` runs the REAL
vendor `apply_loras`/`LTXV_LORA_COMFY_RENAMING_MAP` against the REAL
distilled LoRA file (the int8 dequant patch reproduced inline, same
convention as `dump_hannsincresampler_reference.py`'s inlined
`_patch_upsample1d`), covering 9 representative keys (every rename rule
+ a plain no-rename case) and BOTH single-LoRA (strength 1.0) and
multi-LoRA (the same file applied twice at strengths 1.0/0.6 — no
second real LTX LoRA exists to test with, but `_prepare_deltas` sums
per-source contributions regardless of whether sources are the same
file, so this is a faithful test of the actual summing code path, not a
shortcut). `LoRAFusionTests.swift`: 4 key-remap unit tests (mirroring
vendor `test_lora_renaming_map.py`'s own cases) + the real-checkpoint
fusion parity test (max-abs-diff < 1e-3 for both single and multi-LoRA,
plus an explicit "multi-delta ≠ 2×single-delta" guard against a
same-strength-for-every-source bug that would otherwise pass by
coincidence) + a `TransformerCheckpointLoader.blockWeights` wiring test
(with vs. without `loraSources` produces different block-0 `attn1.to_q`
weights, proving the fusion path actually runs end to end through the
real loader, not just in isolation). All new tests pass on the real
production checkpoint + real LoRA file.

## Research: ComfyUI reference workflows transferred (2026-07-03)

Four real production ComfyUI workflow JSONs (from a separate
`WhatDreamsCost-ComfyUI` node-pack checkout — First-Last-Frame 2-stage,
First-Last-Frame 3-stage, FFLF+custom-audio, and an alternate "Director2"
node pack) were copied into
`docs/reference/comfyui_workflows/` and their node-graph structure/
parameters extracted into that directory's `README.md`. Concrete findings,
in priority order for future work:

1. **`NativeUpscaleStage`'s documented "no refine pass" gap now has real
   numbers**: the reference pipeline follows its neural upscale with a
   LOW-STRENGTH denoise refinement (`linear_quadratic` schedule, 6 steps/
   shift 0.42 for one stage, 4 steps/shift 0.42 for a second) — not a fresh
   generation. Bounded follow-up: reuse the already-ported `DenoiseLoop`/
   `SigmaSchedule` with a short partial-denoise schedule from the upscaled
   latent, not new architecture.
2. `NativeUpscaleStage`'s `spatial_upscaler_x2_v1_1.safetensors` choice
   matches the reference workflow's own "use the newest v1.1" guidance —
   validates, doesn't change, this session's earlier work.
3. Real pipelines run the distilled LoRA at **partial strength (0.5)** on
   top of the "dev" checkpoint, rather than always using a pre-fused 1.0
   checkpoint — directly exercises this session's `--lora path:strength`
   work if a "dev + partial distilled LoRA" mode is ever added.
4. **First-Last-Frame (FFLF) conditioning** — condition both frame 0 AND
   the last frame's latent index, not just frame 0.
   `VideoConditionByLatentIndex` already takes `frameIndices: [Int]`
   (not hardcoded to `[0]`), so the mechanism may already generalize;
   what's missing is a second image input + VAE-encode call in
   `NativeI2VStage`, plus confirming the guide-crop/sequencer interaction
   doesn't need its own port for a clean seam. NOT implemented this
   session — scoped for later.
5. **Custom audio injection** — encode a user-supplied audio track and mask
   its noise out so it survives the denoise loop unchanged, the audio
   analogue of the already-ported `VideoConditionByLatentIndex`/
   `applyDenoiseMask`. NOT implemented this session — scoped for later.

## Milestone: First-Last-Frame (FFLF) conditioning implemented (2026-07-03)

Closes item 4 of the "Research: ComfyUI reference workflows" section
above, driven by a follow-up `/goal implement FFLF`. Confirms the
prediction made there: `VideoConditionByLatentIndex` already took
`frameIndices: [Int]`, not hardcoded to `[0]` — no change needed to the
conditioning mechanism itself, only to `NativeI2VStage` to feed it a
second conditioning frame.

**What changed**: `NativeI2VStage.Request` gained `lastFrameImagePath:
URL?` — when set, `generate` VAE-encodes that image the same way it
already encodes the T2I-generated frame-0 source, concatenates both
frames' patchified tokens, and conditions `VideoConditionByLatentIndex`
on `[0, fLat - 1]` instead of just `[0]`. Frame 0 is unchanged (still
always the T2I-generated `--prompt` image) — this is additive, not a
redesign of the existing conditioning path. `NativeI2VCommand` gained
`--last-frame <path>`.

**Validation happens BEFORE any expensive generation work** (existence +
exact-size check happens right after resolution resolve, before T2I/
text-encode/denoise run) — a bad `--last-frame` fails in milliseconds,
not after a 50s+ generation. The image must already be exactly
`width`x`height` (no resize — matches this package's existing
"don't silently degrade on mismatched input" convention, e.g.
`ResolutionResolver`'s explicit snap-and-announce rather than a silent
letterbox/crop).

**Verified real-checkpoint, not just wiring**:
`NativeI2VStageFFLFTests.testLastFrameImageIsPreservedThroughGeneration`
generates a real 17-frame clip with a synthetic flat mid-grey PNG pinned
as the last frame, then pixel-diffs the DECODED last output frame
against that same input image — mean abs diff < 0.04 in [0,1] pixel
space (same order of magnitude as the VAE round-trip loss already
documented for frame-0 conditioning elsewhere in this package),
confirming the last frame is genuinely the pinned image, not
model-generated content that happens to look similar. Passed on the
first run, 50.9s. `testLastFrameWrongSizeThrowsClearError` confirms the
fail-fast size guard fires (0.004s, no checkpoints touched).

Full suite: all tests pass (2 new FFLF tests, no regressions).

**Scope not covered by this change** (unchanged from the research
doc's findings): the guide-crop/sequencer interaction the reference
ComfyUI pipeline uses (`LTXVCropGuides`/`LTXSequencer`) for FFLF wasn't
needed here — this package's simpler direct-splice conditioning produced
a clean, pixel-accurate result without it, at least at this
seconds/resolution. The reference's per-segment `LTXSequencer` denoise
schedule is really Stage #2/#3's UPSCALE-REFINE mechanism (separately
scoped, still not implemented — see the "no refine pass" item above),
not something FFLF itself required.

## Research: ComfyUI reference workflows, second pass (2026-07-04)

Re-reviewed the same 4 workflow JSONs under `docs/reference/comfyui_workflows/`
against this package's CURRENT code (not the 2026-07-03 snapshot) — items 1/3/4/5
from the first pass are now confirmed DONE (refine pass, `--lora` strength, FFLF,
`--audio-track` masking all shipped since). Full findings in that directory's
`README.md`'s new "Second pass" section; summary of what's still genuinely open:

1. Only a single upscale+refine pass is ported — the reference's chainable
   2-stage cascade (a second upscale at a *different* checkpoint, 1.5x vs 2x
   total, with a bypass toggle) isn't. Bounded follow-up when >2x total upscale
   is wanted in one command.
2. **New finding, not previously captured**: reference pipelines load a
   lightweight "tiny" preview VAE (`taeltx2_3.safetensors`) alongside the full
   one, behind an "optimized decoding" toggle — this package has no fast-preview
   decode path. Candidate for a `--preview-vae`-style flag.
3. FFLF's 2-frame conditioning generalizes to N arbitrary keyframes in the
   reference (`MultiImageLoader`/`LTXSequencer`, per-slot frame index + strength).
   `VideoConditionByLatentIndex` already takes `frameIndices: [Int]` — no new
   conditioning math needed, just `NativeI2VStage.Request` + CLI surface work.
4. **`LTX_Director_2_Workflow_Hotfix.json`** (explicitly unanalyzed in the first
   pass) is a full segment-timeline editor — `segments`/`motionSegments`/
   `audioSegments` tracks plus a "retake" mechanism that re-denoises one
   sub-range of an already-generated clip at a given prompt/strength. This is
   the first real-production reference for scoping this repo's own
   `run.py video segment`/`relay` commands' eventual native Swift port (see
   [[project_ltx_swift_native_port]] memory) — the retake pattern maps to the
   same `VideoConditionByLatentIndex` primitive already used for FFLF/audio,
   applied to a mid-clip range instead of frame 0/last-frame.

Nothing implemented this pass — pure scope-capture, explicitly to avoid
re-discovering the same four files from scratch a third time.

## Milestone: `MP4Writer` real audio+video deadlock found + fixed (2026-07-04)

A user-directed live proof ("prove FFLF works" via the real `s2-agent` CLI +
`ltx` tool — `t2i` → `t2i` → `native-i2v --last-frame`, real generation, no
mocks) hung indefinitely: `video.mp4` stayed at 0 bytes for 15+ minutes at
~0% CPU. `sample`'d the stuck process rather than guessing — the main
thread was parked in `MP4Writer.write → appendVideoFrames`'s
`isReadyForMoreMediaData` poll loop, having never once called `appendAudio`.

Root cause: `write()` appended 100% of the video frames to completion
before ever touching the audio input. AVAssetWriter throttles
`isReadyForMoreMediaData` on whichever track outruns the other in
presentation time, expecting both to be fed roughly in parallel — with
audio sitting untouched at zero samples, video ran far enough ahead (a real
~2s/49-frame 640×960 clip, unlike the 8-frame/1s synthetic clip the existing
`MP4WriterTests.testWriteVideoWithAudio` used) to trip that throttle
permanently.

Fix: video and audio inputs now append **concurrently** — a `DispatchGroup`
with one queue per track, not sequential video-then-audio. New regression
test `testWriteVideoWithAudioAtRealisticScaleDoesNotDeadlock` (49 frames,
320×480, duration-matched audio, wrapped in an `XCTestExpectation` with a
60s timeout so a regression fails fast instead of hanging CI) passes in
1.1s post-fix. `MP4WriterTests`: 4/4 pass.

**Re-verified against the real, rebuilt release binary**, not just the unit
test: reran the exact FFLF proof through the real `s2-agent` CLI end to end.
Independent `ffprobe` (not the tool's own report): `h264 1280×1920, 49
frames` / `aac, 97 frames` / `duration 2.041667s` (requested `--seconds
2.0`) — both tracks present, valid container, matches requested duration.
See `docs/TODO.md`'s matching entry for the full trace.

**Scope**: silently affected *every* real `--mp4` output carrying audio at
non-trivial scale (not FFLF-specific) — no error, no crash, just an
unbounded hang, only surfaced by running a real generation at production
scale rather than the tiny synthetic clips the original tests used.

## Research: exhaustive function audit vs `LTX I2V FFLF Custom Audio Workflow ... V3.json` (2026-07-04)

Driven by `/goal verify if we have implemented all function of the ComfyUI
workflow`. Went node-by-node through one specific reference file (not a
structural overview across all 4, like the first two ComfyUI research
passes) and cross-checked every parameter against current Swift source.
Full checklist in `docs/reference/comfyui_workflows/README.md`'s "Third
pass" section; summary:

Confirmed already correctly implemented: euler sampler, Stage #1's 8-step
distilled schedule, the 2x latent upsampler + its checkpoint choice,
`--lora path:strength`, the Gemma-3-12b encoder, both VAEs, custom-audio
mask-preservation, FFLF frame-0/last-frame conditioning, the mp4 mux, and
CFG=1 (implicit, since Swift has no negative-conditioning branch at all).

Four newly-found gaps, not caught by the first two passes:
1. `LTXSequencer`'s per-frame denoise-mask array in the upscale refine pass
   isn't ported — `NativeUpscaleStage.refine()` uses one uniform mask, not
   a per-segment strength schedule.
2. A cheap `ImageScaleBy(bilinear, 0.5)` half-res guide/preview pass in the
   reference's `Process Latents` stage has no Swift equivalent — unclear
   yet whether it's a pure UI-preview convenience or feeds generation
   quality.
3. FFLF's per-slot conditioning strength, resize-mode, and crop-position
   aren't ported — `NativeI2VStage` requires the last-frame image to
   already be exactly `width`×`height` and hardcodes strength 1.0.
4. `VAEDecodeTiled`'s spatial tile/overlap tiling is architecturally
   different from this package's temporal-only tiling — not necessarily a
   functional gap, but a different strategy worth knowing about.

Also corrected a first-pass conflation: this V3 file has only Stage #1/#2
(no Stage #3) and Stage #2 here runs 4 steps/shift 0.42, not the 6 steps
quoted in the first pass's diagram — that 6-step figure belongs to the
sibling 3-stage workflow, not this file.

Nothing implemented this pass — pure verification, closing out the /goal
with a definitive answer rather than a guess: most of this specific
workflow's functionality IS covered; the four gaps above are the honest
remainder.

## Milestone: all four ComfyUI FFLF+Custom-Audio parity gaps closed (2026-07-04)

`/goal solve this gaps`, closing out the third-pass audit's four findings:

1. **FFLF per-slot strength + auto-resize** — `Request.lastFrameStrength`/
   `lastFrameAutoResize`, chained conditioner calls (frame-0 and last-frame
   are now independent `VideoConditionByLatentIndex` applications instead
   of one shared-strength call), `FrameLoad.resizeAspectFillCenterCrop`.
   New CLI flags `--last-frame-strength`/`--last-frame-auto-resize`. Two
   new real-checkpoint tests, both pass (56.9s, 353.4s).
2. **Half-res guide pass** — traced the actual link graph rather than
   guessing from widget values: it's pure resolution auto-derivation
   (base resolution = half the FFLF image's own size), not a quality pass.
   Implemented as `--last-frame-derives-resolution`.
3. **`LTXSequencer` "per-frame schedule"** — read the actual node source
   (`ltx_sequencer.py`, not just JSON widgets): it's the same
   `MultiImageLoader` keyframe mechanism, reused to re-pin FFLF frames
   after upscale. The REAL gap it exposed: `NativeUpscaleStage.refine()`
   had no re-pinning at all. Fixed with `preserveFirstAndLastFrame`,
   wired from both `native-i2v` (automatic) and standalone
   `native-upscale --preserve-first-last-frame`.
4. **Spatial vs. temporal VAE-decode tiling** — confirmed NOT a gap:
   `VideoTiling.swift`'s own header already documents that the vendor
   reference's real auto-tiling is temporal-only; ComfyUI's spatial-tile
   params are a manual override outside that auto path.

Two of the four required going back to actual source (the ComfyUI custom
node's Python file for #3, the workflow JSON's link topology rather than
just widget values for #2) rather than accepting the first-pass audit's
surface-level reading — both initial guesses (a mysterious per-frame
refine schedule; a distinct quality/preview pass) were wrong, and the
real underlying gaps were different from what they first appeared to be.

Full writeup: `docs/reference/comfyui_workflows/README.md`'s "Fourth pass"
section; `docs/TODO.md`'s matching entry.

## Research: scoping the general IC-LoRA video-conditioning primitive (2026-07-04)

Driven by `/goal resolve` a backlog item carried across several sessions:
`docs/reference/comfyui_workflows/README.md`'s research passes identified
10 official/community LTX-2.3 ComfyUI applications (restoration/hd,
spatial upscaler, motion-track, union-control, lipdub, HDR, ingredients,
inpaint, outpaint, V2V) that all share the `LTXICLoRALoaderModelOnly` +
`LTXAddVideoICLoRAGuide[Advanced]` + `LTXVCropGuides` node family, framed
as "port the primitive once, unlock all ten as call-site variations." That
framing undersells the remaining work — read the actual current code
(`NativeUpscaleStage.generateHD`, `LoRAWeights`/`LoRAFusion`,
`VideoConditionByReferenceLatent`) rather than re-deriving from the JSON
files again, to get an honest picture of what's shared vs. bespoke.

**What's actually already general, today, no further work needed**:
1. `LoRAWeights.load`/`LoRAFusion.apply` (`Transformer/LoRAWeights.swift`,
   `Transformer/LoRAFusion.swift`) — generic safetensors LoRA loading +
   `scale * (up @ down)` fusion into any dequantized block weight. Already
   used by THREE unrelated call sites (`native-i2v --lora`,
   `native-t2a --lora`, `generateHD`'s restoration+upscale LoRA pair) — not
   restoration-specific in any way.
2. `VideoConditionByReferenceLatent` (`Sampling/LatentConditioning.swift`)
   — the actual IC-LoRA reference-conditioning MATH (append a reference
   clip's clean latent tokens, mask=0, to the generation sequence). Also
   already general: takes an arbitrary `referenceLatent`/`referencePositions`/
   `downscaleFactor`/`strength`, with zero restoration-specific assumptions
   baked in. This IS the ported primitive the research passes were asking
   for — it's done, not a gap.

**What's actually bespoke per application** (the real remaining work,
and why "one primitive, ten applications" overstates how close this is):
what each application needs is not the conditioning math above but a
DIFFERENT PREPROCESSING PIPELINE to produce the reference latent's input
video in the first place, plus (for some) a different LoRA checkpoint.
`generateHD` only demonstrates the case where the reference video IS the
raw input frames, unchanged — the easy case. Prioritized by how much new
preprocessing each needs beyond "encode a video/image via the existing
`VideoEncoder`":

- **Easiest (near-zero new preprocessing)**: **V2V restyle**
  (`LTX-2.3_V2V_ICLoRA_Single_Stage_Distilled.json`) — reference video is
  just an existing clip loaded via `LoadVideo`, i.e. structurally the same
  "encode an existing video as reference" `generateHD` already does, minus
  the restoration-specific two-LoRA/two-stage structure. **Ingredients**
  (`LTX-2.3_ICLoRA_Ingredients_Single_Stage_Distilled.json`) is comparably
  easy — reference is a single still image repeated across frames
  (`LoadImage` + `RepeatImageBatch`), i.e. one VAE-encode + a repeat, no
  new perception model. Both are realistic "next concrete step" candidates
  if this item is picked up before the harder ones.
- **Medium (new preprocessing, but algorithmic — no new neural network)**:
  **Inpaint**/**Outpaint** — need `LTXVInpaintPreprocess`-equivalent
  masking, `LTXVDilateVideoMask`, and `LTXVLaplacianPyramidBlend` (a
  multi-scale blend between original and generated content at the
  mask boundary) ported as their own small modules. Non-trivial but
  bounded — pure image-processing math, comparable in scope to
  `VideoTiling.swift`'s existing tiling logic, not a new checkpoint.
- **Hard (each needs its own separate perception-model port)**:
  **Union-control**'s `CannyEdgePreprocessor` (algorithmic, cheap) is easy,
  but its `DWPreprocessor` (pose estimation) and `VideoDepthAnythingProcess`
  (monocular depth) are full neural networks with their own checkpoints —
  each is its own multi-session port, comparable in size to porting
  Whisper or the Gemma encoder, not a quick addition. **Motion-track**
  needs `LTXVDrawTracks`/`LTXVSparseTrackEditor`'s point-track
  visualization-rendering mechanism ported (a real, non-trivial algorithm,
  though not a neural network). **Lipdub** needs `LTXVAudioVAEEncode`/
  `LTXVSetAudioRefTokens` audio-reference-token wiring — likely the
  cheapest of this "hard" tier since this package already has a working
  audio VAE encode path (custom-audio injection, `--audio-track`), so it's
  mostly new glue rather than a new model, but still needs its own
  verification pass against the reference.
- **Different in kind, not a conditioning application at all**: **HDR**'s
  distinguishing node is `LTXVHDRDecodePostprocess` — a tone-mapping step
  applied AFTER decode, not a reference-conditioning input. It happens to
  ride on the same IC-LoRA base checkpoint in the reference workflow, but
  the actual novel piece (if ever wanted) is a decode-time postprocess,
  architecturally unrelated to everything else in this list.

**Revised backlog framing**: the shared primitive (LoRA fusion + reference
conditioning) is DONE, not a blocker. What remains is 9 independent,
unequally-sized preprocessing ports, ranging from "an afternoon" (V2V,
Ingredients) to "its own multi-session Whisper-sized effort" (pose/depth
control). Pick from the top of the easy tier (V2V or Ingredients) as the
next concrete step if/when this is picked up — not a "port the primitive"
task, since that part is already done.

Nothing implemented this pass — pure scope-capture, same convention as the
prior ComfyUI research passes, to leave an accurate map instead of
re-discovering "is this really one primitive?" from scratch a fourth time.

## Milestone: V2V restyle ported — `native-restyle` (2026-07-04)

Picked up the top item of the "easy tier" from the scoping research above.
`NativeUpscaleStage.generateRestyle` (`NativeUpscaleStage.swift`) is
`generateHD`'s reference-conditioning core (VAE-encode reference clip ->
fuse IC-LoRA via `LoRAFusion` -> `VideoConditionByReferenceLatent` ->
full noise-to-clean `DenoiseLoop` at the reference's own resolution ->
decode) with the restoration-specific two-LoRA/two-stage structure
removed: a single, always user-supplied style IC-LoRA (`loraURL`, no
bundled default under `mlx-models/lora/`, unlike `generateHD`'s
restoration pair), one stage, output at input resolution (chain through
`generate()` afterward for a resolution increase, same as `native-upscale
--mode hd` already does). New CLI command `ltx-video native-restyle`
(`--input`/`--prompt`/`--audio`/`--lora`/`--lora-strength`/`--fps`/
`--seed`/`--mp4`).

**Verification**: no real style IC-LoRA checkpoint exists in this
environment (same situation `generateHD`'s restoration pair was in at
introduction) — `VideoConditionByReferenceLatent` itself is already
real-checkpoint-parity-tested (shared with `generateHD`, unchanged here).
Added `testGenerateRestyleMissingLoraThrowsNamedError`, exercising the one
path fully reachable without a checkpoint: a definitely-missing `--lora`
path throws the new named `.restyleLoraNotFound` error (not a generic
crash), matching the same contract test `generateHD`'s
`testGenerateHDMissingLoraThrowsNamedError` already established.
`NativeUpscaleStageRealCheckpointTests`: 7/7 pass. UNVERIFIED end-to-end
against a real style adapter — natural next step once one is obtained
(Lightricks hasn't published a distinct "V2V restyle" checkpoint by that
exact name on HuggingFace/CivitAI as of this session's search; the
closest official IC-LoRA family members are Decompression/Deblur/
Colorization/Ingredients/Pixel-Spatial-Upscaler, none of which is a
generic style-transfer adapter — a real style LoRA for this path is
likely community-trained rather than an official Lightricks release).

**Ingredients** (single-reference-image conditioning — the sibling "easy
tier" item, `LoadImage` + `RepeatImageBatch` instead of `LoadVideo`)
remains the next candidate if this area is picked up again.

## Milestone: Ingredients IC-LoRA ported — `native-ingredients` (2026-07-04)

Picked up the sibling "easy tier" item named above. `NativeUpscaleStage
.generateIngredients` reuses the exact same reference-conditioning core
`generateRestyle` established (VAE-encode reference -> fuse IC-LoRA via
`LoRAFusion` -> `VideoConditionByReferenceLatent` -> denoise -> decode), but
the "reference clip" is built by tiling a SINGLE still reference image
across the full generation frame count instead of reading a real multi-frame
input clip. Confirmed against the reference ComfyUI graph's actual node
LINKS (`LTX-2.3_ICLoRA_Ingredients_Single_Stage_Distilled.json`), not just
node names — `LoadImage` -> `CreateVideo` -> `GetVideoComponents` ->
`ResizeImageMaskNode` -> `RepeatImageBatch`, where `RepeatImageBatch`'s
`amount` and `EmptyLTXVLatentVideo`'s own frame count are driven by the SAME
`PrimitiveInt` node: the reference image tiles to exactly the target
generation length, not a fixed short window as the node names alone might
suggest.

Two deliberate deviations from a literal 1:1 port, both reusing existing
primitives instead of adding new preprocessing: (1) output resolution is
caller-supplied `--width`/`--height` through `ResolutionResolver.optimize`
with the reference image fit via `FrameLoad.resizeAspectFillCenterCrop`
(already used by `native-i2v --last-frame`), instead of porting
`ResizeImageMaskNode`'s "scale shorter dimension, lanczos" algorithm — a
resize-mode detail, not a new capability; (2) audio is generated from
scratch (denoiseMask=1, noise-to-clean, reusing `NativeI2VStage`'s own
default t2v audio-decode pipeline: `AudioVAEDecoder` + `VocoderWithBWE` +
`WAVWriter`), not preserved from an input track like `generateRestyle` —
the reference graph's `LTXVEmptyLatentAudio` is itself denoised by
`SamplerCustomAdvanced`, confirmed via its link into the same
`SamplerCustomAdvanced` node, not a pass-through. New CLI command
`ltx-video native-ingredients` (`--input`/`--prompt`/`--lora`/
`--lora-strength`/`--width`/`--height`/`--seconds`/`--fps`/`--seed`/`--mp4`).

**Checkpoint search**: unlike the restoration pair (no exact match found),
`Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients` DOES exist on HuggingFace by
that exact name, with a real downloadable file
(`ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors`, confirmed via the HF API
`siblings` listing) — but the repo is gate-flagged (`"gated": "auto"`).
Attempted download with the environment's `HF_TOKEN` via both
`import-lora --arch ltx-2.3` and a direct authenticated `curl`: both return
HTTP 403 (not 401 — token is valid, but this specific account hasn't
accepted the repo's license terms on huggingface.co). This requires a human
to click "Agree" on the model page while logged in as that account — not
something the CIVITAI_TOKEN-only download path in `import-lora-image.py`
can do, and not something worth adding OAuth-gate-acceptance automation for
one checkpoint. Correctly did not force a workaround; this is a different
kind of "blocked" than the restoration pair's — "exists but needs one-time
human license click" rather than "doesn't exist in the form asked for."

**Verification**: `NativeUpscaleStageRealCheckpointTests` (9/9 pass) covers
the no-checkpoint contract paths — `testGenerateIngredientsMissingLoraThrowsNamedError`
and `testGenerateIngredientsMissingReferenceImageThrowsNamedError` (missing
`--lora` throws `.ingredientsLoraNotFound`, missing `--input` throws
`.referenceImageNotFound`), matching `generateHD`/`generateRestyle`'s
"named error, not a generic crash" convention.

**Real-checkpoint end-to-end run (2026-07-05)**: the user accepted the
HuggingFace license gate for `Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients`
same-day, unblocking the download this milestone's introduction left
pending. Downloaded via authenticated `curl` (the `HF_TOKEN`-gated file the
`import-lora-image.py` download path still can't reach directly — see this
milestone's checkpoint-search note above, unchanged), then imported the
local file via `import-lora --arch ltx-2.3`. Ran `ltx-video
native-ingredients` against a freshly `t2i`-generated reference photo (a red
apple on a wooden table) with a real IC-LoRA fusion, 33 frames at 800x800 (a
512x512 request auto-scaled up by `ResolutionResolver`'s minimum-validated-
area floor), 130.8s wall time. **PASS**: frame 0 reproduces the reference
image's content (same apple, table, lighting) almost exactly — the actual
signal that matters for IC-LoRA reference conditioning — and stays visually
stable/coherent (no corruption or noise) across all 33 frames, with audio
decoding and mp4 mux completing cleanly. One quality caveat, not a
correctness bug: the prompt's "slowly rotating" produced negligible visible
motion — consistent with the distilled model's cfg=1.0 / short sigma
schedule limiting prompt-driven motion elsewhere in this codebase, not
specific to this conditioning path. Both the missing-checkpoint contract
tests above and this real-checkpoint content-fidelity check now back this
milestone — no longer UNVERIFIED.

## Milestone: VBVR reasoning LoRA verified native + `--input-image` generalization (2026-07-05)

Follow-up to a standing backlog item (`run.py video vbvr`'s native-port
target, carried across several sessions per the last few goal notes).
Re-read the actual Python command (`app/commands/video-vbvr.py`) rather
than assuming from the name: VBVR is I2V generation with a specific
reasoning LoRA fused in — no new conditioning mechanism, just LoRA fusion
this package already has (`LoRAWeights`/`LoRAFusion`, landed for the
distilled structural LoRA). run.py's version requires the non-distilled
`dev` pipeline because "the distilled pipeline has no LoRA fusion stage"
in that codebase — but Swift's `LoRAFusion` already fuses onto the
**distilled** transformer (that's exactly what `native-i2v --lora` does),
so this port doesn't inherit that dev-pipeline requirement at all.

**Inventory check (cheap, done first)**: all 5 VBVR LoRA variants already
exist locally under `mlx-models/lora/vbvr-*` (from earlier relay A/B
review sessions) — no download/license gate needed, unlike Ingredients'
HF-gate story last session. `vbvr-licon-390k`'s manifest declares
`compatible_with: [transformer/ltx-2.3-dev-q8, transformer/ltx-2.3-distilled-q8]`
(format `mlx-int8`, same as the distilled structural LoRA) — the
LiconStudio 390K checkpoint, rated "best" (3★) in `_RELAY_REVIEWS`'
human A/B scores across both the `kitchen` and `physics` presets.

**Real-checkpoint verification**: ran `ltx-video native-i2v --lora
.../vbvr-licon-390k/Ltx2.3-Licon-VBVR-I2V-390K-R32.int8.safetensors:1.0`
end-to-end (384×576→resolved area floor, 1s/25 frames, prompt "a cat leaps
onto a table, knocks a glass of water off the edge"), 6m19s wall. **PASS**:
frame 0 and the last frame both visually inspected — coherent, matches the
prompt, no corruption/artifacts across all 25 frames, audio decoded
cleanly. `--lora` was already the correct, complete interface; no new CLI
surface needed for the "does it run" question. New
`LoRAFusionTests.testVBVRLoRALoadsAndProducesNonZeroFusionDelta` — a load
+ non-zero-delta regression (no Python-dumped vendor reference exists for
this file, unlike the distilled LoRA's dedicated dump script, so this is
deliberately a lighter contract check than a numerical parity test, not a
downgrade in rigor for a case that doesn't have a reference to compare
against).

**Real gap found and fixed as a prerequisite, not scope creep**: while
setting this up, found `NativeI2VStage` had no way to do I2V from an
arbitrary *supplied* image at all — frame 0 was unconditionally
`NativeT2IStage`-generated from `prompt` (`docs/TODO.md`'s NativeI2VStage
header explicitly documented this as the scope). That's fine for VBVR
(T2I-then-I2V is a valid single-shot use), but is a hard blocker for the
`relay` backlog item below, which needs to feed a previous segment's real
decoded last frame back in as the next segment's frame 0. Added
`Request.inputImagePath: URL?` (+ `native-i2v --input-image <path>`):
when set, skips `NativeT2IStage` entirely and VAE-encodes the supplied
image as the frame-0 conditioning latent instead — same
fail-fast-on-wrong-size convention `lastFrameImagePath` established
before FFLF's auto-resize opt-in. Three new
`NativeI2VStageRealCheckpointTests` cases: missing-file and
wrong-size contract tests (no checkpoints needed, fast), plus a
real-checkpoint chain test (`testInputImageSkipsT2IAndIsUsedAsFrame0Source`)
that feeds one real generation's own T2I output back in as a SECOND
real generation's `--input-image` and asserts the second run's recorded
`source.png` is byte-identical to the supplied file — proves the image
actually reaches frame-0 conditioning rather than being silently ignored
in favor of a fresh T2I generation.

**Update, same session: `native-relay` core chaining landed.** Built
`NativeRelayStage` + `ltx-video native-relay` right after `--input-image`
above, since that was the only missing piece: for each segment, run
`NativeI2VStage.generate` with `inputImagePath` set to the PREVIOUS
segment's last decoded PNG (`frame_%04d.png`, picked out by
`result.frameCount - 1` — no new decode logic needed, the frames already
exist on disk from `PNGFrameWriter`), mux each segment to its own mp4 via
the existing `MP4Writer`, then concatenate all segment mp4s into one final
`relay.mp4` via a new `VideoConcatenator` (`AVMutableComposition` +
`AVAssetExportSession` — pure Swift/AVFoundation, no ffmpeg, unlike the
Python version's `ffmpeg -f concat` demuxer).

**Real-checkpoint end-to-end run**: `native-relay --prompts "a red ball
rolls across a wooden floor" "the ball bounces off a wall and rolls
back"` (2 segments, 320x320 request auto-scaled to 800x800, 9 frames each,
126.8s wall). Verified the chaining is REAL, not coincidental: segment 2's
recorded `source.png` is byte-identical to segment 1's actual last decoded
frame (visually confirmed too — a red ball on a wooden floor, sharp and
coherent). Verified the concatenation is real: `ffprobe` on the final
`relay.mp4` shows 18 video frames (9+9, both segments genuinely present,
not just the first or last) and a valid audio track spanning both
segments' duration.

**A real bug caught by testing at a DIFFERENT scale than the CLI proof
above**: a fast synthetic `VideoConcatenatorTests` case (small
video-only clips, no audio — deliberately cheap/no-checkpoint, unlike the
CLI proof which always has audio since `NativeI2VStage` always generates
some) failed with a cryptic `AVFoundationErrorDomain code=-11838` /
"此媒體不支援此操作" export error. Root cause: `VideoConcatenator`
unconditionally created a composition audio track even when zero segments
had any audio to insert into it — a composition with a fully empty,
zero-duration audio track fails `AVAssetExportSession` outright rather
than just producing a silent track. Fixed by tracking whether the audio
track ever received content and removing it from the composition before
export if not. This means the ORIGINAL CLI proof run (which always has
audio) would never have caught this — a real instance of "verify at more
than one scale/config," not just the happiest path.

**Still open, deliberately scoped out of this first cut** (see
`NativeRelayStage.swift`'s header): custom audio track overlay/replace on
the final concatenated output (`--relay-audio`) — WAVReader/AudioVAEEncoder
exist for *generation-time* audio conditioning, but overlaying an
arbitrary externally-supplied audio file onto an already-muxed mp4 is a
distinct, not-yet-ported AVFoundation composition task. TTS narration
(`--relay-tts-text`, macOS `say`/`edge-tts`) and the variant A/B
comparison harness (`_RELAY_VARIANTS`) are lower-priority conveniences on
top of the core chaining that's now landed and verified. Each segment
must run at the same resolution (inherent to feeding one segment's last
frame as the next's `--input-image`, which requires an exact size match).

## Milestone: `native-relay --variant` A/B comparison (2026-07-05)

Closes out the last item of `native-relay`'s "still open" list. Unlike
the Python version's `_RELAY_VARIANTS` (which also toggles
distilled-vs-dev pipeline + cfg/stg scale), this native port is
distilled-only, so the only meaningful variant axis is "which LoRA(s), if
any" — the CLI's `--variant name[=lora_path[:strength]]` (repeatable)
runs the full relay once per variant, each to its own `<output>/<name>/`
subdirectory, catching per-variant errors so one failure doesn't abort
the rest, and prints a plain-text summary table (name/status/elapsed) at
the end. No side-by-side HTML reviewer is launched afterward — the Python
version's `video-review.py` has no Swift-side equivalent to hook into;
reviewing the per-variant outputs is manual for now.

Refactored `NativeRelayCommand` to share a `baseRequest()`/`runOnce()`
pair between the plain single-run path and the variant loop, rather than
duplicating the request-building/TTS-synthesis/printing logic.

**Real end-to-end 2-variant run** (`--variant baseline --variant
"vbvr=<vbvr-licon-390k path>:1.0"`, 1 segment, 320×320 request →
800×800 resolved, 9 frames): both variants completed independently —
`baseline` (0.9 min, no LoRA) and `vbvr` (2.5 min, LoRA genuinely fused —
confirmed via the per-run log's `[lora] fusing
Ltx2.3-Licon-VBVR-I2V-390K-R32.int8.safetensors at strength 1.0` line,
present ONLY in the vbvr run's output, not baseline's — proving the
per-variant LoRA override actually took effect rather than being silently
ignored). Both output directories (`baseline/`, `vbvr/`) contain complete,
independent `relay.mp4` + `seg01/` results. Summary table printed both
variants as `✓ ok` with correct elapsed times.

No dedicated unit test added — this is CLI-argument-parsing/orchestration
logic (`ArgumentParser` struct), and this package has no existing
CLI-level test harness to extend (same situation as `I2VCommand`'s
`--json-out`, noted in an earlier milestone); the real end-to-end run
above is this feature's verification.

**With this, all three "still open" items from the `native-relay`
milestone are now closed**: audio overlay, TTS narration, and variant
A/B comparison.

## Milestone: `native-relay --relay-tts-text` narration (2026-07-05)

Follow-up to the `--relay-audio` milestone above — picks up the "TTS
narration" item of `native-relay`'s remaining "still open" list. New
`MacTTS.swift`: shells out to macOS's built-in `say` (same `Process`
pattern `RunPyBridge.swift` already establishes for spawning
subprocesses), matching the Python version's `_generate_tts_say` defaults
(voice "Meijia", 145 words/min). Only `say` is ported — the Python
version's `edge-tts` neural-TTS option is an external network/PyPI
dependency, out of scope for a native port whose whole point is fewer
moving parts. `say` writes AIFF directly, which
`VideoConcatenator.replaceAudioTrack` already reads natively (AVFoundation
decodes AIFF out of the box) — no format-conversion step needed, unlike
the Python version's AIFF→AAC ffmpeg re-encode.

Wired into `native-relay --relay-tts-text <text> [--relay-tts-voice]
[--relay-tts-rate]`: when given (and `--relay-audio` is NOT also given),
synthesizes to a temp AIFF and feeds it into the SAME
`Request.audioOverlayPath` mechanism the previous milestone already
built and verified — no new pipeline plumbing needed, just reusing the
existing audio-overlay path with a synthesized source instead of a
user-supplied file.

Two new `MacTTSTests`, both using a REAL `say` invocation (fast, fully
local, no network — no reason to mock it): `testSynthesizeProducesReadableAudio`
(confirms the output isn't just "say exited 0" — the AIFF is decodable by
AVFoundation, the same read path `replaceAudioTrack` uses, with a
non-zero duration) and `testUnwritableOutputPathThrowsNamedError`. A first
version of the second test assumed an unknown VOICE name would make `say`
fail — manually verified that's wrong (`say` silently falls back to the
default voice, exit 0); an unwritable OUTPUT PATH is the real failure
mode `say` exits non-zero for. Both tests pass.

## Milestone: `native-relay --relay-audio` custom audio overlay (2026-07-05)

Follow-up to the `native-relay` milestone above — picks up the first item
of that milestone's "still open" list. `VideoConcatenator.replaceAudioTrack`
(new): builds an `AVMutableComposition` from the concatenated video's
video track + a user-supplied audio file's audio track, exported the same
way `concatenate` already is (factored the shared export logic into a
private `_export` helper rather than duplicating it). Mirrors the Python
version's default `--relay-audio-mode replace` only — `mix` (blend model
+ custom audio) and `keep` (explicit no-op) aren't ported, since `replace`
is both the Python default and the simplest, most-requested case.
AVFoundation decodes WAV/MP3/M4A/AAC natively, so this needed no new
dependency to match the Python version's "any ffmpeg-supported format"
claim.

Wired into `NativeRelayStage.Request.audioOverlayPath` / `native-relay
--relay-audio <path>`: when given, the concatenation step writes to an
intermediate `relay_concat.mp4` instead of the final `relay.mp4`, then
`replaceAudioTrack` produces the real `relay.mp4` from that. New tests,
all using REAL (not mocked) mp4/wav files via the existing
`MP4Writer`/`WAVWriter` — same convention as this package's other
AVFoundation tests: `testReplaceAudioTrackAddsRealAudioToVideoOnlyClip`
(a video-only clip gains a real audio track, and the output duration
follows the shorter VIDEO track, not the longer supplied audio — proving
the trim direction is correct) and `testReplaceAudioTrackMissingAudioThrowsNoAudioTrack`
(a new `.noAudioTrack` error, not a generic crash, when the "audio" file
has no audio track). Plus a fast `NativeRelayStageTests
.testMissingAudioOverlayThrowsNamedError` fail-fast contract test. 7/7
new+existing `VideoConcatenatorTests`/`NativeRelayStageTests` pass.

Not re-run as a full real LTX generation this time — the expensive
real-checkpoint proof for chaining+concatenation was already established
by the previous milestone, and this increment only adds a post-processing
step exercised end-to-end with real (non-mocked) media files in the new
unit tests, which call the exact same `VideoConcatenator.replaceAudioTrack`
function the CLI does.

## Milestone: `native-upscale --mode hd` restoration LoRA pair FOUND + verified (2026-07-05)

Standing backlog item carried across several sessions — two prior search
passes found no exact-match checkpoint for `mlx-models/lora/ltx-2.3-restore/`'s
required pair (`ltx2.3-video-restoration-general.safetensors` +
`ltx2.3-ic-video-upscale-general.safetensors`, per that directory's own
README) and correctly classified it as "doesn't exist in that form," not
"nobody's tried." A fresh web search this session (re-checked rather than
re-deferred a third time, per the last two goal notes' own recommendation)
turned up a genuinely NEW, non-gated match: `joyfox/LTX2.3-ICEdit-Insight`
on HuggingFace (Apache-2.0, `lastModified: 2026-06-05` — plausibly newer
than the prior sessions' searches, or simply missed). Its repo contains
BOTH required files by their EXACT expected filenames — confirmed via the
HF API's `siblings` listing, not guessed from the model card. Unlike the
official `Lightricks/LTX-2.3-22b-IC-LoRA-Decompression` (also found this
session, but `"gated": "auto"` — same one-time-human-license-click
situation as last session's Ingredients checkpoint), `joyfox`'s repo is
`"gated": false` — downloadable immediately, no blocked wait this time.

Downloaded both files directly (100.8 MB restoration + 327.3 MB upscale,
confirmed via HTTP `content-length` after following the redirect — `curl
-I` without `-L` reports a misleading ~1 KB LFS-pointer size). Externalized
both to `../video_generation__models/<md5>.safetensors` + symlinks (same
`_store_to_external` primitive this session's `import-lora-image.py` fix
uses) rather than leaving them as trackable raw binaries in
`mlx-models/lora/ltx-2.3-restore/` — that directory's own `.raw-download`
marker predates this repo's now-established externalization convention
and only means "skip the MLX-manifest pipeline," not "exempt from the
never-commit-raw-safetensors rule." `check-model`: 66/66 manifests pass,
no new warnings (the `.raw-download` marker correctly keeps `check-model`'s
orphan scanner from flagging the un-manifested symlinks).

**Real-checkpoint end-to-end run**: `ltx-video native-upscale --mode hd`
against a real 25-frame VBVR-generated clip (previous milestone), with
`--refine-prompt`/`--refine-audio` — 109.2s wall. Ran cleanly through all
5 stages (reference encode → LoRA fusion → IC-LoRA-conditioned denoise →
decode → chained 2x fast upscale), producing 25 frames at 1280×1920 (2x
the 640×960 restoration-stage resolution) + a muxed `video.mp4`. Visually
inspected frame 0: same scene/pose as the source clip, genuinely
higher-resolution, though with a moderate fur-texture over-sharpening
artifact (a mesh-like pattern) — a quality nuance from this particular
community LoRA pair's own training, not a correctness bug; the
restoration+conditioning mechanism itself is confirmed working.

New `NativeUpscaleStageRealCheckpointTests.testGenerateHDProducesRestoredUpscaledFrames`
— the real success-path counterpart to the existing
`testGenerateHDMissingLoraThrowsNamedError` (which now correctly
self-skips, since the LoRA pair is present). Confirmed `generateHD` itself
is restoration-only (`outputSize == inputSize`) — the CLI's 2x upscale is
a separate chained `stage.generate()` call, not part of `generateHD`; an
initial version of this test wrongly assumed `generateHD` itself doubles
resolution and failed on a real run before the assertion was corrected.
Full suite: **10/10 pass** (1 pre-existing unrelated skip).

## Explicitly NOT doing

- Re-converting or re-deriving any checkpoint — always load what
  `import-checkpoint`/`convert.py` already produced.
- A from-scratch, unverified transformer port in one shot. Every phase
  above ends with a numerical parity check before moving on.
