# Swift LipDub Port Design

## Goal

Port Python's LipDub IC-LoRA reference-video lip-dubbing pipeline
(`run.py video lipdub`) to Swift, closing the gap `docs/openmontage-
capability-matrix.md`'s `lip_sync` row has flagged since 2026-07-10 as
"unstarted new engine work": Swift's only lip-sync path today is
`native-i2v --audio-track`, which sits in the same coarse "talking in
general" tier as Python's plain IA2V (LSE-D 15.66, no AV-offset
convergence). Python's dedicated LipDub path is the one measured
improvement in the whole matrix (CelebV-HQ ID-LoRA: LSE-D 12.63 / LSE-C
2.068, converging offset) — still short of the ≤1.5 adequacy bar, but a
real, non-trivial, apples-to-apples win over every other measured path.

This is framed the same way the prior multi-reference-ingredients work was
(`docs/superpowers/specs/2026-07-26-multi-reference-ingredients-design.md`):
an honest port with a measured outcome, not a guaranteed feature. Whether
it's ever wired into `pi-agent-ext-movie-director` depends on Phase 1's
empirical result.

The LipDub IC-LoRA checkpoint is already present locally —
`mlx-models/lora/ltx-2-3-lipdub/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors`
— no download/license-acceptance step needed before Phase 1 can run.

## Background: what Python's LipDub actually does

Read directly from `python/mlx-movie-director/app/commands/video-lipdub.py`,
`app/ltx_pipeline.py::generate_lipdub`, and the vendor pipeline
`../ltx-2-mlx/packages/ltx-pipelines-mlx/src/ltx_pipelines_mlx/lipdub.py`
(sibling repo, not OpenMontage — reading it is fine).

`LipDubPipeline` (subclasses `ICLoraPipeline`) takes one reference video
that supplies **two independent conditioning signals**:

