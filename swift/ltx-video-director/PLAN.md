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

Remaining for Phase 2: `model.py`'s `LTXModel` top-level assembly (patchify/unpatchify
projections, 6 top-level AdaLN modules producing this block's input params from a single
timestep, the actual 48x block stack against a REAL checkpoint, the `LTX2_DIT_EVAL_EVERY` Metal
watchdog workaround). With `BasicAVTransformerBlock` proven, this is now "mostly wiring plus a
real-checkpoint smoke test," the same pattern that worked for `VideoDecoder`/`VideoEncoder` in
Phase 1 — not new algorithmic risk.

## Phase 3 — native I2V conditioning + audio + speech-gate

- Image-conditioning latent injection (I2V).
- Joint audio decode (LTX-2.3 generates audio from the same prompt).
- A REAL voice-presence gate: today's `AudioProbe` is energy-based only
  (loudness/silence). A proper "is this actually speech, and roughly the
  right language" check needs VAD/ASR — out of scope until this phase.

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

## Explicitly NOT doing

- Re-converting or re-deriving any checkpoint — always load what
  `import-checkpoint`/`convert.py` already produced.
- A from-scratch, unverified transformer port in one shot. Every phase
  above ends with a numerical parity check before moving on.
