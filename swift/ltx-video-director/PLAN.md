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

This is one atomic building block, not the VAE decoder itself — the decoder (`video_vae.py`,
687 lines: ResBlockStage, DepthToSpaceUpsample, PixelNorm, per-channel statistics denorm,
memory-bounded tiling) is the next slice, followed by the encoder, then the 48-layer transformer
(by far the largest piece — see Phase 2). Each subsequent piece follows the same
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
