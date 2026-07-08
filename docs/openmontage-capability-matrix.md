# OpenMontage capability matrix (dated 2026-07-08)

Read-only survey of what OpenMontage's video-generation providers advertise
as `supports` flags, mapped against what `video_generation__ltx`'s native
MLX/LTX-2.3 stack can actually do today. This file lives entirely in
`video_generation__ltx` — **no code in `../OpenMontage` is ever written or
modified**; see `feedback_never_modify_openmontage` memory for the standing,
permanent guardrail. Re-verify against current source before treating any
row as load-bearing — this repo has now hit stale-capability-claim mistakes
four times in both directions (see prior `output/next-goal-*.md` files).

## Why this file exists

OpenMontage's own two LTX providers (`tools/video/ltx_video_local.py`,
`ltx_video_modal.py`, read on `main` 2026-07-08) undersell this repo:
they declare only `text_to_video`/`image_to_video` with `native_audio:
False`. The premium cloud providers (kling/veo/seedance/runway/higgsfield/
sora/grok, same `tools/video/*.py` read) form the ecosystem's actual
feature checklist via their `supports` dicts. This table is the
freshly-verified status of each flag against this repo, so a future
integration (done by whoever is authorized to touch OpenMontage) has a
correct starting point instead of re-deriving it.

## Capability table

| `supports` flag | status | command (Python `run.py`) | command (Swift `ltx-video`) | notes |
|---|---|---|---|---|
| `text_to_video` | yes | `video generate --prompt ...` | `native-i2v` (verify T2V-without-image path) | |
| `image_to_video` | yes | `video generate --input-image X --prompt ...` | `native-i2v` | |
| `first_last_frame_to_video` | yes | `video generate --begin-image X --end-image Y` | `native-i2v --last-frame` (FFLF) | not even mentioned in OpenMontage's unmerged draft |
| `native_audio` | yes | `video generate --audio X` (A2V), `video t2i2v` | `native-t2a` (output), audio-track passthrough in `native-relay` | joint A/V diffusion, not bolted-on TTS |
| `multi_shot` | yes | `video relay`, `video segment` | `native-relay`, `native-storyboard` | continuous multi-segment + grid-guide storyboard |
| `camera_direction` | yes (text-only) | `shotLanguage.ts` vocabulary (pan/tilt/dolly/track/crane/handheld/orbital/zoom/rack-focus) | same, via `bun-apps/pi-agent-ext-ltx` | prompt-text conditioning only — no dedicated camera-control LoRA wired in yet, see `project_camera_control_lora_research` memory |
| `lip_sync` | **yes, verified 2026-07-08** | `video generate --input-image PORTRAIT --audio SPEECH --prompt "... speaking, mouth moving ..."` (IA2V / talking-portrait) | not yet verified in Swift | see "IA2V verification" below — required a vendor bug fix |
| `dialogue_generation` | yes (same IA2V path) | same as above | not yet verified | speech-from-prompt/audio works "with effort" per `video-generate.py` module docstring voice tips |
| `cinematic_quality` | unproven vs Kling/Veo | n/a | n/a | guidance parity is 3/3 (CFG/STG/modality) as of Milestone 2c, but no measured A/B claim vs premium providers exists |
| `reference_to_video` | partial | — | `native-ingredients` (IC-LoRA ingredients) | scope vs OpenMontage's `reference_to_video` operation not yet verified |

## IA2V verification (2026-07-08)

**Finding**: the pipeline-level machinery for image+audio-simultaneous
conditioning (talking-portrait generation, i.e. `lip_sync`+
`dialogue_generation`) already existed end-to-end in this repo's stack —
`app/ltx_pipeline.py`'s `generate()` already passes both `image=` and
`audio_path=` to `A2VidPipelineTwoStage.generate_and_save()`
(`ltx_pipelines_mlx`, vendored `ltx-2-mlx`), and that vendor pipeline
genuinely supports `image=` as a frame-0 I2V anchor alongside audio
conditioning (not a stub — real `combined_image_conditionings()` +
`VideoConditionByLatentIndex` wiring). CLI-side, only `--begin-image`
(FLF2V mode) was blocked from combining with `--audio`; plain
`--input-image` was never blocked.

