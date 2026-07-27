# OpenMontage capability matrix

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
| `native_audio` | yes | `video generate --audio X` (A2V), `video t2i2v` | `native-t2a` (output), `--audio-track` in `native-i2v`/`native-relay` = **real joint-loop conditioning, verified 2026-07-09** | Python: joint A/V diffusion, not bolted-on TTS. Swift: `--audio-track` pins the WAV as preserved (denoiseMask=0) tokens INTO the same `DenoiseLoop.runStreaming` call as the video tokens — `a2vCrossAttn` attends to them every step. Prior "injection only, not conditioning" claim was stale (code predates the joint-AV-block port). |
| `multi_shot` | yes | `video relay`, `video segment`, `video storyboard` (new 2026-07-09) | `native-relay`, `native-storyboard` | continuous multi-segment + grid-guide storyboard; `video storyboard` is the new `--story`→video bridge, see below |
| `camera_direction` | yes (text-only) + **camera-control-LoRA wired into the real production `native-relay` chain, v1 = dolly_in/tilt_up — shipped 2026-07-27 (Phase 2)** | `shotLanguage.ts` vocabulary (pan/tilt/dolly/track/crane/handheld/orbital/zoom/rack-focus); `run.py video generate --image ... --lora <cameraman-v2> ...` via `generate_ic_lora()` (not yet wired into a dedicated CLI flag, called directly in the spike script) | same, via `bun-apps/pi-agent-ext-ltx`; **`native-relay --camera-movements dolly_in|tilt_up --camera-lora <cameraman-v2>` now runs real per-segment IC-LoRA conditioning inside the production movie chain (Phase 2, 2026-07-27); `native-restyle --lora <cameraman-v2>` (Phase 1) still works standalone too — see below** | prompt-text conditioning only in the shipped path — no dedicated camera-control LoRA wired into `shotLanguage.ts`/the pipeline yet, see `project_camera_control_lora_research` memory. **2026-07-26 Phase 0 (Python, cheap proof before any Swift/pipeline investment)**: re-checked the HF ecosystem for a plain (non-IC) 22B camera-control LoRA — still none (`Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control` is canny/depth/pose, not camera-specific); `Cseti/LTX2.3-22B_IC-LoRA-Cameraman_v2` remains the only 22B-matched candidate, and it's IC-LoRA (needs a reference motion clip, not a scale param) — same verdict as the 17-day-old memory, re-confirmed rather than assumed stale. Built a synthetic-ground-truth methodology to avoid needing real reference footage: ffmpeg `zoompan`/`crop` on one still image produces 3 labeled reference clips (dolly-in, pan-right, tilt-up) whose motion direction is known by construction; a Farneback dense-optical-flow classifier (`cv2.calcOpticalFlowFarneback`, decomposed into pan/tilt/zoom-radial components) was validated against these clips' own known ground truth before trusting it on generated output. For each of the 3 movements, compared **baseline** (plain `LTXVideoPipeline.generate()`, prompt-only, e.g. "the camera dollies in slowly...", I2V-anchored on the same still) against **treatment** (`generate_ic_lora()` with the Cameraman v2 LoRA + the matching synthetic reference clip, same prompt, same seed) — both distilled, 960×512, 25 frames. Result, all 3/3 consistent: **dolly-in** baseline zoom=1.13 vs treatment zoom=2.74 vs ground-truth 2.59 (treatment ~2.4x baseline, closely tracks ground truth); **pan-right** baseline pan=−0.82 (wrong dominant axis — baseline's motion was dominated by zoom noise, not pan at all) vs treatment pan=−4.16 (correct dominant axis, correctly signed, matches ground truth's own sign) vs ground-truth −15.86; **tilt-up** baseline tilt=−0.01 (essentially zero — no tilting motion reproduced) vs treatment tilt=+6.76 (correct dominant axis, correctly signed, ~76% of ground-truth's +8.85) vs ground-truth +8.85. In every case the prompt-only baseline either produced the wrong dominant motion axis entirely or a much weaker signal; the LoRA+reference treatment consistently reproduced the intended movement as the dominant, correctly-signed motion at a magnitude meaningfully closer to the synthetic ground truth. **Caveats — do not overclaim**: N=1 seed per movement, only 3 of the vocabulary's 9 movement types tested, ground truth is synthetic 2D affine (zoompan/crop) not real camera footage (may not transfer to complex real-world/3D motion or to orbital/handheld/rack-focus), clips are short (25 frames, ~1s) and small (960×512), and the optical-flow metric measures raw pixel motion, not perceptual "does this look like camera-language X" quality. **Bug found and worked around (real, not a usage error)**: `LTXVideoPipeline(distilled=True)` alone resolves `self.transformer` correctly (variant="distilled") but NOT the flat-dir assembly — `_local_components_ready`/`_ensure_flat_dir` reuse the function's raw `transformer` kwarg (which stays `None` when only the boolean is passed), so it silently assembles the WRONG flat dir (`ltx-mlx/dev`, missing `transformer-distilled.safetensors`) instead of `ltx-mlx/distilled` (which has the real `transformer-distilled-1.1.safetensors`) — crashes on load. Workaround: always pass `transformer="distilled"` explicitly alongside `distilled=True`. Not fixed in this pass (out of scope for a measurement spike); affects any caller using the `distilled=True`-only shorthand, including the precedent in `video-restore.py`. **Per the LipDub precedent's two-phase gate**: this Phase 0 result clears the bar for further investment. **Unlike LipDub, no Swift port was needed** — `NativeUpscaleStage.generateRestyle()` (already shipped as `native-restyle`, built for V2V style-transfer IC-LoRAs) turned out to be mechanism-identical to what camera-control needs: single reference video + single IC-LoRA + prompt, no assumption anywhere about what the LoRA does semantically. **2026-07-26 same-day Swift verification**: ran `swift run -c release ltx-video native-restyle --input <ref-frames> --prompt "..." --audio <silence.wav> --lora cameraman_v2.safetensors` directly against the re-downloaded Cameraman v2 checkpoint — it loaded and ran with **zero code changes**, confirming the checkpoint's raw HF safetensors format is compatible with `LoRAWeights.load()`'s existing ComfyUI/diffusers key-remap. Compared against a `native-i2v` prompt-only baseline (same still-image anchor, same prompt, same seed) for the same 3 movements (synthetic references regenerated at 25 frames — LTX requires `8k+1`, the original 48-frame Python-spike clips don't satisfy this and crash Swift's reshape). Results, 2/3 clean + 1/3 positive-but-messier: **dolly-in** baseline zoom=−0.16 (near-zero, wrong sign — baseline actually drifted zoom-OUT) vs treatment zoom=+4.56 vs ground-truth +4.84 (treatment reaches 94% of ground truth, cleaner than the Python run); **tilt-up** baseline tilt=+0.05 (near-zero) vs treatment tilt=+14.17 vs ground-truth +16.68 (85% of ground truth, correct dominant axis); **pan-right** baseline pan=−0.02 (zero) vs treatment pan=−2.53 vs ground-truth −9.43 — treatment's pan signal is ~100x baseline's, correctly signed, but treatment's OWN dominant axis is zoom (−3.45) not pan, unlike the clean dolly-in/tilt-up cases (candidates: the 25-frame reference is a different, faster-panning construction than Python's 48-frame version — not a controlled apples-to-apples comparison across languages; the synthetic pan reference itself carries more incidental zoom signature at this frame count, per its own ground-truth zoom=−7.82 alongside pan=−9.43). **Net**: both Python and Swift show the same qualitative story — prompt-only baseline essentially never reproduces the intended camera movement, LoRA+reference treatment reliably does — with Swift's dolly-in/tilt-up results the cleanest measurements taken so far in either stack. Caveats from the Python paragraph above (N=1 seed, synthetic 2D-affine ground truth, only 3/9 vocabulary movements, optical-flow ≠ perceptual quality) apply equally here. **Next step** (not started): design how `shotLanguage.ts`'s `cameraMovement` enum maps to a per-movement-type reference clip (synthetic zoompan/crop vs curated real footage — the open design question flagged in `project_camera_control_lora_research`) and wire that into the actual generation pipeline; the underlying Swift mechanism itself needs no further engine work. **2026-07-27 wired into the REAL PRODUCTION `native-relay` path (not just the isolated `native-i2v`/`native-restyle` pair from PR #890/#896)**: `scene_plan`'s `shot_language.camera_movement` now flows `assets-encoder.ts` (`RelayLink.cameraMovement`, set only on a scene's FIRST relay link — `chainIndex === 0` — per its doc comment) → `driver-wiring.ts` (`plan.relayLinks.map(l => l.cameraMovement ?? "none")` → the single whole-video `native-relay` dispatch's `cameraMovements` option) → `NativeRelayStage`'s new `--camera-movements`/`--camera-lora` (v1 scoped to exactly `dolly_in`/`tilt_up`; any other value, `"none"`, or omission generates exactly as before). Restricting to a scene's first link only (not every split link) is deliberate: each relay link independently synthesizes its own full movement arc from its own start frame via `SyntheticCameraReference`, so tagging every link of a scene split across `maxCallSeconds` would replay the arc per link (a visible doubled/restarted move) instead of one continuous move across the scene. **Manual verification performed this session** (no automated end-to-end test exists for `NativeRelayStage`'s real chaining behavior — a documented, accepted convention in this codebase: verified manually per session, not via CI): built the release binary (`swift build -c release`, zero errors) and ran a real 2-segment `native-relay` chain (`--camera-movements dolly_in none`, 1088×576, 1.0s/segment). **Finding, not just confirmation**: the task's own originally-specified command (no `--first-image`) does NOT activate the camera-control path for segment 1 — segment 1 is the whole relay's very first segment, so with no supplied start image it's a fresh-T2I/hard-cut segment, and `NativeRelayStage`'s existing (correct, documented) fallback guard — "`camera_movement '...' requested but no start image available (hard-cut/fresh-T2I segment) — generating with plain prompt text instead`" — takes over exactly as designed. This is not a bug: the guard is intentional (`SyntheticCameraReference` needs a real start frame to build its motion arc from) and mirrors production reality — the whole video's first scene (no prior frame to forward) is the most common way to hit this, but any scene with `continuity: "cut"` (a legitimate scene_plan field, discarding the previous scene's last frame for a hard cut) hits the identical fallback if it also has `camera_movement` set; every other non-first, non-cut scene already has a start image forwarded from the previous scene's last frame. There's no manifest-level trace recording when this fallback silently drops requested LoRA conditioning for a scene — only the console log — a known gap, not fixed in this pass. To actually exercise the LoRA path, the run was repeated with `--first-image <a 1088x576 still>`, which produced the expected activation line **`[relay] segment 1: camera-control-LoRA (dolly_in) — synthesizing reference clip`**, followed by `[camera-control] encoding 25 synthetic reference frames...` / `LoRA: loading + fusing Cameraman IC-LoRA into distilled transformer...` / `decoding generated latent to 1088x576 frames...`, and completed cleanly (`seg01/`+`seg02/` each with 25 frames + `audio.wav` + `segment.mp4`, `relay.mp4` muxed, wall time 108.6s). Farneback optical-flow cross-check (same classifier as the Python/Swift spikes above) on segment 1's 25 output frames: **`{"pan": -0.465, "tilt": -0.098, "zoom": 0.862}`** — zoom is the largest-magnitude of the three axes and clearly non-trivial (a plain/uncontrolled generation reads near-zero on this metric per the spike rows above), consistent with a real dolly-in signal, though pan (-0.465) is not negligible either and the zoom magnitude here (0.86) is noticeably smaller than the isolated `native-restyle` spike's dolly-in treatment (+4.56) — plausibly due to the shorter/different reference-frame construction inside the live `native-relay` chain versus the spike's dedicated synthetic reference, not re-diagnosed this session. Read honestly: directionally supportive, not as clean as the isolated spike. Segment 2 (`none`) confirmation: re-ran the same 2-segment chain with `--camera-movements` omitted entirely to a separate output dir; segment 2's `frame_0000.png` is NOT byte-identical between the two runs (`ImageChops.difference` bbox is full-frame) — but this is expected and not a meaningful test, since segment 1 differs between the two runs (one used `--first-image`+`dolly_in`, the other used neither), so segment 2's forwarded start frame necessarily differs too; a frame-diff can't isolate segment 2's own code path this way. The actual confirmation that segment 2 is unaffected is the console log itself: in both runs segment 2 goes straight through `[1/5] Using supplied --input-image...` → `[2/5]`...`[5/5]` with no camera-control print and no fallback-message print (the fallback message only fires when `requestedMovement` is non-nil/non-empty/≠`"none"`), i.e. the identical `stage.generate(segRequest, ...)` code path in both runs — matching the fast unit-test coverage already in place (from an earlier task in this series) asserting byte-identical behavior when `cameraMovements` is unset entirely. |
| `lip_sync` | **coarse (all 3 engine paths) + dedicated LipDub path (Python only) shows a real, quantitative-but-still-inadequate improvement — measured 2026-07-10 with the literature-standard SyncNet LSE-D/LSE-C metric** | IA2V: `video generate --input-image PORTRAIT --audio SPEECH ...`; LipDub: `video lipdub --lipdub-reference-video HEAD.mp4 --prompt "..."` | `native-i2v --input-image PORTRAIT --audio-track SPEECH.wav` | The mouth-ratio/RMS proxy used through 2026-07-09 (`app/lipsync_metrics.py`) was replaced/supplemented 2026-07-10 with a real SyncNet (Chung & Zisserman) LSE-D/LSE-C implementation (`app/syncnet_bridge.py`, dedicated `python/sync-venv`). On an 8s real sustained-speech reference clip: **Python IA2V** LSE-D 16.81-16.94 / LSE-C 0.26-0.36, AV-offset search never converges (hits the ±10/±15 boundary regardless of window width — the signature of a decorrelated signal). **Python LipDub** (same reference, redubbed) LSE-D **13.68** / LSE-C 0.357, AV-offset **converges to 0** — a real, non-trivial improvement in sync structure (~19% lower LSE-D, clean convergence vs. boundary-saturated search), the first LipDub-over-IA2V win measured with a literature-standard metric (superseding the prior mouth-ratio proxy's ambiguous "0.13→−0.08" result). **Swift `--audio-track`** (shorter 2s clip, resource-constrained retry after an 8s attempt hit severe swap thrashing) LSE-D 15.66 / LSE-C **1.011** (notably higher confidence than Python IA2V, consistent with `native_audio` row's "real joint-AV conditioning" finding) but AV-offset still boundary-hits, no convergence. **None of the three clears the LSE-D≤1.5 adequacy bar** — this remains a coarse/inadequate capability across the board, but LipDub is now the one path with a measured directional win, making further Swift LipDub-port investment defensible. Caveat: LSE-D correlates only ~0.36 with human judgment in the literature, so the 1.5 bar is directional, not a hard oracle — the relative IA2V-vs-LipDub-vs-Swift ranking (same metric, same reference) is the load-bearing claim. **2026-07-10 candidate evaluation**: with LipDub confirmed inadequate, evaluated the two LoRA leads filed 2026-07-09 — `elix3r/AV-LoRA-talking-head` **rejected** (per-character-trained, generates its own voice from a text transcript, does not take external reference audio — wrong shape for a dubbing use case); `ID-LoRA` (ECCV 2026, official code+weights) **credible next lead** — same reference-image+reference-audio shape as existing LipDub, reports LSE-D 10.32 on its own CelebV-HQ→TalkVid benchmark (not directly comparable to the 13.68 measured here — different reference set — but same metric family, meaningfully lower). Not integrated this pass — scoped as a future session's work (checkpoint import + conditioning wiring + a same-reference SyncNet re-measurement to get an apples-to-apples number). **ID-LoRA integrated + both checkpoint variants measured 2026-07-10 (later same day)**: swapped in via the existing `--lipdub-lora` drop-in flag against the same freshly-regenerated 8s reference clip. **TalkVid** (`AviadDahan/LTX-2.3-ID-LoRA-TalkVid-3K`): LSE-D 13.13 / LSE-C 2.003 / offset −1. **CelebV-HQ** (`AviadDahan/LTX-2.3-ID-LoRA-CelebVHQ-3K`), tested as a head-to-head counter-test despite variant-selection guidance predicting TalkVid as the better fit for this repo's static-clip use case: LSE-D **12.63** / LSE-C **2.068** / offset −1 — beats TalkVid on both axes, making **CelebV-HQ the best-measured lip-sync configuration in this repo to date** (still short of the ≤1.5 adequacy bar). Both checkpoints were measurement-only — treated as orphan artifacts and not kept externalized in `mlx-models/` after measurement (same disposition as the TalkVid checkpoint removed in the prior cleanup pass); re-download from HF is cheap if CelebV-HQ needs to be re-verified or wired as a real default. One-seed/one-reference-clip caveat applies to the CelebV-HQ-beats-TalkVid finding — not cross-checked with a second seed. **Swift LipDub port measured 2026-07-26**: `NativeUpscaleStage.generateLipdub` + `native-lipdub` CLI ported (two-stage half-res→`LatentUpsampler`→full-res IC-LoRA reference-conditioned pipeline, LoRA fused through both stages, new `AudioConditionByReferenceLatent` primitive freezes the reference video's own audio through stage 2 — see `docs/superpowers/specs/2026-07-26-swift-lipdub-port-design.md`). Generated a fresh 8.375s reference clip (`native-i2v --input-image PORTRAIT.png --audio-track SPEECH.wav`, 800×800→1600×1600, real `say`-generated speech) then ran `swift run -c release ltx-video native-lipdub --reference-video video.mp4 --prompt "a person speaking to the camera, natural lip motion" --lora ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors --width 512 --height 512` (166.9s wall time, real 512×512/201-frame/8.375s output) against the same `ltx-2-3-lipdub` checkpoint the Python numbers above use, then measured with the same `app/syncnet_bridge.py` against Swift's output mp4 (bridge doesn't care which stack produced the input, same cross-stack method already used for the `--audio-track` row): **LSE-D 12.877 / LSE-C 0.882 / AV-offset −15 (boundary-hit, does not converge)**, `n_detected=107/209` frames face-tracked, bridge's own built-in verdict field: `"inadequate"`. **Mixed result, not a clean win**: LSE-D is the best Swift number measured to date — clearly beats Swift's own `--audio-track` baseline (12.877 vs 15.66) and lands *between* Python LipDub's CelebV-HQ (12.63) and TalkVid (13.13) on the metric the matrix's own prior entries call the "load-bearing" one. But LSE-C (0.882) is *lower* than Swift's existing `--audio-track` (1.011) — a regression on that axis versus the simpler existing path, not just versus Python's 2.0+ — and AV-offset fails to converge (same boundary-hit signature as the coarse `--audio-track`/IA2V tier), unlike Python LipDub's clean convergence to −1 on both its CelebV-HQ and TalkVid checkpoints. Per this design's Phase 2 gate ("at least as good as the existing `--audio-track` tier"): the primary/load-bearing LSE-D axis clears the bar decisively, but LSE-C does not — **not an unambiguous pass, so Phase 2 pipeline wiring is deferred**, not proceeded with, pending either a second seed/reference to check whether the LSE-C regression is real or noise, or root-causing why confidence dropped despite distance improving (candidates: Swift's numerical parity gaps in the transformer/VAE stack, the `n_detected=107/209` partial face-tracking coverage itself degrading the confidence computation, or a genuine architectural difference in how the ported two-stage schedule handles the audio branch vs. the vendor Python schedule). One-seed/one-reference-clip caveat applies here too. |
| `dialogue_generation` | yes (same IA2V path) | same as above | not yet verified | speech-from-prompt/audio works "with effort" per `video-generate.py` module docstring voice tips |
| `cinematic_quality` | unproven vs Kling/Veo | n/a | n/a | guidance parity is 3/3 (CFG/STG/modality) as of Milestone 2c, but no measured A/B claim vs premium providers exists |
| `reference_to_video` | **partial, scope-narrow — verified 2026-07-09** | `video generate --image PATH FRAME_IDX STRENGTH` (repeatable, temporal multi-anchor) | `native-ingredients` (IC-LoRA ingredients); `native-i2v --anchor-image PATH:FRAMEIDX[:STRENGTH]` (repeatable, temporal multi-anchor — **ported 2026-07-09**) | see "reference_to_video scope verification" below. Three distinct partial slices: (a) `native-ingredients` = single identity-anchor image (IC-LoRA); (b) run.py `--image` = **temporal** multi-anchor keyframing (N images at chosen frame indices, unblocked by ltx-2-mlx v0.14.15 bd2217a, exposed + verified 2026-07-09); (c) Swift `native-i2v --anchor-image` = the same temporal multi-anchor keyframing ported to Swift, reusing the existing `VideoConditionByLatentIndex` primitive grid-guide/FFLF already exercise (CLI + conditioning-wiring, not new engine work) — verified end-to-end (`[anchor-image] pinning ... -> latent frame N` log line + a real-checkpoint XCTest asserting the pinned image decodes at its target frame). Note: Swift's `frameIndex` is a **latent** frame index (consistent with `--grid-frame-indices`), whereas Python's `--image FRAME_IDX` is a **pixel** frame index — not a drop-in CLI-flag match, callers must convert. None of the three is OpenMontage's simultaneous multi-*reference* (identity/wardrobe/style at frame 0); reference-video/reference-audio anchors still absent. **Same-frame-0 multi-anchor compositing tested 2026-07-10 (was previously "untested, could in principle work"): confirmed negative** — `--image PORTRAIT 0 1.0 --image LANDSCAPE 0 0.5` (two maximally distinct anchors so any partial blend would be visible) produced a clip that is the landscape alone at every sampled frame (0/24/48), zero trace of the portrait, despite the portrait being listed first with higher strength. `combined_image_conditionings()` does not composite same-index anchors — it resolves to a total last-registered-anchor-wins collision. **Reference-sheet compositing tested 2026-07-10 (the mechanism research pointed to as the "correct" approach after the same-frame-0 negative above): also negative, but inconclusively.** Composited a 2-panel reference sheet (portrait + distinct prop, black background, per the documented Ingredients IC-LoRA recipe) and fed it to `native-ingredients`. Unlike the same-frame-0 bug, the underlying mechanism here is architecturally correct (`VideoConditionByReferenceLatent` — a separate reference-latent token sequence via IC-LoRA cross-attention, not a frame-0 collision; confirmed by reading `NativeUpscaleStage.generateIngredients()`). But the multi-panel run output a near-static replay of the input sheet for the full clip (no compositing, no scene generation), while a single-reference control with the same code path *did* generate a fully novel scene (proving the denoise loop isn't just inert) — the multi-panel collapse has no identified root cause yet (candidates: out-of-distribution hard panel edges, unlucky seed, distilled-transformer few-step schedule, or all three). The single-reference control also surfaced a second, separate gap: weak-to-absent identity preservation even in the single-image case (generated scene matched neither the reference nor the prompt's stated subject). No conditioning-strength CLI knob exists to test as a fix — `strength: 1.0` is hardcoded at all 4 conditioning call sites in `NativeUpscaleStage.swift`. **Multi-reference append (N separate images via `VideoConditionByReferenceLatent`, `native-ingredients --input` repeated) tested 2026-07-26: confirmed negative — total collapse to one reference, zero trace of the other.** This mechanism is architecturally distinct from both prior tests above (N independently-encoded reference-latent blocks appended in sequence via the newly-added repeatable `--input`, not a same-frame-0 anchor collision and not a single composited-sheet image) — see `docs/superpowers/specs/2026-07-26-multi-reference-ingredients-design.md` for why it was worth trying separately. Ran `( cd swift/ltx-video-director && swift run -c release ltx-video native-ingredients --input /tmp/mref_portrait/portrait.png --input /tmp/mref_object/object.png --prompt "the person from the reference sits beside the object from the reference, cinematic wide shot, sunlit room" --lora mlx-models/lora/ltx-2-3-ingredients/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors --width 512 --height 512 --seconds 2.0 --output /tmp/native_ingredients_multiref_test )` against two maximally-distinct fresh references generated via `run.py image t2i` (same "maximally distinct" technique as the two prior tests in this row): a close-up portrait of a young red-haired woman, and an unrelated antique brass telescope on a wooden desk with no people. The run completed cleanly — 49 frames @ 800x800 (auto-snapped up from the requested 512x512), 24fps, wall time 429.9s, real `video.mp4` + `audio.wav` produced, no errors. Inspected 5 frames evenly spaced across the full clip (`frame_0000`/`0012`/`0024`/`0036`/`0048` of 49) both by direct visual read and via VLM captioning (`run.py caption --style default`, `google/gemma-4-12b-qat` via LM Studio): every single frame shows only the telescope-on-desk study-room scene from the *second* reference image — same telescope, same wooden table, same window/bookshelf background at every sampled timestamp (the telescope visibly rotates with real motion blur mid-clip, so this is real denoise-driven scene generation, not a frozen replay — ruling out the "near-static replay" failure mode of the reference-sheet test). The portrait reference (red hair, face, young woman) is **completely absent** from all 5 frames and from all 3 VLM captions — no mention of a person, face, hair, or any human subject anywhere in the caption text. Verbatim caption excerpts: frame_0000 — "畫面中央是一個精緻的黃銅望遠鏡...望遠鏡水平橫放在桌面上..." (no person mentioned); frame_0024 — "畫面的核心是一張厚實的古舊木製桌子...在桌子的右側，放置著一個金黃色的黃銅望遠鏡..." (no person mentioned); frame_0048 — "照片的焦點是一個金屬製、呈金黃色的物件，它正放在一張木製桌面上快速旋轉...這個物件看起來像是一個小型望遠鏡..." (no person mentioned). **Verdict: negative.** The append-based mechanism does not composite multiple references — like the two prior mechanisms tested in this row, it collapses to a single reference (here, the second/object reference dominates outright) with zero measurable trace of the other. Only one image ordering, one seed, and the default `--lora-strength 1.0` were tested — the underlying cause (recency bias toward the last-appended reference block in IC-LoRA cross-attention, or something else) is not diagnosed, only the outcome. This closes out the multi-reference-ingredients empirical-verification task with a clear negative; per the design doc, no pipeline wiring follows from this result. |
| `character_consistency` | **yes (storyboard character-lock) — 2026-07-09** | `video storyboard --story ... --character PORTRAIT` (identity-judge closed loop, #366/#371) | — | storyboard decomposition locks a supplied character portrait across all shots via the gemma identity-judge (`--identity-judge-model`, hardened in #372); covers Higgsfield's `character_consistency` flag. Per-shot re-generation until identity matches. |
| `ambient_sound` | **yes — same `native_audio` path, verified 2026-07-10** | `video generate --prompt "<ambient-rich description>"` (no `--audio` input needed) | not yet verified | Veo-only flag, never previously tracked in this matrix — found by rescanning all OpenMontage `supports` dicts this session. `ltx_pipelines_mlx.TI2VidTwoStagesPipeline` generates `audio_latent` unconditionally alongside `video_latent` even with zero audio input (`ti2vid_two_stages.py`), so ambient soundscape is just a matter of prompt content, not a separate code path. Verified with the existing `rainy-street` self-test prompt (pure ambient, zero dialogue): resulting audio is continuous/broadband (RMS 0.241, low frame-to-frame variance = steady texture not silence-punctuated bursts), with energy split across low-rumble/mid/hiss bands matching the prompt's rain/traffic/buzz description. Spectral read, not a human-listening pass. Found and fixed a pre-existing `RecursionError` in `video generate --self-test` on the way (`app/commands/video-generate.py` — self_test field wasn't cleared on the args clone before the recursive call). |

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

**Precision measured 2026-07-08**: a mouth-open-ratio
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
`docs/ltx-vendor-bump-v0.14.15.md`) landed upstream
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
conditionings()`, not a CLI parsing bug. **Confirmed negative, closing this open question**: same-frame-0 multi-anchor is not multi-reference
compositing today — achieving OpenMontage's simultaneous identity/
wardrobe/style compositing would need real new engine work (a genuine
multi-reference cross-attention/compositing mechanism), not just exposing
the existing temporal machinery differently. Reference-video and reference-audio anchors remain
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

Swift is the chosen integration path (user decision, 2026-07-08). As of
2026-07-10 its CLI reaches full parity with `run.py video`'s 10 sub-actions:
`review`/`compare`/`quality`/`vbvr`/`asr-gate` were added this session (see
`project_swift_vs_runpy_video_parity_20260708` memory for the mapping and
scope notes — `quality`'s self-test modes and HTML report, and `review`'s
generate-then-review path, are explicitly NOT ported, only the core
analyze/existing-manifest paths). Against *this* checklist specifically
(not the QA-tooling sub-actions, which are out of scope for the
provider-capability checklist): T2V/I2V/FFLF/multi-shot all have Swift
equivalents.

**`native-i2v --audio-track` IS real joint-loop audio conditioning —
corrected 2026-07-09** (was previously claimed "injection only, not
conditioning," checked 2026-07-08 against `NativeI2VStage.swift:520-544`;
that read was stale). It pins a user-supplied WAV as preserved audio tokens
(`denoiseMask=0`, "don't regenerate this content") but those tokens are
still passed into the SAME `DenoiseLoop.runStreaming` call as the video
tokens (`NativeI2VStage.swift:604-617`), where `a2vCrossAttn`
(`LTXModel.swift:164-235`) lets the video stream attend to them every
denoise step — a real cross-modal conditioning signal, not a post-hoc
splice. Measured 2026-07-09: on a 2-clip
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
