# Lip-sync precision measurement (2026-07-08)

Follow-up to the IA2V vendor-bug fix (PR #365, `docs/openmontage-capability-matrix.md`
"IA2V verification" section): the pipeline was verified to *run* end-to-end and
produce a plausible talking-portrait clip, but whether mouth motion actually
*tracks* the audio (vs. "a face talking in general") was left unmeasured. This
note closes that gap with a numeric verdict.

## Method

Two independent per-frame time series are extracted from each generated mp4
and correlated:

- **mouth-open ratio** — inner-lip vertical gap (mediapipe FaceLandmarker
  landmarks 13/14) normalized by interocular distance (landmarks 33/263), so
  the ratio is invariant to face scale/zoom rather than to mouth width, which
  itself changes with speech. New module: `app/lipsync_metrics.py`.
- **audio RMS envelope** — reused from `app.voice_metrics._frame_rms` /
  `app.audio_noise_detect._extract_audio_pcm` (already-tested decode path, no
  new audio-decoding code), resampled onto the video's frame timestamps.

Correlation is Pearson r, computed two ways:
- **lag-searched r**: best |r| over a ±4-frame lag window (mouth motion could
  plausibly lag audio by a frame or two in a joint audio/video diffusion
  model).
- **lag0 r**: the same Pearson r with *no* lag search (no cherry-picking).

**Methodological finding during the build**: on these short clips (49–97
frames), letting the lag search range wider than ±4 frames drove the reported
|r| up to ~0.35 purely by shrinking the valid-pair count at extreme lags
(fewer overlapping samples → higher spurious-correlation variance), not real
signal — confirmed by checking r at lag=0 directly (≈0.006, i.e. none). This
is why `lipsync_metrics.py` reports both numbers and flags a `caveat` whenever
the lag search hits its ±4 boundary: on a clip that short, the lag-searched r
alone is not trustworthy and lag0 r should be read instead.

## Test clips

Three IA2V talking-portrait clips, same portrait (`selftest_t2i:portrait_
20260701_072949_seed42.png`) and same prompt, `macOS say -v Samantha` speech,
generated via `run.py video generate --input-image X --audio Y`:

| clip | speech content | duration | frames | purpose |
|---|---|---|---|---|
| digits | "One two three... ten" | 2.84s | 49 (2.0s video) | continuous speech, no gaps |
| plosive | "Peter Piper picked..." | 4.90s | 97 (4.0s video) | plosive-heavy (p/b bursts), continuous |
| silence-gaps | "Hello there." + 1.2s real silence + "How are you today." | 2.84s | 49 (2.0s video) | speech/silence alternation |

**Known crash (not fixed here, noted for future work)**: the first
silence-gaps attempt used a shorter (1.85s) audio clip than the requested
49-frame (2.0s) video and crashed with `ValueError: [broadcast_shapes]
Shapes (1,32,47,32) and (1,32,51,32) cannot be broadcast` inside
`ltx_core_mlx/model/transformer/rope.py:apply_rope_split` — an audio-latent
sequence-length mismatch when the audio track is shorter than the video
duration. Worked around here by padding the audio to exceed video duration;
the underlying vendor behavior (silent truncation/pad vs. hard crash on
short audio) is unverified and out of scope for this measurement.

## Results

| clip | lag-searched r | best lag | lag0 r | caveat (boundary hit) | verdict |
|---|---|---|---|---|---|
| digits | 0.259 | 4 | **-0.006** | yes | inadequate |
| plosive | -0.108 | 2 | 0.011 | no | inadequate |
| silence-gaps | 0.474 | 4 | **0.346** | yes | **adequate** |

(Verdict threshold: `\|r\| >= 0.3`, `ADEQUATE_R_THRESHOLD` in
`app/lipsync_metrics.py` — a conventional weak-to-moderate correlation
floor.)

## Verdict: plain IA2V lip-sync precision is **inadequate**

Two of three clips show no real correlation once the lag-search artifact is
discounted (digits lag0 r ≈ 0, plosive lag0 r ≈ 0.01 — both clean, no
boundary-hit caveat). The one clip that crosses the adequacy threshold even
at lag0 (silence-gaps, r=0.346) is the coarsest possible test: does the mouth
open *at all* more during speech than during real silence. That the model
gets *this* right but shows no measurable correlation during continuous
speech (digits, plosive) is the expected signature of "a face talking in
general" — plausible mouth motion gated by presence/absence of audio, not
phoneme-level lip-sync.

**Conclusion**: plain `run.py video generate --input-image --audio` (IA2V)
is suitable for `lip_sync`/`dialogue_generation` at the coarse
"talking-when-there's-sound" level, but is **not** a substitute for a
dedicated lip-sync model when frame-accurate mouth-shape matching matters.
The RunComfy "LTX-2.3 ICLoRA LipDub" workflow (see prior goal's external
findings, `output/next-goal-20260708-235500.md`) remains the correct
escalation path if/when precision lip-sync becomes load-bearing for a real
OpenMontage-shaped deliverable — this measurement does not yet justify
importing it speculatively (no concrete downstream consumer needs
phoneme-accurate sync today).

## Caveats on this measurement itself

- n=3 clips, single portrait, single voice (macOS `say`) — not a broad
  statistical sample. The verdict is a directional signal, not a certified
  benchmark.
- Mouth-open ratio is a 1-D proxy (vertical gap); it cannot distinguish
  correct viseme shape (e.g. "oo" vs "ee") from mere opening amount — a model
  could pass this correlation check while still producing linguistically
  wrong mouth shapes. A phoneme-to-viseme classifier would be a stricter
  follow-up if this axis becomes load-bearing.
- `mediapipe.tasks.python.vision.FaceLandmarker` model bundle
  (`face_landmarker.task`, ~3.6MB) is downloaded on demand to
  `app/models/face_landmark/` (gitignored, same convention as the existing
  `face_detailer.py` face-detection model) — not checked in.

## Artifacts

- `app/lipsync_metrics.py` — the measurement module (`extract_mouth_open_
  series`, `extract_audio_envelope`, `measure_lipsync_precision`); run
  standalone via `python -m app.lipsync_metrics <mp4>`.
- `app/tests/test_lipsync_metrics.py` — 19 tests on the pure-numpy
  correlation/ratio math (synthetic landmarks + synthetic series, no real
  video/audio/mediapipe calls needed for CI).