**Bug found and fixed**: running `video generate --input-image X --audio Y`
crashed with `TypeError: combined_image_conditionings() missing 1
required keyword-only argument: 'frame_rate'` — a genuine bug in the
vendored `ltx-2-mlx` package's `a2vid_two_stage.py`: `generate_and_save()`
receives `frame_rate` as its own parameter but its internal
`_encode_combined` closure never forwards it to
`combined_image_conditionings()`. Since `ltx-2-mlx`'s own CLI (`a2v
--image ... --audio ...`, documented in its CLAUDE.md) calls the exact
same method, this is an upstream vendor bug, not a wiring gap on this
repo's side.

Fixed via a monkey-patch (never editing the vendor submodule directly,
per repo convention) — `app/vendor_patches.py` Patch 6b
(`_patch_a2v_image_conditioning`): makes `frame_rate` optional on
`combined_image_conditionings`, safe because the single-anchor `image=`
shorthand always uses `frame_idx=0` (`VideoConditionByLatentIndex`),
which never reads `frame_rate` — only true keyframe entries
(`frame_idx != 0`, `VideoConditionByKeyframeIndex`) do, and the patch
raises a clear error if `frame_rate` is missing for those instead of
silently mis-computing positions.

**Verified end-to-end**: generated a 49-frame 512×512 talking-portrait
clip from a Z-Image-generated portrait + `say`-generated speech audio.
Output confirmed via `ffprobe` (h264 video stream + aac audio stream,
matching durations) and a VLM caption of a mid-clip frame (consistent
young-woman portrait framing, i.e. no drift away from the input
identity). Full pipeline (Stage 1 dev+CFG, Stage 2 distilled, decode)
completed without error; non-GPU pytest suite still green after the
patch.

**Not yet assessed**: actual lip-sync *accuracy* (does mouth motion
track the audio waveform, or just "a face talking in general"?) — this
verification only confirms the pipeline runs and produces a
plausible-looking talking-portrait video, not that lip-sync precision
matches dedicated commercial lipsync models (per the July 2026 WaveSpeed
LTX-2.3-Lipsync / ComfyUI IA2V workflow research that motivated this
spike). A frame-by-frame phoneme/mouth-shape correlation check would be
the next step if lip-sync *precision* becomes load-bearing for a real
integration decision.

## Swift coverage vs this checklist

Swift is the chosen integration path (user decision, 2026-07-08) but its
CLI is not at parity with `run.py video`'s 10 sub-actions — see
`project_swift_vs_runpy_video_parity_20260708` memory for the full
mapping. Against *this* checklist specifically (not the QA-tooling
sub-actions, which are out of scope for the provider-capability
checklist): T2V/I2V/FFLF/multi-shot all have Swift equivalents.

**`native-i2v --audio-track` is NOT the same mechanism as Python's
A2V/IA2V** — checked 2026-07-08 (`NativeI2VStage.swift:520-544`). It
*injects* a user-supplied WAV as preserved audio tokens
(`denoiseMask=0`, i.e. "pin this exact audio, don't generate/attend to
it as conditioning") rather than feeding audio in as a true joint
conditioning signal the video-generation denoising loop attends to.
This is fine for "keep my music track through generation" use cases,
but it is **not a path to `lip_sync`** — there is no mechanism in Swift
today by which video generation is conditioned on audio content to
produce synchronized mouth motion. The IA2V fix in this PR lives
entirely in the Python `run.py` / vendored `ltx-2-mlx` layer; porting
true audio-conditioned generation (a Swift `A2VidPipelineTwoStage`
equivalent) to Swift is unstarted and would be new engine work, not a
CLI-surface port.
