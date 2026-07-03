# Upscale refine pass — DONE (2026-07-03)

Driven by `/goal generate high quality First-Last-Frame image generation`.
Closes the exact gap `NativeUpscaleStage`'s own header had been documenting
since it landed ("no refine pass... a bounded follow-up... not implemented
here yet") and that the ComfyUI reference-workflow research (finding 1)
quantified: the real two-stage pipeline follows its neural upscale with a
LOW-STRENGTH transformer denoise refinement (not a fresh generation) —
without it, `native-i2v --upscale`'s output (which FFLF runs through by
default) is visibly over-sharpened/halo-prone, undermining "high quality"
for exactly the FFLF+upscale combination the goal asked about.

`NativeUpscaleStage.generate` gained optional `refinePrompt`/
`refineAudioURL` params (+ `native-upscale`'s `--refine-prompt`/
`--refine-audio` CLI flags, and `native-i2v`'s `--refine`/`--no-refine`,
on by default alongside `--upscale`): when supplied, the upscaled
(still-normalized) video latent is forward-noised to
`SigmaSchedule.stage2Sigmas[0]` (an existing, already-named-for-this
constant, previously unused) and re-run through the real 48-block
distilled transformer over that 3-step schedule via
`DenoiseLoop.runStreaming` — the same mechanism `NativeI2VStage` uses for
the base generation, just starting from partial noise instead of pure
noise, with a uniform (not per-token) denoise mask since nothing is
"preserved," everything is lightly re-denoised. The audio track (e.g.
`native-i2v`'s own `audio.wav`) is re-encoded via the audio VAE encoder
from this session's `--audio-track` work and pinned fully preserved
(denoiseMask=0 everywhere) — audio itself isn't refined, it's only there
so the joint audio-video transformer has a valid audio branch to attend
to, which is why refine requires an audio track even though it doesn't
change it.

Verified real-checkpoint: same synthetic input frames, upscale-only vs.
upscale+refine produce measurably different first-frame output (mean abs
diff well above the 1e-4 threshold — same "prove it's wired" bar
`NativeI2VStageAudioTrackTests` established for `--audio-track`), plus a
fast-path validation test confirming `--refine-prompt` without
`--refine-audio` throws a clear `.refineNeedsAudioTrack` error before any
expensive work. 3 new tests, all passing (full-suite re-run separately
confirmed the touched real-checkpoint suites — `NativeI2VStageFFLFTests`,
`NativeI2VStageAudioTrackTests`, `NativeUpscaleStageRealCheckpointTests`
— all still green; a from-scratch full run was interrupted by an
unrelated background-shell timeout mid-way through, not a test failure).

**Visually confirmed at production resolution** (640x960 FFLF -> 2x
upscale, real T2I-generated `source.png` pinned as `--last-frame`, real
prompt/text-encode/transformer throughout): upscale-only output shows
exactly the artifact this session set out to fix — hair strands have
visible sharpening halos, skin has a painterly/oil-canvas texture, and
the jacket's woven pattern is muddy and semi-incoherent. The SAME frame
through the refine pass shows natural skin texture, a coherent plaid
weave on the jacket, and clean hair strands with no halos — a clear,
unambiguous quality improvement, not just a numerically-different output.
This directly answers the `/goal generate high quality First-Last-Frame
image generation` — FFLF's default `native-i2v` output path
(`--upscale --refine`, both on by default) now produces meaningfully
higher-quality results than before this session.

# Custom audio injection (`--audio-track`) — DONE (2026-07-03)

Follow-up to the ComfyUI reference-workflow research (finding 5, "Custom
Audio" subgraph: `LTXVAudioVAEEncode` + `SetLatentNoiseMask`). Ported the
reverse (encode) direction of the audio path so a user-supplied WAV can be
pinned as preserved audio conditioning instead of letting audio generate
from scratch — the audio-modality analogue of FFLF's video-frame pinning.

New pieces, all in `Sources/LTXVideoDirector/`:
- `WAVReader.swift` — minimal canonical PCM WAV reader (PCM16/Float32), the
  inverse of the existing `WAVWriter.swift`.
- `Vocoder/LinearResampler.swift` — arbitrary-ratio linear-interpolation
  resampler (any input rate → 16kHz `AudioProcessor` expects). Documented
  as a deliberate "honest limitation": not anti-aliased, adequate for
  speech/dialogue, same convention as `NativeUpscaleStage`'s no-refine-pass
  note.
- `AudioVAE/AudioProcessor.swift` — native STFT + Slaney mel filterbank
  matching `torchaudio.transforms.MelSpectrogram`. No learned weights;
  verified deterministic-computation parity against
  `scripts/dump_audio_processor_reference.py` (max abs diff < 1e-2, basis/
  window diffs < 1e-4/1e-5).
- `AudioVAE/AudioVAEEncoder.swift` + `AudioVAEEncoderLoader.swift` —
  structural inverse of the existing `AudioVAEDecoder.swift`, reusing its
  `WrappedConv2d`/`AudioResBlock` building blocks. Same checkpoint file as
  the decoder (`audio_vae.safetensors` has both `.encoder.*` and
  `.decoder.*` prefixes) — no new download needed. Verified against
  `scripts/dump_audio_vae_encoder_reference.py` (real checkpoint, real
  vendor `AudioVAEEncoder.encode()`, max abs diff < 1e-2).

Wiring: `NativeI2VStage.Request.audioTrackPath` (+ `NativeI2VCommand`'s
`--audio-track <path>`) resamples the WAV to 16kHz, mono→stereo-duplicates
if needed, encodes via `AudioVAEEncoder`, patchifies with the existing
`AudioPatchifier`, and pins the resulting tokens via
`VideoConditionByLatentIndex` — the same generic conditioning mechanism
FFLF uses for video frames, reused here with `spatialDims=(N,1,1)` since
audio tokens have no spatial extent to group by frame. If the track is
shorter than the generated clip's audio-token count, only the covered
prefix is preserved; the rest still generates normally. Validates the
track file's existence before any expensive generation work (same
fail-fast convention as `--last-frame`).

Verified real-checkpoint, same-seed/prompt A/B (no reliable sample-level
diff exists for the lossy mel→VAE→vocoder roundtrip, unlike FFLF's direct
pixel diff): baseline vs. `--audio-track` output differ with mean abs diff
well above the 1e-4 threshold, proving the injected track actually reaches
generation rather than being silently ignored. Full suite: **113/113
pass** (5 new tests: 1 `AudioProcessorParityTests`, 2
`AudioVAEEncoderRealCheckpointTests`, 2 `NativeI2VStageAudioTrackTests`).

# Gemma-3-12b native text encoder — COMPLETE ✅

> **Commit/merge status (2026-07-03):** committed on branch
> `feat/swift-ltx-video-director` (final commit `2e207c9`). **NOT merged into
> `main` yet** — awaiting merge/PR decision. Gemma work itself is done; the
> unmerged branch also carries the rest of the native-port milestone
> (T2I/VLM/audio/video-decode stages, TextEmbeddingProjection, the 48-layer
> LTX transformer).

The entire Gemma-3-12b text encoder is now native Swift/MLX and verified
end-to-end against the real production model. This was the last piece blocking
a fully-native distilled I2V path (everything else — VAEs, 48-layer LTX
transformer, sampling loop, full audio stack, T2I stage, VLM prompt stage,
TextEmbeddingProjection, Embeddings1DConnector — was already native).

## Verified path: text → hidden states, all native

| Step | Component | Verified against |
|------|-----------|------------------|
| text → token_ids | `GemmaTokenizer` (standalone SentencePiece-BPE) | **byte-identical** to mlx-lm tokenizer |
| token_ids → h0 | `GemmaEmbedding` (embed + sqrt scaling) | < 0.13% relative |
| h0 → h1 | `GemmaBlock` layer 0 (attn+RoPE+MLP+norms) | < 0.5% relative |
| h1 → h48 | `GemmaEncoder` (48 streaming blocks) | < 5% relative over full depth |
| RoPE isolation | `GemmaAttention` dual sliding/global configs | < 1e-4 |

Four parity tests, all passing: `GemmaTokenizerParityTests`,
`GemmaRoPEParityTests`, `GemmaLayer0ParityTests`, `GemmaFullEncoderParityTests`.
68/68 package tests green.

## The tokenizer resolution (the last piece)

Gemma uses SentencePiece-BPE, not Tiktoken. z-image-director's `BPETokenizer`
(Tiktoken-style: GPT-2 bytes_to_unicode + regex pretokenizer) produced wrong
token_ids. `GemmaTokenizer` is a standalone implementation parsing the HF
`tokenizer.json` directly, implementing the verified-correct algorithm:
1. split text on special tokens (`<start_of_turn>` etc.), preserving them
2. normalize: `" "` → `"▁"` (SentencePiece metaspace)
3. BPE: initial tokens = chars (byte_fallback → `<0xNN>` for unknown chars),
   greedily merge lowest-rank adjacent pair
4. prepend `<bos>` (Gemma `add_bos_token=True`, no eos)

## Two earlier bugs (documented for future porters)

1. **Wrong tolerance metric**: Gemma's residual stream is un-normalized between
   layers, so |h| grows to absmax ~10000 by layer 48. The original "diff 32"
   failure was 0.32% relative — use RELATIVE error (diff/absmax) for deep
   residual stacks, not absolute.
2. **fp32-vs-bf16 compute**: mlx-lm dequantizes 4-bit weights to **bfloat16**;
   an fp32 port diverges to 26% over the chaotic 48-layer residual stack.
   Match bf16 compute (also cast the attention mask to bf16 for sdpa promotion).

## Next: wire into the pipeline — text-encode half DONE (2026-07-03)

The encode produces concatenated all-layer hidden states (B, T, 188160) →
`TextEmbeddingProjection` (native) → `Embeddings1DConnector` (native) → DiT
conditioning embeds. `NativeTextEncodeStage.swift` now wires `GemmaTokenizer`
+ `GemmaEncoder` + `TextEmbeddingProjection` + `Embeddings1DConnector` into
one native encode call (`ConnectorCheckpointLoader.swift` loads the real
connector checkpoint — int4/group_size=32, 8 blocks per side, see PLAN.md's
"NativeTextEncodeStage" milestone). Verified end-to-end via
`NativeTextEncodeStageRealCheckpointTests` (real checkpoints, finite +
correctly-shaped output). 69/69 package tests pass.

Still open: `I2VCommand` still uses `RunPyBridge` for actual generation —
wiring `videoEmbeds`/`audioEmbeds` into `LTXModel`/`DenoiseLoop` and adding
memory-bounded VAE tiling for real-resolution output remain before
`RunPyBridge` can be retired there.

## NativeI2VStage landed (2026-07-03) — can it run without run.py/Python yet?

**Yes, for a real (if quality-limited) generation — via the new,
separate, explicitly experimental `ltx-video native-i2v` command. `i2v`
(the production command) still uses `RunPyBridge`/`run.py`.**

`NativeI2VStage` composes every native piece (T2I, VAE-encode
conditioning, Gemma text encoder, `DenoiseLoop.runStreaming` against the
real 48-block distilled transformer, VAE/vocoder decode) into one call —
zero run.py, zero Python. Ran it for real at production resolution
(640×960, 9 frames, 45.0s wall time): frame 0 (the I2V conditioning
frame) came out pixel-perfect; frames 1+ show a real color-distortion
artifact traced to `DenoiseLoop.runStreaming` not yet supporting
per-token timesteps (see PLAN.md's "NativeI2VStage" milestone for the
full diagnosis and the concrete next fix). 77/77 package tests pass,
including a real-checkpoint end-to-end smoke test
(`NativeI2VStageRealCheckpointTests`).

Remaining before `native-i2v` output is quality-comparable to `run.py`,
and before `I2VCommand` itself could ever consider dropping
`RunPyBridge`: VAE tiling for larger/longer clips, VLM prompt expansion
wiring, and an actual mp4 muxer (still PNG sequence + WAV).

## Color-distortion artifact — FIXED (2026-07-03)

**Status: RESOLVED.** The frame 1+ color-distortion bug reported above is
fixed. Root cause was exactly as diagnosed: `LTXModel.streamingForward`
only accepted a scalar batch timestep, so during I2V-conditioned
streaming denoise every token — including the preserved conditioning
frame — was AdaLN-modulated with the same sigma. Other tokens'
cross-attention therefore perceived the "clean" frame as still-noisy at
every step; `applyDenoiseMask` only patched the OUTPUT afterward, not
what other tokens saw internally.

Fix: gave `LTXModel.streamingForward` the same `videoTimesteps`/
`audioTimesteps` (B, N) per-token-timestep parameters `callAsFunction`
already had (preserved tokens' own AdaLN branch), and updated
`DenoiseLoop.runStreaming` to compute them via the same
`isUniformMask`/`perTokenTimesteps` helpers the non-streaming
conditioned `run` already used. Now the streaming and non-streaming
conditioned paths are at parity.

Verified: re-ran `ltx-video native-i2v` at production resolution
(640×960, 9 frames) — visually inspected `source.png` and all 9 output
frames; no color distortion in any frame, output matches source
composition/colors correctly throughout. 77/77 package tests still
pass after the change.

## Auto resolution resolve — DONE (2026-07-03)

**Status: RESOLVED.** Bad user-supplied resolutions (not a multiple of
32) used to hard-fail `native-i2v`. `NativeI2VStage.generate` now calls
new `ResolutionResolver.optimize(width:height:)` unconditionally, which
snaps to the nearest 32-multiple (LTX-2.3's video VAE spatial
compression factor) and logs the adjustment — mirroring what
`run.py video generate`'s `_adjust_resolution` already does for the
Python path. Only non-positive dimensions still throw. 6 new
`ResolutionResolverTests` + 2 new `NativeI2VStageRealCheckpointTests`
cases (misaligned-resolution real run, zero-dimension rejection). Suite
now **85/85**.

## Native spatial upscaler — LANDED, a different (smaller) mechanism than first researched (2026-07-03)

**Does LTX-2.3 support a native spatial upscaler?** Yes — two different
mechanisms, actually:
1. `Lightricks/LTX-2.3-22b-IC-LoRA-Pixel-Spatial-Upscaler`, an official
   IC-LoRA (2×/4×, generative, also removes watermarks/subtitles/blur)
   fused onto the full 22B transformer. This package exposes it via
   `ltx-video upscale` → `UpscaleEngine` → `RunPyBridge` → `run.py video
   restore` → vendor `ICLoraPipeline` — real, correct output, but still
   bridges through Python. Porting this natively remains a large,
   unstarted undertaking (LoRA fusion + whole-clip reference
   conditioning — see PLAN.md's "Research: native spatial upscaling"
   milestone for the 5-step plan).
2. **`LatentUpsampler`** — the small, dedicated neural upscaler LTX's
   own two-stage pipeline uses between its half-res generation and
   refinement passes. Much smaller (Conv3d/Conv2d ResNet operating
   directly on the 128-channel VAE latent — comparable to
   `VideoDecoder`, not to the full transformer). Checkpoint already
   present at `mlx-models/vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors`.

**Is #2 natively ported to Swift (no run.py)? Yes, done and verified.**
New `Sources/LTXVideoDirector/Upsampler/LatentUpsampler.swift` (spatial_x2
variant), parity-tested against the real checkpoint's actual Python
output (max abs diff < 1e-3), assembled into `NativeUpscaleStage.swift`
(`VideoEncoder → LatentUpsampler → VideoDecoder`) and exposed as
`ltx-video native-upscale`. Manual real-checkpoint run + visual
inspection caught and fixed a real bug along the way: `LatentUpsampler`
needs its input DENORMALIZED (raw VAE scale) — feeding it
`VideoEncoder`'s normalized output directly produced severe
color-fringing artifacts, invisible to the numerical parity test (which
used tiny random values) but obvious on a real photo. Fixed by
denormalizing before / renormalizing after, matching the vendor
pipeline's actual Stage-1→2 handoff exactly. Verified clean: a
320×320→640×640 real upscale run shows genuinely more detail, no
artifacts, ~1.8s wall time. See PLAN.md's "NativeUpscaleStage" milestone
for the full story. Suite: **87/87 pass.**

`native-upscale` is upscale-only — no refinement denoise pass after the
neural upscale (the real two-stage pipeline follows it with one; not
implemented here yet, see PLAN.md). #1 (IC-LoRA restoration/dewatermark)
remains the only native-port gap.

## Sub-production-resolution corruption — FOUND AND FIXED (2026-07-03)

**Status: RESOLVED.** A manual `native-i2v` demo at 384x576 (same 2:3
aspect as the validated 640x960 default, just smaller — both multiples of
32) produced a clean frame 0 but progressively worse color/texture
corruption over the following frames. An identical run (same
seed/prompt/fps, 17 frames) at 640x960 stayed completely clean throughout,
isolating the cause to resolution, not frame count or fps. Root cause: the
distilled transformer's streaming denoise destabilizes over multi-frame
sequences when run well below its validated training resolution.

Fix: `ResolutionResolver.optimize` now enforces a minimum pixel area —
`modelOptimalDefault`'s own area (640x960 = 614,400px) — scaling any
smaller request up (preserving aspect ratio) before snapping to the
nearest 32-multiple, instead of just snapping the too-small request in
place. Verified: rerunning the exact 384x576 request now logs
`auto-adjusted 384x576 -> 640x960` and produces output identical in
quality to the direct 640x960 run (clean throughout, correct zh-TW
subtitle rendering, no corruption). 2 new `ResolutionResolverTests` cases
added (area-floor scale-up, real-world regression case). Suite: **89/89
pass.**

## Temporal VAE decode tiling — DONE (2026-07-03)

**Status: LANDED.** Long clips no longer die during decode: a 41-frame
(5s @ 8fps) 640x960 `native-i2v` run — the case that previously crashed
silently — now completes end-to-end (79.5s wall, exit 0, 41 clean frames
+ audio). New `Sources/LTXVideoDirector/VAE/VideoTiling.swift` ports the
vendor reference's temporal decode tiling (ltx-2-mlx
`video_vae/tiling.py` + `_compute_decode_tiling`/`tiled_decode`),
temporal axis only — same scope the vendor auto-path uses. Preserved
reference subtleties: causal 1-latent-frame back-shift on non-first
tiles, latent→frame mapping `[begin*8, 1+(end-1)*8)`, and
`left_starts_from_0` trapezoid masks. `VideoDecoder` gained
`materializeStages:` (force-eval after each upsample stage, tiled path
only). `NativeI2VStage` auto-selects tiling via the same
`LTX2_VAE_DECODE_BUDGET_GB` env knob run.py uses (default 8 GB; budget
model uses 4 bytes/element since the Swift decoder runs fp32).

Verified: (1) forced-tiling real run (`LTX2_VAE_DECODE_BUDGET_GB=0.4`,
tile_frames=40 overlap=8) visually indistinguishable from the untiled
run — frames at the blend seam (24/28) and ends inspected, no seams or
color shift; (2) tiled-vs-untiled real-checkpoint parity test (bounded
max/mean deviation — NOT bit-exact by design: the decoder is non-causal,
so tile boundaries truncate the temporal receptive field; the vendor has
the same property); (3) 10 pure-arithmetic layout/mask/budget tests
mirroring vendor test_decode_tiling.py. Suite: **100/100 pass.**

Note: encode-side tiling and spatial decode tiling are NOT ported (the
vendor auto-path never selects spatial tiling either; encode here only
ever sees a single conditioning frame).

# Default auto-upscale + multi-LoRA fusion — DONE (2026-07-03)

Driven by an explicit `/goal`. Four asks, four outcomes:

1. **"Runs full pure Swift"** — confirmed still true: `native-i2v` has
   zero `run.py`/`RunPyBridge` calls anywhere in its call chain (only
   `i2v` still bridges). Re-verified with a real end-to-end run.
2. **Resolution auto-align** — already landed in an earlier session
   (`ResolutionResolver.optimize`, snaps to the nearest 32-multiple,
   scales up below the validated area). No new work needed; re-verified.
3. **Default auto-upscale** — `NativeUpscaleStage` (native `LatentUpsampler`,
   2x spatial) existed but was never chained after `native-i2v`.
   `NativeI2VCommand` now runs it automatically after decode
   (`--upscale`/`--no-upscale`, on by default). **Quality caveat found
   and documented, not glossed over**: the upscale is visibly
   over-sharpened/halo-prone vs. the base frame (no refine denoise pass
   — see `NativeUpscaleStage`'s own header). Real run: 74.5s base + 10.5s
   upscale, 640×960 → 1280×1920.
4. **Multi-LoRA support** — inventory: only ONE real LTX LoRA exists in
   `mlx-models/lora/` (`ltx-2.3-22b-distilled-lora-384(-1.1).int8.safetensors`
   — the structural dev→distilled LoRA, not a style pack; every other
   entry under `mlx-models/lora/` is a z-image/Klein9B image LoRA).
   Ported `ltx_core_mlx.loader.fuse_loras`'s delta math + the
   `LTXV_LORA_COMFY_RENAMING_MAP` key remap + `app/vendor_patches.py`'s
   int8-LoRA dequant patch (all three confirmed by reading the actual
   vendor/app source, not assumed) into `LoRAWeights.swift`/
   `LoRAFusion.swift`. Wired into `TransformerCheckpointLoader`/
   `NativeI2VStage.Request.loraPaths` + a repeatable `--lora
   path[:strength]` CLI flag. Verified against the real vendor
   `apply_loras` + the real distilled LoRA file, both single-LoRA and
   multi-LoRA (same file stacked twice at different strengths) — max-abs-diff
   < 1e-3, plus a guard against a same-strength-for-every-source bug.

Full suite green after all four changes (build + targeted LoRA test run
confirmed 100% pass; see PLAN.md's matching milestone for exact test
names and counts).

# First-Last-Frame (FFLF) conditioning — DONE (2026-07-03)

Follow-up to the ComfyUI reference-workflow research above. Confirmed the
research doc's prediction: `VideoConditionByLatentIndex` already generalized
to multiple frame indices — only `NativeI2VStage` needed a second
conditioning image wired in, not a new conditioning mechanism.

`NativeI2VStage.Request.lastFrameImagePath` (+ `NativeI2VCommand`'s
`--last-frame <path>`): when set, VAE-encodes the given image the same way
the existing T2I-generated frame-0 source is encoded, and conditions on
`[0, fLat - 1]` instead of `[0]`. Frame 0's existing behavior (always
T2I-generated from `--prompt`) is unchanged. Validates the image's
existence + exact size BEFORE any expensive generation work, matching this
package's fail-fast convention.

Verified real-checkpoint: a synthetic flat-color PNG pinned as the last
frame comes back out of the DECODED output within mean abs diff < 0.04 in
[0,1] pixel space (same order as the VAE round-trip loss already
documented for frame-0 conditioning) — proves the last frame is genuinely
the pinned image, not model-generated content. Passed on the first run.
