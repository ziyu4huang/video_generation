# Swift `native-i2v --audio-track` lip-sync measurement (2026-07-09)

Follow-up to `docs/lipsync-precision-measurement-20260708.md` (Python IA2V) and
the `output/next-goal-20260709-080302.md` re-audit that flagged
`docs/openmontage-capability-matrix.md`'s `native_audio`/`lip_sync` Swift
claim — "`--audio-track` injects preserved tokens, not a conditioning signal
the denoising loop attends to" — as **stale**: reading
`NativeI2VStage.swift:520-556` + `LTXModel.swift:164-235` shows the pinned
audio tokens are handed to the SAME `DenoiseLoop.runStreaming` call as the
video tokens, so `a2vCrossAttn` lets the video stream attend to the real
pinned audio content every step, not merely splice it into the output
post-hoc. This note replaces the code-read with a measurement.

## Method

Same methodology, same face-landmark/audio-RMS Pearson-correlation tool
(`app/lipsync_metrics.py`) and the same portrait
(`selftest_t2i:portrait_20260701_072949_seed42.png`, 640×960) as the Python
IA2V measurement, so results are directly comparable. Two `macOS say -v
Samantha` clips, same script text as the Python "digits"/"plosive" clips:

```
swift/ltx-video-director/.build/.../ltx-video native-i2v \
  --prompt "a person talking to the camera" \
  --input-image <portrait> --audio-track <clip>.wav \
  --seconds 2 --width 640 --height 960 --seed 42 --no-refine [--no-upscale]
```

Distilled transformer (`--no-refine`), 8-step schedule, real 48-block
transformer + AudioVAE + vocoder — 100% native Swift/MLX, zero `run.py`
calls. Wall time ~59-76s per clip on this machine.

## Results

| clip | engine | lag-searched r | best lag | lag0 r | boundary hit | verdict |
|---|---|---|---|---|---|---|
| digits | Python IA2V | 0.259 | 4 | -0.006 | yes | inadequate |
| digits | Swift `--audio-track` | 0.295 | 2 | **0.162** | no | inadequate |
| plosive | Python IA2V | -0.108 | 2 | 0.011 | no | inadequate |
| plosive | Swift `--audio-track` | -0.249 | -1 | **-0.132** | no | inadequate |

(Python rows reproduced from `docs/lipsync-precision-measurement-20260708.md`
for reference; not re-run here — same portrait, same script text, so the
comparison is apples-to-apples without re-spending the Python-side GPU time.)

## Verdict: real conditioning signal confirmed, but still coarse — matrix corrected, not fully overturned

Two independent findings, both real:

1. **The code-read holds up under measurement.** Swift's `|lag0 r|`
   (0.162, 0.132) is 12-27x larger than Python IA2V's near-zero values
   (-0.006, 0.011) on the *same* portrait + script content, and — unlike
   both Python clips' lag-searched numbers — neither Swift lag search hits
   the ±4-frame boundary, so these numbers don't carry the "boundary-hit,
   don't trust it" caveat that flags the Python digits/silence-gaps
   lag-searched figures as inflated. This is consistent with `a2vCrossAttn`
   genuinely attending to the pinned audio content each denoise step, not a
   fluke. **The matrix's blanket claim "there is no mechanism ... video
   generation is conditioned on audio content" is false and must be
   corrected.**
2. **But the magnitude is still well short of "adequate."** Both Swift
   clips remain under the `ADEQUATE_R_THRESHOLD = 0.3` bar, and the sign
   flips between clips (+0.162 digits, -0.132 plosive) — the signature of a
   real-but-weak, not-yet-phoneme-tracking coupling, the same "talking in
   general, not frame-accurate" character the Python IA2V verdict already
   describes. n=2 clips is a small sample (matching the Python note's own
   n=3 caveat); this is a directional result, not a certified benchmark.

**Conclusion**: Swift `native-i2v --audio-track` is real joint-loop audio
conditioning (not "injection only" — correct the matrix), and on this
2-clip sample it shows a *stronger* raw correlation than Python IA2V, but
neither clip crosses the adequacy threshold, so it is **not yet** a
substitute for a dedicated lip-sync model either. Practically: treat Swift
`--audio-track` as at parity with (possibly a notch above) Python IA2V's
already-established "coarse, inadequate for precision lip_sync" tier — not
as a new capability to route load-bearing lip-sync work through.

## Artifacts

Generated clips (not checked in, job-scratch only):
`swift_audio_verify/video.mp4` (digits, 1280×1920 post-upscale),
`swift_audio_verify_plosive/video.mp4` (plosive, 640×960, `--no-upscale`).
