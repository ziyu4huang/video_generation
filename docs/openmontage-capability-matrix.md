# OpenMontage capability matrix (dated 2026-07-08, updated 2026-07-10 — SyncNet LSE-D/LSE-C lip_sync re-measurement + reference_to_video same-frame-0 multi-anchor test + ambient_sound verification)

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
| `text_to_video` | yes (Python) / partial (Swift) | `video generate --prompt ...` (zero image conditioning) | `native-i2v` (no `--input-image`) | checked 2026-07-08 (`NativeI2VCommand.swift:120`): Swift always conditions on an image — if `--input-image` is omitted it runs `NativeT2IStage` internally to generate one first, then does I2V from that. There is no true zero-image T2V path in Swift today. |
| `image_to_video` | yes | `video generate --input-image X --prompt ...` | `native-i2v --input-image X` | |
| `first_last_frame_to_video` | yes | `video generate --begin-image X --end-image Y` | `native-i2v --last-frame` (FFLF) | not even mentioned in OpenMontage's unmerged draft |
| `native_audio` | yes | `video generate --audio X` (A2V), `video t2i2v` | `native-t2a` (output), `--audio-track` in `native-i2v`/`native-relay` = **real joint-loop conditioning, verified 2026-07-09** | Python: joint A/V diffusion, not bolted-on TTS. Swift: `--audio-track` pins the WAV as preserved (denoiseMask=0) tokens INTO the same `DenoiseLoop.runStreaming` call as the video tokens — `a2vCrossAttn` attends to them every step. Prior "injection only, not conditioning" claim was stale (code predates the joint-AV-block port); see `docs/swift-native-audio-track-measurement-20260709.md`. |
| `multi_shot` | yes | `video relay`, `video segment`, `video storyboard` (new 2026-07-09) | `native-relay`, `native-storyboard` | continuous multi-segment + grid-guide storyboard; `video storyboard` is the new `--story`→video bridge, see below |
| `camera_direction` | yes (text-only) | `shotLanguage.ts` vocabulary (pan/tilt/dolly/track/crane/handheld/orbital/zoom/rack-focus) | same, via `bun-apps/pi-agent-ext-ltx` | prompt-text conditioning only — no dedicated camera-control LoRA wired in yet, see `project_camera_control_lora_research` memory |
| `lip_sync` | **coarse (all 3 engine paths) + dedicated LipDub path (Python only) shows a real, quantitative-but-still-inadequate improvement — measured 2026-07-10 with the literature-standard SyncNet LSE-D/LSE-C metric** | IA2V: `video generate --input-image PORTRAIT --audio SPEECH ...`; LipDub: `video lipdub --lipdub-reference-video HEAD.mp4 --prompt "..."` | `native-i2v --input-image PORTRAIT --audio-track SPEECH.wav` | The mouth-ratio/RMS proxy used through 2026-07-09 (`app/lipsync_metrics.py`) was replaced/supplemented 2026-07-10 with a real SyncNet (Chung & Zisserman) LSE-D/LSE-C implementation (`app/syncnet_bridge.py`, dedicated `python/sync-venv`) — see `docs/lipsync-lse-metric-measurement-20260710.md` for full setup + numbers. On an 8s real sustained-speech reference clip: **Python IA2V** LSE-D 16.81-16.94 / LSE-C 0.26-0.36, AV-offset search never converges (hits the ±10/±15 boundary regardless of window width — the signature of a decorrelated signal). **Python LipDub** (same reference, redubbed) LSE-D **13.68** / LSE-C 0.357, AV-offset **converges to 0** — a real, non-trivial improvement in sync structure (~19% lower LSE-D, clean convergence vs. boundary-saturated search), the first LipDub-over-IA2V win measured with a literature-standard metric (superseding the prior mouth-ratio proxy's ambiguous "0.13→−0.08" result). **Swift `--audio-track`** (shorter 2s clip, resource-constrained retry after an 8s attempt hit severe swap thrashing) LSE-D 15.66 / LSE-C **1.011** (notably higher confidence than Python IA2V, consistent with `native_audio` row's "real joint-AV conditioning" finding) but AV-offset still boundary-hits, no convergence. **None of the three clears the LSE-D≤1.5 adequacy bar** — this remains a coarse/inadequate capability across the board, but LipDub is now the one path with a measured directional win, making further Swift LipDub-port investment defensible (`docs/lipdub-swift-port-scoping-20260709.md`). Caveat: LSE-D correlates only ~0.36 with human judgment in the literature, so the 1.5 bar is directional, not a hard oracle — the relative IA2V-vs-LipDub-vs-Swift ranking (same metric, same reference) is the load-bearing claim. **2026-07-10 candidate evaluation**: with LipDub confirmed inadequate, evaluated the two LoRA leads filed 2026-07-09 — `elix3r/AV-LoRA-talking-head` **rejected** (per-character-trained, generates its own voice from a text transcript, does not take external reference audio — wrong shape for a dubbing use case); `ID-LoRA` (ECCV 2026, official code+weights) **credible next lead** — same reference-image+reference-audio shape as existing LipDub, reports LSE-D 10.32 on its own CelebV-HQ→TalkVid benchmark (not directly comparable to the 13.68 measured here — different reference set — but same metric family, meaningfully lower). Not integrated this pass — scoped as a future session's work (checkpoint import + conditioning wiring + a same-reference SyncNet re-measurement to get an apples-to-apples number). See `docs/lipdub-lora-candidate-evaluation-20260710.md`. |
| `dialogue_generation` | yes (same IA2V path) | same as above | not yet verified | speech-from-prompt/audio works "with effort" per `video-generate.py` module docstring voice tips |
| `cinematic_quality` | unproven vs Kling/Veo | n/a | n/a | guidance parity is 3/3 (CFG/STG/modality) as of Milestone 2c, but no measured A/B claim vs premium providers exists |
| `reference_to_video` | **partial, scope-narrow — verified 2026-07-09** | `video generate --image PATH FRAME_IDX STRENGTH` (repeatable, temporal multi-anchor) | `native-ingredients` (IC-LoRA ingredients); `native-i2v --anchor-image PATH:FRAMEIDX[:STRENGTH]` (repeatable, temporal multi-anchor — **ported 2026-07-09**) | see "reference_to_video scope verification" below. Three distinct partial slices: (a) `native-ingredients` = single identity-anchor image (IC-LoRA); (b) run.py `--image` = **temporal** multi-anchor keyframing (N images at chosen frame indices, unblocked by ltx-2-mlx v0.14.15 bd2217a, exposed + verified 2026-07-09); (c) Swift `native-i2v --anchor-image` = the same temporal multi-anchor keyframing ported to Swift, reusing the existing `VideoConditionByLatentIndex` primitive grid-guide/FFLF already exercise (CLI + conditioning-wiring, not new engine work) — verified end-to-end (`[anchor-image] pinning ... -> latent frame N` log line + a real-checkpoint XCTest asserting the pinned image decodes at its target frame). Note: Swift's `frameIndex` is a **latent** frame index (consistent with `--grid-frame-indices`), whereas Python's `--image FRAME_IDX` is a **pixel** frame index — not a drop-in CLI-flag match, callers must convert. None of the three is OpenMontage's simultaneous multi-*reference* (identity/wardrobe/style at frame 0); reference-video/reference-audio anchors still absent. **Same-frame-0 multi-anchor compositing tested 2026-07-10 (was previously "untested, could in principle work"): confirmed negative** — `--image PORTRAIT 0 1.0 --image LANDSCAPE 0 0.5` (two maximally distinct anchors so any partial blend would be visible) produced a clip that is the landscape alone at every sampled frame (0/24/48), zero trace of the portrait, despite the portrait being listed first with higher strength. `combined_image_conditionings()` does not composite same-index anchors — it resolves to a total last-registered-anchor-wins collision. See `docs/lipsync-lse-metric-measurement-20260710.md`. **Reference-sheet compositing tested 2026-07-10 (the mechanism research pointed to as the "correct" approach after the same-frame-0 negative above): also negative, but inconclusively.** Composited a 2-panel reference sheet (portrait + distinct prop, black background, per the documented Ingredients IC-LoRA recipe) and fed it to `native-ingredients`. Unlike the same-frame-0 bug, the underlying mechanism here is architecturally correct (`VideoConditionByReferenceLatent` — a separate reference-latent token sequence via IC-LoRA cross-attention, not a frame-0 collision; confirmed by reading `NativeUpscaleStage.generateIngredients()`). But the multi-panel run output a near-static replay of the input sheet for the full clip (no compositing, no scene generation), while a single-reference control with the same code path *did* generate a fully novel scene (proving the denoise loop isn't just inert) — the multi-panel collapse has no identified root cause yet (candidates: out-of-distribution hard panel edges, unlucky seed, distilled-transformer few-step schedule, or all three). The single-reference control also surfaced a second, separate gap: weak-to-absent identity preservation even in the single-image case (generated scene matched neither the reference nor the prompt's stated subject). No conditioning-strength CLI knob exists to test as a fix — `strength: 1.0` is hardcoded at all 4 conditioning call sites in `NativeUpscaleStage.swift`. See `docs/reference-sheet-multi-anchor-test-20260710.md` for the full experiment, follow-up seeds/layouts not yet tried, and the separate identity-fidelity gap. |
| `character_consistency` | **yes (storyboard character-lock) — 2026-07-09** | `video storyboard --story ... --character PORTRAIT` (identity-judge closed loop, #366/#371) | — | storyboard decomposition locks a supplied character portrait across all shots via the gemma identity-judge (`--identity-judge-model`, hardened in #372); covers Higgsfield's `character_consistency` flag. Per-shot re-generation until identity matches. |
| `ambient_sound` | **yes — same `native_audio` path, verified 2026-07-10** | `video generate --prompt "<ambient-rich description>"` (no `--audio` input needed) | not yet verified | Veo-only flag, never previously tracked in this matrix — found by rescanning all OpenMontage `supports` dicts this session. `ltx_pipelines_mlx.TI2VidTwoStagesPipeline` generates `audio_latent` unconditionally alongside `video_latent` even with zero audio input (`ti2vid_two_stages.py`), so ambient soundscape is just a matter of prompt content, not a separate code path. Verified with the existing `rainy-street` self-test prompt (pure ambient, zero dialogue): resulting audio is continuous/broadband (RMS 0.241, low frame-to-frame variance = steady texture not silence-punctuated bursts), with energy split across low-rumble/mid/hiss bands matching the prompt's rain/traffic/buzz description. Spectral read, not a human-listening pass — see `docs/ambient-sound-verification-20260710.md` for full numbers + caveat. Found and fixed a pre-existing `RecursionError` in `video generate --self-test` on the way (`app/commands/video-generate.py` — self_test field wasn't cleared on the args clone before the recursive call). |

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

**Precision measured 2026-07-08** (full method + data in
`docs/lipsync-precision-measurement-20260708.md`): a mouth-open-ratio
(mediapipe FaceLandmarker) vs. audio-RMS-envelope correlation check across
3 talking-portrait clips (continuous digits speech, plosive-heavy phrase,
speech-with-real-silence-gaps) found **no measurable correlation during
continuous speech** (lag0 Pearson r ≈ 0.01 and ≈ -0.006 on the two
continuous-speech clips) and only a **coarse presence/absence signal**
(r = 0.35 on the clip alternating speech and real silence). Verdict: plain
IA2V lip-sync is *not* a substitute for a dedicated lip-sync model when
phoneme-accurate mouth-shape matching matters — it produces "a face
talking in general," gated by whether audio is present, not frame-accurate
sync. The RunComfy "LTX-2.3 ICLoRA LipDub" workflow (external finding,
`output/next-goal-20260708-235500.md`) is the correct escalation path if a
concrete downstream need for precision lip-sync emerges; not imported
speculatively.

## `reference_to_video` scope verification (2026-07-09)

**OpenMontage's semantics** (read from `../OpenMontage/tools/video/
seedance_video.py`, `veo_video.py`, `grok_video.py` — read-only, per
`feedback_never_modify_openmontage`): `reference_to_video` is a
multi-modal, multi-reference conditioning operation. The richest
definition (Seedance 2.0) accepts **up to 9 reference images** (identity /
wardrobe / setting / style anchors), **up to 3 reference video clips**
(motion / camera / pacing anchors), and **up to 3 reference audio clips**
(voice / music / ambience anchors) — all simultaneously, in one
generation call.

**Swift `native-ingredients` scope** (read `NativeIngredientsCommand.swift`
+ `NativeUpscaleStage.generateIngredients`, and confirmed empirically with
a real generation): a single `referenceImageURL: URL` parameter — one
still image, tiled across the target frame count as IC-LoRA conditioning.
No reference-video parameter, no reference-audio parameter, no
multi-image array — the command's own doc comment already states this
("the reference is a single still image tiled across the generation's
frame count ... not a real input video clip"). It also requires a
user-supplied Ingredients IC-LoRA checkpoint via `--lora` (no bundled
default — one is present locally at
`mlx-models/lora/ltx-2-3-ingredients/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors`
for testing, but the command has no built-in default path).

**Verification generation**: `ltx-video native-ingredients --input
<portrait> --prompt "... sunlit garden, cinematic wide shot" --lora
<ingredients-lora> --width 512 --height 512 --seconds 2.0` produced a real
800×800, 49-frame, 2.0s mp4 (video + audio streams, `video.mp4` via
`AVAssetWriter` mux) in 299.5s wall time — the pipeline runs and is not a
stub.

**Verdict: scope mismatch, not just "unverified."** `native-ingredients`
covers roughly the *identity-anchor image* slice of OpenMontage's
`reference_to_video` (1 image, not up to 9; no wardrobe/setting/style
compositing beyond what a single reference conveys) and covers **none** of
the motion/camera-reference-video or voice/music-reference-audio anchors.
Mapping OpenMontage's `reference_to_video` operation onto this repo's
current native surface would require: (1) extending `native-ingredients`
(or a new command) to accept multiple reference images, and (2) new engine
work for reference-video motion conditioning and reference-audio
conditioning — neither exists in Python `run.py` either (checked: no
`--reference-video`/`--reference-audio` style flags in
`video-generate.py`). This is a capability gap, not just a documentation
gap.

### Multi-anchor I2V update (2026-07-09) — temporal, not multi-reference

The ltx-2-mlx v0.14.15 bump (see
`docs/ltx-2-mlx-vendor-bump-v0.14.15-20260709.md`) landed upstream
`bd2217a` (#45), which removed the CLI guard that rejected >1 image anchor
on the one-stage/distilled paths. run.py now exposes this as a repeatable
`--image PATH FRAME_IDX STRENGTH [CRF]` flag (mutually exclusive with
`--input-image`; parsed by `_ImageAnchorAction` in `video-generate.py`,
normalized to vendor `ImageConditioningInput` in `ltx_pipeline.generate()`).

**Verified 2026-07-09**: `video generate --image portrait_a.png 0 1.0
--image portrait_b.png 48 0.9 --distilled --width 512 --height 512
--frames 49` produced a valid 512×512×49 clip whose **first frame matches
anchor A (frame_idx 0) and last frame matches anchor B (frame_idx 48)** —
the model interpolates through the temporal anchors as intended.

**Scope caveat (do not overclaim):** this is *temporal* multi-anchor
keyframing — N images pinned at distinct **frame indices** that the video
passes through. It is NOT OpenMontage's `reference_to_video`, where N
reference images all condition the **same** output (identity / wardrobe /
setting / style compositing, conceptually all at frame 0). **Tested
2026-07-10**: `--image PORTRAIT 0 1.0 --image LANDSCAPE 0 0.5`
(two maximally distinct anchors — a close-up face and a mountain
landscape with zero faces, so any partial blend would be immediately
visible) produced a clip that is the landscape alone at frames 0/24/48 —
**no trace of the portrait at all**, despite the portrait being listed
first with the higher strength. The manifest confirms both anchors were
registered (`image_anchors: 2`), so this is a genuine
last-registered-anchor-wins collision inside `combined_image_
conditionings()`, not a CLI parsing bug. **Confirmed negative, closing
this open question**: same-frame-0 multi-anchor is not multi-reference
compositing today — achieving OpenMontage's simultaneous identity/
wardrobe/style compositing would need real new engine work (a genuine
multi-reference cross-attention/compositing mechanism), not just exposing
the existing temporal machinery differently. See
`docs/lipsync-lse-metric-measurement-20260710.md` for the frame captures
and full write-up. Reference-video and reference-audio anchors remain
absent (real engine work).

## Storyboard→video bridge (2026-07-09)

New `run.py video storyboard` command (`app/commands/video-storyboard.py`)
composes three already-verified pieces into the OpenMontage-shaped
deliverable none of them alone provides — a story becomes a multi-shot
*video*, not just still panels:

1. the storyline → SceneSpec decomposition + character-lock storyboard loop
   (`image storyboard`, PR #366) — N character-consistent panels, each with
   a 5-layer cinematography prompt (subject/motion/scene/framing/camera
   already baked in by `shot_prompt_builder`, so no separate camera-
   vocabulary wiring was needed for this bridge — it was already text in
   the panel's prompt);
2. the multi-segment Prompt-Relay video pipeline (`video relay`) — chains N
   I2V segments into one concatenated mp4.

Each panel becomes one relay segment: the panel's image is that segment's
I2V starting frame (a **hard per-panel anchor**, not a chained relay-frame
— the storyboard's character-lock already guarantees identity continuity
panel-to-panel, so each segment restarts from its own certified frame
rather than drifting off the previous segment's last generated frame).

One-command path: `run.py video storyboard --story "..." --num-panels 4
--character hero.png --relay-duration 3 --relay-audio narration.mp3`.
Two-step path (reuse an existing `storyboard.json`, skip panel
regeneration): `run.py video storyboard --storyboard-json
out/storyboard_.../storyboard.json`.

**Verified end-to-end (2026-07-09)**: generated the deterministic 3-beat
`image storyboard --self-test` fixture (detective noir, one recurring
character), then fed its `storyboard.json` into `video storyboard
--storyboard-json ...` (dev pipeline, 512×512, 2s/segment). Result: a real
6.05s, 512×512 mp4 with both video and audio streams (`ffprobe`-confirmed),
3 segments correctly concatenated in panel order. Eyeballed two extracted
frames against their source panels' scene descriptions (alley silhouette /
diner reading a case file) — content matched, confirming the relay
correctly consumed each panel's prompt+image rather than just concatenating
placeholder segments.

**Caveats**: the local environment lacks `transformer-distilled.safetensors`
(only the distilled LoRA-on-dev path is available), so this verification
used the dev pipeline (`--stage1-steps 15 --cfg-scale 5.0 --stg-scale 1.0`),
not relay's own `--distilled` default — an environment gap, not a bridge
bug. `--judge` (the storyboard's identity-judge closed loop) was not
exercised in this smoke test; combining it with the video bridge (does a
weak-identity panel get regenerated *before* being handed to relay?) is
untested but should work unmodified since `video storyboard` calls
`image-storyboard.run_storyboard` as-is.

## Swift coverage vs this checklist

Swift is the chosen integration path (user decision, 2026-07-08) but its
CLI is not at parity with `run.py video`'s 10 sub-actions — see
`project_swift_vs_runpy_video_parity_20260708` memory for the full
mapping. Against *this* checklist specifically (not the QA-tooling
sub-actions, which are out of scope for the provider-capability
checklist): T2V/I2V/FFLF/multi-shot all have Swift equivalents.

**`native-i2v --audio-track` IS real joint-loop audio conditioning —
corrected 2026-07-09** (was previously claimed "injection only, not
conditioning," checked 2026-07-08 against `NativeI2VStage.swift:520-544`;
that read was stale). It pins a user-supplied WAV as preserved audio tokens
(`denoiseMask=0`, "don't regenerate this content") but those tokens are
still passed into the SAME `DenoiseLoop.runStreaming` call as the video
tokens (`NativeI2VStage.swift:604-617`), where `a2vCrossAttn`
(`LTXModel.swift:164-235`) lets the video stream attend to them every
denoise step — a real cross-modal conditioning signal, not a post-hoc
splice. Measured 2026-07-09
(`docs/swift-native-audio-track-measurement-20260709.md`): on a 2-clip
sample, Swift's `\|lag0 r\|` (0.13-0.16) is 12-27x Python IA2V's near-zero
values on the same portrait/script content — the code-read holds up. But
the magnitude stays well under the 0.3 "adequate" threshold and the sign
flips between clips, so this is **not** a precision `lip_sync` path either
— it lands in the same "coarse, talking-in-general" tier Python IA2V
already occupies, just confirmed to be real conditioning rather than
inert audio pass-through. Porting Python's dedicated LipDub IC-LoRA path
(true precision lip-sync candidate, itself still unproven — see
`lip_sync` row) to Swift remains unstarted new engine work; the
`native-i2v --audio-track` primitive covers the coarse tier only.
