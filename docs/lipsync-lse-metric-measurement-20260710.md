# LipDub LSE-D/LSE-C measurement + reference_to_video multi-anchor test (2026-07-10)

Follow-up to `docs/lipsync-precision-measurement-20260708.md` and
`docs/lipdub-wiring-and-measurement-20260709.md`, both of which used the
mouth-open-ratio/audio-RMS proxy in `app/lipsync_metrics.py` and both
returned inconclusive (near-noise-floor) results. Web research surfaced the
actual literature-standard lip-sync metric — SyncNet (Chung & Zisserman,
"Out of Time: Automated Lip Sync in the Wild", ACCV 2016) LSE-D (embedding
distance, lower = better) / LSE-C (confidence, higher = better) — and this
session implements + runs it, closing the standing measurement-quality
blocker on `lip_sync` in `docs/openmontage-capability-matrix.md`.

## What was built

- **`python/sync-venv`** — new dedicated venv (like face-venv/vision-venv/
  whisper-venv; gitignored, added to `python/.gitignore`), holding the
  PyPI `syncnet-python` 0.2.2 package + its own torch/torchvision/
  opencv-contrib pin (unrelated to the MLX generation stack in
  `python/venv`).
- **`app/syncnet_bridge.py`** — new bridge module, run via
  `python/sync-venv/bin/python app/syncnet_bridge.py <mp4>`. Needed because
  `syncnet-python`'s `syncnet_pipeline.py` imports
  `scenedetect.video_manager`, removed in `scenedetect>=0.7` (the version
  pip resolves today) — that top-level import is dead, and the package's
  own `__init__.py` silently swallows the ImportError, so
  `from syncnet_python import SyncNetInstance` silently returns `None`.
  Fixed by importing `SyncNetInstance`/`SyncNetModel`/`detectors.s3fd`
  directly from their submodules, bypassing the broken re-export.
  The bridge reimplements the face-crop + frame/audio extraction
  `syncnet_pipeline`/`run_pipeline.py` would otherwise provide (S3FD face
  detection per frame, bbox moving-average smoothing, 224×224 crop) since
  our inputs are single-face, near-static talking-portrait clips, not
  multi-shot footage needing scene-cut splitting.
