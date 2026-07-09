# LipDub Swift port — scoping (2026-07-09)

Read-only research, no code written. Prereq check before any implementation:
per `output/next-goal-20260709-080302.md` item 4, the Swift LipDub port stays
**GATED** until Python LipDub's precision is actually proven (the 2026-07-09
measurement was inconclusive — `docs/lipdub-wiring-and-measurement-20260709.md`,
`[[project_lipdub_gated_blocker]]` memory). This doc only answers "how much
work would it be," so a future decision to unblock isn't also a scoping
exercise from zero.

## What LipDub actually does (read from the vendor source)

Read `ltx-2-mlx/packages/ltx-pipelines-mlx/src/ltx_pipelines_mlx/lipdub.py`
(395 lines) + `iclora_utils.py`. `LipDubPipeline` subclasses `ICLoraPipeline`
and adds one extra conditioning modality:

1. **Video reference conditioning** (shared with `ic_lora.py`'s generic
   path): the reference video is VAE-encoded and appended as
   `VideoConditionByReferenceLatent` — channel-concatenated reference tokens
   the generation always attends to (IC-LoRA's actual mechanism, not
   `VideoConditionByLatentIndex`'s "pin these token positions").
2. **Audio reference conditioning** (LipDub-specific, not in generic
   `ic_lora.py`): the reference video's OWN audio track is extracted,
   VAE-encoded, and appended via `AudioConditionByReferenceLatent` with
   **negative-time RoPE positions** (`patchify_lipdub_audio_reference_latent`,
   shifts positions to `[-aud_dur-0.04, -0.04]`) — this is what makes the
   model treat the reference audio as "off-screen context to copy the speech
   content from" rather than mixing it into the target audio timeline.
3. **Two-stage pipeline, LoRA fused through BOTH stages** — a deliberate
   divergence from the generic `ic_lora.py` pattern (which drops the LoRA
   for stage 2's refine pass): stage 1 runs at half-resolution with the
   IC-LoRA fused, output is 2x latent-upsampled, stage 2 refines at full
   resolution with the SAME LoRA still fused and reference conditioning
   re-applied at full res. Stage 2's audio latent is frozen (carried over
   from stage 1 via `sigma=0` + `initial_latent`) — only video is refined
   in stage 2.
4. Frame count/fps are **derived from the reference video's own metadata**
   (`probe_video_info`, snapped to `8k+1`), not user-supplied.

## What Swift already has (surprisingly close)

Checked `NativeUpscaleStage.swift`'s `generateHD`/`generateRestyle`/
`generateIngredients` (the `native-upscale --mode hd`, `native-restyle`,
`native-ingredients` commands) and `Sampling/LatentConditioning.swift`:

- **`VideoConditionByReferenceLatent` is already ported and bit-exact
  parity-tested** against the vendor Python reference
  (`VideoConditionByReferenceLatentParityTests`, `scripts/dump_reference_
  conditioning.py`) — this is LipDub's primary conditioning mechanism, done.
- **LoRA fusion into the distilled transformer is already the established
  mechanism** (`LoRAFusion.swift`), used identically by `native-i2v --lora`
  and `native-upscale --mode hd`'s restoration LoRAs.
- **The joint audio-video `DenoiseLoop.runStreaming`** (video state + audio
  state denoised together, `a2vCrossAttn`/`v2aCrossAttn`) is exactly the
  substrate LipDub's `denoise_loop` call needs — already real, already used
  by `native-i2v`/`native-t2a`/`native-relay`.
- **`generateHD` is single-stage, at the reference's own resolution** — the
  CLI composes it with the existing separate 2x `LatentUpsampler` call
  afterward to get a resolution increase, explicitly NOT the vendor's
  bit-exact two-stage-with-LoRA-refine (`NativeUpscaleStage.swift`'s own doc
  comment says so). So the *pieces* for a two-stage pipeline exist, but no
  single method currently orchestrates "half-res LoRA-fused stage 1 → 2x
  upsample → full-res LoRA-still-fused stage 2" as one call.

## What's genuinely missing (new engine work)

1. **`AudioConditionByReferenceLatent`** — no Swift equivalent exists
   (checked: only `VideoConditionByLatentIndex` and
   `VideoConditionByReferenceLatent` are defined in
   `Sampling/LatentConditioning.swift`). This needs the negative-time
   position shift (`positions - (aud_dur + 0.04)`) that
   `--audio-track`'s existing `VideoConditionByLatentIndex` usage does NOT
   do (it pins forward-time positions). This is a small, well-specified,
   parity-testable numeric primitive — same shape of work as
   `VideoConditionByReferenceLatent` already was, not exploratory.
2. **Reference-video audio extraction** — `--audio-track` today only
   accepts a standalone WAV; LipDub needs to pull the audio track OUT of an
   input video first. Swift already has the building blocks for this
   (`WAVReader`, `AVURLAsset`-based track loading used by
   `WhisperMel.swift`/`VideoSceneDetector.swift`) — this is assembly, not
   new capability, but no existing code path does "video in → WAV out"
   today.
3. **Two-stage orchestration with LoRA fused across both stages** — needs a
   new method (not a reuse of `generateHD`, which is single-stage and
   doesn't carry LoRA-fused state between a half-res and full-res pass).
   The individual ops (VAE encode/decode, `LatentUpsampler`, LoRA fusion,
   reference conditioning at two different resolutions, frozen-audio
   carry-over via `sigma=0`) all exist independently; this is new
   orchestration code wiring them into one pipeline, similar in shape to
   how `NativeI2VStage.generate` itself orchestrates many existing pieces.
4. **Reference-video-driven frame/fps derivation** — the `8k+1` snap math
   already exists (`Request.frames`, duration-based); this is the same math
   applied to a probed video's frame count instead of a requested duration.
   Needs a video-probing utility (frame count + fps), likely `AVURLAsset`
   again (already used elsewhere in this package).
5. **CLI + `commands.ts` wiring** — a new `native-lipdub` subcommand (or a
   `native-i2v`-style extension), modeled in `bun-apps/pi-agent-ext-ltx/src/
   commands.ts` per the `check-flags.ts` convention this repo enforces.

## Effort read

The two hardest primitives an IC-LoRA port would normally need — reference
video conditioning and LoRA-fused joint AV denoising — are **already done
and parity-verified**, because `native-upscale --mode hd` / `native-restyle`
/ `native-ingredients` built them for a different feature first. What
remains is one new, bounded conditioner type (audio reference w/
negative-time positions — small, testable without a real checkpoint, same
pattern as the existing reference-latent parity tests), some assembly
glue (video→WAV extraction, video frame/fps probing), and a genuinely new
two-stage orchestration method that keeps LoRA fused across both stages
(the one piece of real new pipeline-shape work, since nothing in this repo
currently does that "LoRA stays fused through refine" pattern — every
existing two-pass flow, incl. `generateHD`+external-upsample, drops or
never applies a LoRA in its second pass).

This is meaningfully cheaper than the earlier "no Swift equivalent yet,
genuinely large port" framing in `output/next-goal-20260709-080302.md`
suggested — that assessment predates a closer read of
`native-restyle`/`native-ingredients`/`native-upscale --mode hd`, which
turn out to have already solved the IC-LoRA-conditioning half of the
problem for an unrelated feature. It is still real work (a new conditioner
+ new orchestration, not pure CLI wiring like multi-anchor I2V was), but
it's bounded and the highest-risk primitive (does reference conditioning
actually work end-to-end through the real transformer) is de-risked by
`generateHD`'s existing parity tests.

## Still gated

None of the above should be built yet. The prerequisite from
`output/next-goal-20260709-080302.md` item 4 stands: Python LipDub's
lip-sync precision needs a real proof point (a genuine talking-head
reference clip + clear speech, ideally a phoneme/viseme metric, not the
2s synthetic test that produced an inconclusive result) before spending a
new-primitive-plus-orchestration budget porting it to Swift. This scoping
exists so that *when* that proof point lands, the port isn't also a
from-zero investigation.