1. **Visual structure**: the reference video's own frames, VAE-encoded and
   appended via `VideoConditionByReferenceLatent`-equivalent conditioning
   (`append_ic_lora_reference_video_conditionings`) — applied at **both**
   stage 1 (half-res) and stage 2 (full-res), with the LipDub IC-LoRA
   fused into the transformer for **both** stages (a deliberate divergence
   from the vendor's generic `ic_lora.py`, which reloads a clean
   transformer for stage 2 — LipDub's own comment: "IC-LoRA stays fused
   for stage 2").
2. **Target speech**: the reference video's own audio track, VAE-encoded
   and appended via `AudioConditionByReferenceLatent` — a **new**
   conditioning primitive (Swift doesn't have this yet) that patchifies
   the reference audio latent and shifts its RoPE positions into **negative
   time** (`positions - (audioDuration + 0.04)`), so the model reads the
   reference audio as off-screen context rather than overlapping the
   target audio sequence it's about to generate. Frozen through stage 2
   (`sigma=0`, `initial_latent=stage1Output` — Euler steps at sigma 0 are a
   no-op, so this is a passthrough, not a re-denoise).

Frame count comes from the reference video itself (`probe_video_info` +
snap down to the nearest `8k+1`), not from a user-specified duration.

## Architecture discovery: what Swift already has

Read `NativeUpscaleStage.swift` in full. Three existing pieces cover most
of the ground:

- **`generateHD`** (line 344): VAE-encodes a reference clip, fuses IC-LoRA
  into the distilled transformer, appends it via the existing
  `VideoConditionByReferenceLatent` (`LatentConditioning.swift:111`), runs
  a full noise-to-clean denoise. This is the template for LipDub's stage 1
  video-conditioning mechanics.
- **`generate`**'s optional `refine()` path (line 939): forward-noises an
  already-upscaled latent to `SigmaSchedule.stage2Sigmas[0]` and re-denoises
  over that short schedule.
- **Correction to initial scoping**: `refine()` builds its transformer with
  `loraSources: []` (line ~1006) — **no LoRA, no reference-conditioning
  append** at that stage. `generateHD` + `generate(refinePrompt:)` is
  therefore *not* a drop-in two-stage LipDub skeleton; it's two
  structurally different stages (reference-conditioned restoration, then
  unconditioned light re-denoise) chained together as a practical
  approximation for the *upscale* use case. LipDub genuinely needs the
  reference conditioning (video **and** audio) reapplied at stage 2 with
  the LoRA still fused, which neither existing method does. `generateLipdub`
  will be a new method, structurally *parallel to* `generateHD`+`refine()`
  (same sub-components: `VideoEncoder`, `LatentUpsampler`,
  `TransformerCheckpointLoader`, `DenoiseLoop.runStreaming`,
  `VideoDecoder`) but its own two-stage sequence, mirroring the Python
  `generate_lipdub()` method directly rather than composing the two
  existing methods.
- **`VideoProbe.info(url:)`** (`VideoProbe.swift:37`) already returns
  `fps`/`frameCount`/`hasAudioTrack` for an arbitrary video file — covers
  the "derive frame count from the reference video" requirement with no
  new code.
- **Audio VAE encode/decode** (`AudioVAE/`) and `AudioProcessor().
  waveformToMel` already exist and are reused as-is (same calls
  `generateHD`/`generateRestyle`/`refine` already make).
- **Gap**: nothing today extracts a raw resampled PCM waveform (the
  `WAVReader.Result`-shaped `{channels: [[Float]], sampleRate: Int}`) from
  an arbitrary **video file's own audio track** — `WAVReader` only reads
  standalone `.wav` files, and `AudioProbe.analyze`/`LipsyncMetrics.
  extractAudioEnvelope` only compute derived stats/envelopes via
  `AVAssetReader`, not raw full-rate samples. A small new helper is needed
  (same `AVAssetReader` pattern already used twice in this package, just
  returning samples instead of collapsing them to a scalar/envelope).

## New pieces

### 1. `AudioConditionByReferenceLatent` (`LatentConditioning.swift`)

Sibling to the existing `VideoConditionByReferenceLatent` struct
(`LatentConditioning.swift:111`), same append-not-replace shape, but for
1-axis audio positions `(1, T, 1)` (`Positions.computeAudioPositions`'s
shape) instead of 3-axis video positions, and with a `negativePositions`
option that mirrors Python's `patchify_lipdub_audio_reference_latent`:
shift the reference's own positions to
`positions - (max(positions) + 0.04)` before appending, so every reference
audio token lands strictly before time 0 relative to the generated audio
sequence. `strength` fixed at 1.0 (fully preserved) for this port, same
scope restriction the existing video version already documents for itself.

### 2. `VideoAudioReader` (new small file, e.g. `VideoAudioReader.swift`)

`static func read(url: URL) throws -> WAVReader.Result` — extracts the
first audio track of a video file to raw Float32 PCM per channel via
`AVAssetReader` (same settings block `AudioProbe.analyze` already uses,
minus the stats reduction), returning the exact same shape `WAVReader.
Result` does so it drops into the existing
`resample-then-`AudioVAEEncoderLoader``-encode` code `generateRestyle`/
`generateHD`/`refine` already all repeat. Throws a new
`StageError.referenceVideoNoAudioTrack` if the track is absent (LipDub's
audio conditioning is not optional — mirrors Python's `_has_audio_stream`
pre-flight check in `video-lipdub.py`).

### 3. `NativeUpscaleStage.generateLipdub(...)`

New method. Sequence (mirroring `LipDubPipeline.generate_lipdub` 1:1 at
the architecture level):

1. `VideoProbe.info(referenceVideoURL)` → fps + frame count, snapped down
   to `8k+1` (new tiny `snapFramesTo8k1` helper, same formula as Python's
   `_snap_frames_to_8k1`).
2. `VideoAudioReader.read(referenceVideoURL)` → reference waveform →
   resample to 16kHz (existing `LinearResampler`) → `AudioProcessor().
   waveformToMel` → `AudioVAEEncoderLoader`-encoded reference audio latent
   → `AudioPatchifier.patchify` → `AudioConditionByReferenceLatent(...,
   negativePositions: true)`.
3. Extract exactly `numFrames` frames from the reference video via
   `VideoProbe.frame(url:at:)` in a loop (or `consecutiveFrames`), resize
   each to `(width/2, height/2)` (`FrameLoad.resizeAspectFillCenterCrop`,
   same resize helper `generateIngredients` uses) for stage 1.
4. Stage 1: fuse the LipDub IC-LoRA (`LoRAWeights.load` + `loraSources`,
   same as `generateHD`), build noised video state at half-res, apply
   `VideoConditionByReferenceLatent` (visual) and
   `AudioConditionByReferenceLatent` (speech) to a **freshly-noised**
   audio state (denoiseMask=1 — this is genuinely generated audio, not a
   preserved track, unlike `generateRestyle`/`refine`'s pattern), run
   `DenoiseLoop.runStreaming` over `SigmaSchedule.distilledSigmas`.
5. `LatentUpsampler` 2x on the stage 1 video output (same denormalize
   → upsample → renormalize dance `generate()` already does).
6. Re-extract the same `numFrames` reference frames, resized to
   `(width, height)` this time, and re-run step 4's video-conditioning
   construction at full resolution for stage 2 — LoRA **stays fused**
   (unlike `refine()`), reusing the same loaded `LoRAWeights` rather than
   reloading.
7. Stage 2: video state starts from the upscaled latent at
   `SigmaSchedule.stage2Sigmas[0]` (same forward-noise-to-start-sigma
   pattern `refine()` uses); audio state is **frozen** — built with
   `sigma: 0` and `initial_latent:` the stage 1 audio output tokens (Euler
   step at sigma 0 is a no-op, matching Python's `frozen=True` semantics),
   with `AudioConditionByReferenceLatent` reapplied on top (same reference
   tokens, so the frozen audio still carries the same appended reference
   context — matches Python re-calling `ref_cond.apply` on `audio_state_2`).
   Run `DenoiseLoop.runStreaming` over `SigmaSchedule.stage2Sigmas`.
8. Decode: `VideoDecoder` on the stage 2 video output (drop appended
   reference tokens first, same slice-off pattern `generateHD`/
   `generateRestyle` use); audio decode reuses the **stage 1** audio
   output (not stage 2's frozen-through copy — Python explicitly discards
   stage 2's audio and decodes `s1_audio_latent_tokens`; same call here).

New `StageError` cases: `.referenceVideoNotFound(URL)`,
`.referenceVideoNoAudioTrack(URL)`, `.lipdubLoraNotFound(URL)` — same
style as every existing case in this enum.

Width/height: caller-supplied, snapped to the nearest multiple of 64
(mirrors Python's `_adjust_resolution`) since stage 1 needs an exact half.

### 4. `NativeLipdubCommand.swift` (new CLI, `native-lipdub`)

Same option style as `NativeIngredientsCommand.swift`: `--reference-video`
(required, `String`), `--prompt` (required), `--lora` (required, no
bundled default — matches `native-ingredients`'s convention, even though
a LipDub LoRA happens to already be present locally; the command shouldn't
silently auto-detect it, same reasoning `native-ingredients`'s doc comment
gives for requiring `--lora` explicitly), `--lora-strength` (default 1.0),
`--reference-strength` (default 1.0, threaded to both
`VideoConditionByReferenceLatent` calls — the audio reference conditioning
stays fixed at strength 1.0 per the new primitive's documented scope),
`--width`/`--height` (defaults matching `native-ingredients`'s 640×960),
`--seed`, `--mp4` (on by default, same `AVAssetWriter` mux as
`native-ingredients`).

## Testing

**Unit / numeric parity** (`swift/ltx-video-director/Tests/
LTXVideoDirectorTests/`):
- `AudioConditionByReferenceLatentTests.swift` (new, synthetic — no real
  checkpoint needed, same style as the video version's own tests): confirm
  the append shape/mask/position-concat behavior, and specifically that
  `negativePositions: true` shifts every appended position strictly below
  the minimum of the base audio state's own positions.
- `NativeUpscaleStageRealCheckpointTests.swift`: extend with
  `testGenerateLipdubMissingReferenceVideoThrowsNamedError`,
  `testGenerateLipdubReferenceVideoNoAudioThrowsNamedError` (silent
  reference clip fixture), `testGenerateLipdubMissingLoraThrowsNamedError`
  — same "throws the right named error before touching a checkpoint"
  pattern the existing Missing* tests use.
- `VideoAudioReaderTests.swift` (new): read a short known WAV muxed into a
  test mp4 fixture, confirm extracted samples match reading the same audio
  via the existing `WAVReader` on the pre-mux source file (regression guard
  that the new extractor doesn't silently resample/clip wrong).

**Empirical verification** (Phase 1, manual — same evidence-gathering
style as every prior matrix entry, not a CI assertion): run `native-lipdub`
against a fresh ~8s real talking-head reference clip (same generation
recipe the existing Python LipDub/IA2V matrix entries already used — a
Z-Image portrait + `say`/edge-tts speech, muxed to mp4, OR reuse a
previously-generated reference if one is still on disk). Then run the
**existing** `app/syncnet_bridge.py` (`python/sync-venv`, needs
recreating locally — see Background) against Swift's output mp4, exactly
the same measurement already used for `native-i2v --audio-track` in the
matrix. Record LSE-D/LSE-C/AV-offset directly comparable to the existing
table: Python LipDub CelebV-HQ (12.63/2.068/converges), Python LipDub
TalkVid (13.13/2.003/−1), Python IA2V (16.8+/no convergence), Swift
`--audio-track` (15.66/1.011/no convergence).

## Two-phase gate

**Phase 1** (this design, Swift-only): engine port + `native-lipdub` CLI +
unit tests + one real empirical SyncNet measurement, recorded in the
capability matrix under the `lip_sync` row exactly like every prior entry.

**Phase 2** (pipeline wiring into `pi-agent-ext-movie-director`/
`assets-encoder.ts`) is gated on Phase 1 showing a result **at least as
good as** Swift's existing `--audio-track` tier (ideally competitive with
Python LipDub's ~12.6–13.1 LSE-D). If the Swift-side numeric transformer/
VAE/scheduler differences degrade the result below the existing
`--audio-track` baseline, Phase 2 does not proceed — same disposition
precedent as the multi-reference-ingredients negative result and the
CelebV-HQ-best-but-still-inadequate lip-sync finding already in the
matrix. No specific outcome is assumed here.

## Out of scope

- Any Python `run.py`/`ltx_pipeline.py` changes — Swift is the only
  consumer the movie-director pipeline actually drives.
- Partial-strength/masked video reference conditioning (`strength != 1.0`
  producing a real attention mask) — same scope limit
  `VideoConditionByReferenceLatent`'s existing doc comment already states;
  `AudioConditionByReferenceLatent` inherits the same restriction.
- Auto-detecting the LipDub LoRA from `mlx-models/lora/*lipdub*` the way
  Python's `_find_lipdub_lora()` does — `--lora` stays required, matching
  `native-ingredients`'s existing convention over introducing a new
  auto-detect pattern for one command.
- Re-deriving/validating `python/sync-venv`'s setup as part of this
  design — recreating it (if missing) is a Phase 1 execution prerequisite,
  not a design decision (no new code, just environment setup already
  documented by its prior use).
- Any change to `native-i2v --audio-track`'s existing coarse conditioning
  path — this is a wholly new, separate command, not a modification of the
  existing one.