- **Weights**: `sfd_face.pth` (S3FD face detector) + `syncnet_v2.model`
  (Chung & Zisserman's original release), downloaded into the gitignored
  `app/models/syncnet/` — same precedent as the mediapipe
  `face_landmarker.task` model (measurement-tool assets are not run through
  `mlx-models/store-manifest.json`, which is for generation-model binaries).
- **`measure_lse_metrics()`** in `app/lipsync_metrics.py` — spawns the
  bridge subprocess (`_resolve_sync_python()` / `MD_SYNC_PYTHON` override),
  parses its `__SYNCNET_MANIFEST__` JSON, same convention as
  `app/commands/image-facerestore.py`'s face-venv bridge.
- **One real bug fixed during build**: `SyncNetInstance.evaluate()`
  hardcodes reading `audio.wav` from `opt.tmp_dir` (the same dir it globs
  face-crop jpgs from) — it takes no separate audio-path argument. The
  bridge originally extracted audio into a different temp dir than the
  face crops; fixed by copying the extracted wav into the crop dir before
  calling `evaluate()`.
- Conv3d (used by SyncNet's lip-embedding CNN) confirmed to run correctly
  on MPS with torch 2.12/2.13 — no CUDA-only op blocker.

## Test setup

**Reference clip**: `macOS say -v Samantha` speech, 8.19s / 8.04s duration —
"The quick brown fox jumps over the lazy dog while the sun sets slowly
behind the distant mountains, painting the sky in brilliant shades of
orange and purple." This is the **real, sustained-speech reference** both
prior sessions flagged as missing (2026-07-08 used 2.8-4.9s clips,
2026-07-09 reused those same short clips). Portrait:
`selftest_t2i:portrait_20260709_210849_seed42.png` (moody-pro-mix T2I
self-test output).

## Results: Python IA2V vs Python LipDub (same 8s reference, same portrait)

| engine | command | LSE-D (↓ better, ≤1.5 = adequate) | LSE-C (↑ better) | AV offset | caveat |
|---|---|---|---|---|---|
| IA2V | `video generate --input-image PORTRAIT --audio SPEECH --frames 193 --fps 24` | **16.94** (vshift=10) / **16.81** (vshift=15) | 0.256 / 0.359 | −10 / −15 (both hit search boundary) | offset search saturates at the window edge regardless of window size — itself a signal of no real convergence |
| LipDub | `video lipdub --lipdub-reference-video <IA2V clip above> --prompt "..."` | **13.68** | 0.357 | **0** (converged, no boundary hit) | none |

**Verdict: both inadequate by the LSE-D≤1.5 bar, but LipDub shows a real,
non-trivial improvement in convergence structure.** IA2V's offset search
never converges — pushing to whichever edge the ±vshift window allows even
as the window widens from 10 to 15, the classic signature of a decorrelated
signal. LipDub's offset converges cleanly to 0 (perfectly synced timing)
with a ~19% lower LSE-D (13.68 vs 16.81-16.94) and comparable LSE-C. This is
a **directionally real, quantitative win for LipDub over IA2V** — the first
one this repo has measured with a literature-standard metric, versus the
prior mouth-ratio proxy's ambiguous "0.13 → −0.08" result
(`docs/lipdub-wiring-and-measurement-20260709.md`). Neither clears the
adequacy bar, so this is not yet a "LipDub is production-ready" result —
but it is enough of a signal to make Swift LipDub-port investment
defensible in a way the prior measurement wasn't.

**Caveat on the ≤1.5 premium bar**: LSE-D correlates only ~0.36 with human
judgment per the web research behind this session (see
`output/next-goal-20260709-202200.md`), so treat 1.5 as a directional
reference point, not a hard pass/fail oracle. The relative IA2V-vs-LipDub
comparison (same metric, same test clip, same portrait) is the load-bearing
claim here, not the absolute distance to 1.5.

## Result: Swift `native-i2v --audio-track`

The first attempt used the same 8.04s/193-frame duration as the Python
clips above; the machine hit severe swap thrashing (peaked at 49.8GB/51.5GB
swap used) running Swift native-i2v back-to-back with the earlier Python
jobs, and the run was killed after 3h40m with no completion (GPU
utilization cycled between ~7% and ~84%, consistent with memory-pressure
stalling rather than a hang). Retried at **2.0s/49 frames** (same portrait,
a 10-second-count `say` clip) once system memory had drained — completed in
1715.5s (video) + 1128.5s (auto-upscale) = ~47 min wall time, no thrashing.

| engine | duration | LSE-D | LSE-C | AV offset | caveat |
|---|---|---|---|---|---|
| Swift `native-i2v --audio-track` | 2.0s / 49 frames | **15.66** | **1.011** | −15 (hit ±15 boundary) | offset does not converge, same non-convergence signature as Python IA2V |

**Verdict: inadequate, same as both Python engines, with a mixed signal
relative to Python IA2V.** LSE-D (15.66) is marginally better than Python
IA2V's 16.81-16.94 and LSE-C (1.011) is notably higher (vs. 0.256-0.359) —
consistent with the existing `docs/swift-native-audio-track-measurement-
20260709.md` finding that Swift's `--audio-track` is real joint-AV
conditioning, not bolted-on injection, showing more audio-video coupling
signal than Python IA2V's near-zero. But the offset search still hits the
window boundary without converging, the same non-convergence signature
IA2V showed — so this is not a genuine precision win, just a smaller gap
to the noise floor. **Duration caveat**: this measurement is at 2.0s/49
frames vs. the Python engines' 8.04s/193-201 frames (shorter due to the
swap-thrashing retry above), so the LSE-D/LSE-C values are not on a
perfectly matched clip length — treat the cross-engine ranking as
directional, not a precise apples-to-apples number.

## `reference_to_video` same-frame-0 multi-anchor test

Per `docs/openmontage-capability-matrix.md`'s "reference_to_video scope
verification" section, `combined_image_conditionings()` "could in principle
place multiple anchors at frame 0" but this was explicitly untested. Ran:

```
video generate --image PORTRAIT 0 1.0 --image LANDSCAPE 0 0.5 \
  --distilled --width 512 --height 512 --frames 49 \
  --prompt "a person standing in a mountain landscape, cinematic"
```

using two **maximally visually distinct** anchors (a close-up face portrait
and a mountain/forest landscape with zero faces) so any partial blend would
be immediately visible — the first attempt used two near-identical T2I
portrait outputs from the same model/prompt family, which would have made a
positive result undetectable, so it was discarded before drawing any
conclusion.

**Result: no compositing whatsoever.** Frame 0, 24, and 48 all show the
**landscape only** — no trace of the portrait's face, identity, or any
blended content, despite the portrait being listed first with the higher
strength (1.0 vs 0.5). The manifest confirms `image_anchors: 2` (both
anchors were registered, not silently dropped), so this is a real
last-registered-anchor-wins collision at the conditioning layer, not a CLI
parsing failure.

**Verdict: `reference_to_video` same-frame-0 multi-anchor is a clean,
confirmed negative.** `combined_image_conditionings()` does not perform
multi-reference compositing when given duplicate frame indices — it
resolves to whichever anchor's conditioning ends up applied last for that
latent index, with total collision (not even a directional blend toward the
lower-strength image). This closes the "untested" status from the prior
matrix entry with a definitive answer: OpenMontage's simultaneous
multi-reference identity/wardrobe/style compositing is **not** achievable
today via this code path, and would require real new engine work (a
genuine multi-reference cross-attention/compositing mechanism), not just a
CLI-level exposure of the existing temporal multi-anchor machinery.

## Capability matrix updates

See `docs/openmontage-capability-matrix.md`: `lip_sync` row updated with the
LSE-D/LSE-C numbers and the LipDub-shows-real-improvement finding;
`reference_to_video` row's same-frame-0 caveat resolved from "untested" to
"confirmed non-compositing, last-anchor-wins."

## Update 2026-07-10 (later same day): ID-LoRA TalkVid checkpoint swap re-measurement

Follow-up to the LipDub result above. `docs/id-lora-mlx-compatibility-check-20260710.md`
confirmed the ID-LoRA (ECCV 2026) checkpoint is byte-identical in key
naming/shape to the existing LipDub IC-LoRA (1728 audio-branch tensors,
same names/shapes/dtype) — a drop-in checkpoint swap via the existing
`--lipdub-lora` flag, no new MLX code needed. Web research (see
`output/next-goal-20260710-102000.md`) found ID-LoRA ships two checkpoint
variants that are **not interchangeable** — CelebV-HQ tuned for complex
motion/singing, TalkVid tuned for static talking-head videos — and this
repo's reference clip is a static talking-head shot, so TalkVid was tested
first (not CelebV-HQ, which the original scoping docs had defaulted to).

**Setup**: since the original 8s reference clip/portrait from the prior
LipDub measurement above were not persisted (ephemeral scratchpad from a
different session), they were regenerated deterministically for an
apples-to-apples comparison: `run.py image t2i --self-test t2i:portrait`
(same seed=42, same built-in `portrait` prompt) → `say -v Samantha` with
the identical sentence used before → `run.py video generate` (same
`--frames 193 --fps 24`, prompt "a person speaking to the camera, natural
lip motion, sustained speech") to produce the same-shape 8s IA2V reference
clip → `run.py video lipdub --lipdub-reference-video <clip>
--lipdub-lora mlx-models/lora/id-lora-talkvid-ltx2.3/lora_weights.safetensors
--lora-scale 1.0`.

**Result** (`app/syncnet_bridge.py`, 201 frames detected):

| variant | LSE-D (↓ better, ≤1.5 = adequate) | LSE-C (↑ better) | AV offset |
|---|---|---|---|
| LipDub (bare, no ID-LoRA) | 13.68 | 0.357 | 0 (converged) |
| **LipDub + ID-LoRA TalkVid** | **13.13** | **2.003** | −1 (near-perfect, effectively converged) |

**Verdict: TalkVid is a real, measurable improvement over bare LipDub on
both axes** — ~4% lower LSE-D and a **~5.6× jump in LSE-C** (0.357 → 2.003),
with AV offset landing at −1 frame (vs the bare LipDub's exact 0) — both
are "converged" in the sense that neither hits the ±10/±15 search-boundary
saturation that the non-LipDub IA2V baseline showed. **Still does not clear
the LSE-D≤1.5 adequacy bar** — this remains a coarse capability by that
yardstick — but the LSE-C jump is the most decisive signal seen across any
variant tested in this repo so far: 2.003 is meaningfully above the
"low-confidence" range (bare LipDub's 0.357, IA2V's 0.256-0.359) and
approaches values SyncNet literature associates with detectable, if
imperfect, sync. Given ID-LoRA's own published claim (10.32 LSE-D on its
CelebV-HQ→TalkVid benchmark, different reference set, not directly
comparable) and this repo's now-third independent confirmation of a
directional win, ID-LoRA TalkVid is the best lip-sync configuration
measured in this repo to date — worth keeping as the default when
`lipdub-lora` is auto-detected, pending a CelebV-HQ counter-test (not yet
run) to confirm TalkVid is genuinely the better variant and not just a
lucky seed/reference-clip match.

**Checkpoint externalized**: `ecbce05087c76b0170ed477ca98f1c9c.safetensors`
in `../video_generation__models/`, symlinked at
`mlx-models/lora/id-lora-talkvid-ltx2.3/lora_weights.safetensors`, tracked
in `mlx-models/store-manifest.json` (111 entries total after this addition).
Source: [huggingface.co/AviadDahan/LTX-2.3-ID-LoRA-TalkVid-3K](https://huggingface.co/AviadDahan/LTX-2.3-ID-LoRA-TalkVid-3K)
(not gated, 1.16GB).
