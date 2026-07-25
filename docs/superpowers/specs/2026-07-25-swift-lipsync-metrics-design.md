# Swift-Native Lipsync Metrics — Design

(No MLX inference is involved — see Tech Stack below. "Swift-native" means
zero Python, not an MLX port; it lives in the `ltx-video`/MLX-pipeline CLI
for scaffolding reuse, not because it needs MLX.)

**Goal:** Replace the Python dependency in the `evaluate-lipsync` self-learning
loop (`bun-apps/pi-agent-ext-movie-director`, merged 2026-07-25 in #800) with
a pure Swift implementation, consistent with `ltx-video-director`'s existing
mandate as a "python-free video/image/voice quality gateway." First of three
planned Python-removal sub-projects for this pipeline (TTS and LipDub
refinement are separate, larger, not started).

**Architecture:** A new `lipsync-metrics` subcommand in the `ltx-video`
Swift CLI (`swift/ltx-video-director`), reimplementing
`python/mlx-movie-director/app/lipsync_metrics.py`'s
`measure_lipsync_precision()` using native macOS frameworks (Vision +
AVFoundation) instead of mediapipe + ffmpeg subprocesses. `runpy_lipsync.ts`
in `pi-agent-ext-movie-director` is repointed at this binary (via
`pi-agent-ext-ltx`'s existing `ensureBinary()`) and renamed to
`lipsync_metrics.ts`, dropping its Python spawn path entirely — no fallback.

**Tech stack:** Swift 6, `Vision` (`VNDetectFaceLandmarksRequest`),
`AVFoundation` (`AVAssetReader`/`AVAudioFile` for PCM decode), no MLX model
inference needed (Vision's landmarker is a system framework, not a ported
model) — the only reason this lives in `ltx-video-director` rather than a
smaller standalone package is to reuse its existing CLI scaffolding
(swift-argument-parser wiring, `--json` convention) and its position as the
repo's established "native quality gateway" home (`gate`, `quality`,
`asr-gate` already live there).

---

## Component 1: `LipsyncMetrics.swift` (core algorithm)

**File:** `swift/ltx-video-director/Sources/LTXVideoDirector/LipsyncMetrics.swift`

Mirrors `measure_lipsync_precision()`'s structure and constants, adapted to
Vision's landmark topology (not MediaPipe's 468-point FaceMesh — no 1:1
index mapping exists, so this is a fresh implementation of the same
*concept*, not a transliteration):

1. **Frame extraction:** `AVAssetReader` reading the video track, decoding
   each frame to a `CVPixelBuffer` (no PNG round-trip — Vision consumes
   pixel buffers directly, unlike the Python path's `ffmpeg`-to-PNG step).
   Record `fps` from the track's `nominalFrameRate`.

2. **Mouth-open ratio per frame:** `VNImageRequestHandler` +
   `VNDetectFaceLandmarksRequest`. From the first detected face's
   `VNFaceLandmarks2D`:
   - `innerLips.normalizedPoints`: mouth gap = vertical distance between the
     point with max Y and the point with min Y in the region (top/bottom of
     the inner lip contour).
   - `leftEye`/`rightEye` regions: interocular reference = distance between
     the two regions' centroids.
   - ratio = mouth gap / interocular distance (same normalization intent as
     the Python version — scale-invariant, not width-invariant).
   - No face detected → `Double.nan` for that frame (matches Python's NaN
     convention, so the existing pairwise-NaN-masking logic in the
     correlation step ports unchanged).

3. **Audio RMS envelope:** `AVAudioFile` decode to `AVAudioPCMBuffer`
   (Float32 PCM), frame into fixed-size windows (window/hop sized so the
   resulting series has enough points to resample onto per-video-frame
   positions — mirrors `_frame_rms`'s role), compute RMS per window, then
   linearly resample onto `n_samples = ratios.count` positions (same
   `np.interp`-equivalent linear interpolation as the Python version, via a
   small helper — no dependency needed, it's ~10 lines).

4. **Lag-search Pearson correlation:** direct port of `_lagged_pearson` —
   pure math (mean/std/covariance over paired arrays), no framework
   dependency. Same `±4` frame search window, same "drop NaN pairs, skip lag
   if <4 valid pairs" logic.

5. **Verdict + thresholds:** start with the Python version's exact constants
   (`ADEQUATE_R_THRESHOLD = 0.3`, `MIN_MOUTH_STD_THRESHOLD = 0.01`) and the
   same three special cases (flat-mouth-spurious-r, strongly-negative-r,
   lag-search-hit-boundary → caveat text). These thresholds were tuned
   empirically against MediaPipe's landmark scale in the Python version —
   Component 3 (validation) checks whether they still separate known-good
   from known-bad clips under Vision's landmark scale, and this component's
   task includes retuning them if not (see Component 3).

**Output struct**, matching `LipsyncMetrics` (the TS interface in
`runpy_lipsync.ts`) field-for-field so the JSON serializes to the same
shape the TS side already parses:

```swift
struct LipsyncResult: Codable {
    let verdict: String
    let pearsonR: Double?
    let mouthRatioStd: Double?
    let caveat: String?
    let note: String?
    // Extra fields the Python version also emits, kept for parity/debugging:
    let bestLagFrames: Int?
    let lag0PearsonR: Double?
    let fps: Double?
    let nFrames: Int?
    let nDetected: Int?
    let mouthRatioMean: Double?
    let audioRmsMean: Double?

    enum CodingKeys: String, CodingKey {
        case verdict
        case pearsonR = "pearson_r"
        case mouthRatioStd = "mouth_ratio_std"
        case caveat, note
        case bestLagFrames = "best_lag_frames"
        case lag0PearsonR = "lag0_pearson_r"
        case fps
        case nFrames = "n_frames"
        case nDetected = "n_detected"
        case mouthRatioMean = "mouth_ratio_mean"
        case audioRmsMean = "audio_rms_mean"
    }
}
```

Verdict strings match the Python version's vocabulary: `"adequate"`,
`"inadequate"`, `"no_face"` (fewer than 4 frames with a detected face —
same `n_detected < 4` threshold), `"no_audio"` (audio envelope ~zero
variance).

## Component 2: CLI wiring

**File:** `swift/ltx-video-director/Sources/LTXVideoDirectorCLI/LipsyncMetricsCommand.swift`
(new `AsyncParsableCommand`, registered alongside `gate`/`quality`/`asr-gate`
in the CLI's subcommand list — same file that wires those in).

```
ltx-video lipsync-metrics <video.mp4> [--json]
```

Non-`--json` mode: human-readable summary line (mirrors the Python module's
`__main__` `json.dumps(indent=2)`, but pretty-printed key/value like `gate`'s
non-JSON output style). `--json` mode: single-line JSON matching
`LipsyncResult`'s `CodingKeys`.

## Component 3: Validation against the Python version

No new video needs generating — reuse the already-produced, already-scored
clips sitting in the scratch dir from today's `dialogue-scene-v4`/`v5` work
(their Python-computed `*_metrics.json` files are the ground truth). Run:

```
ltx-video lipsync-metrics <clip>.mp4 --json
```

against every clip that has a recorded Python verdict (12 lines from v4,
plus whatever dialogue lines exist from v5 by the time this lands) and
compare `verdict` (not `pearson_r` numerically — different landmark scale
means the numbers won't match, only the pass/fail classification should).

**Acceptance bar:** verdict agreement on at least 10/12 of the v4 clips. If
below that, do not silently ship — inspect where the two disagree (usually
either a flat-mouth clip scoring differently under Vision's mouth-gap scale,
or the lag-search boundary case) and adjust `MIN_MOUTH_STD_THRESHOLD`
specifically (it is the constant most sensitive to landmark-scale
differences; `ADEQUATE_R_THRESHOLD` is a correlation coefficient and is
scale-invariant by construction, so it should not need retuning). Document
whatever threshold ends up used, and why, in a code comment — do not carry
the Python constant forward silently if it was changed.

## Component 4: Wire into `evaluate-lipsync`

**File:** `bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.ts` →
renamed `lipsync_metrics.ts` (no longer runs `run.py`/Python — the old name
is actively misleading once this lands). Update the one import site in
`dispatch.ts` accordingly.

Replace the Python spawn (`defaultSpawn`'s `resolveRepoRoot()`/
`resolveRunPyPaths()` from `@repo/pi-agent-ext-ltx`, invoking
`python/venv/bin/python -m app.lipsync_metrics <video>`) with:

```ts
import { ensureBinary } from "@repo/pi-agent-ext-ltx/src/binary.ts";
// spawn: <ensureBinary() result> lipsync-metrics <videoPath> --json
```

Same `_spawnImpl` test-seam pattern already used by `runpy_tts.ts` etc.
(unchanged interface — `RunPyLipsyncInput`/`RunPyLipsyncOutput` keep their
names for now since renaming those too is a larger, separate cross-cutting
rename not in scope here; only the *module* is renamed, not every exported
symbol). `buildLipsyncArgs()` changes from `["-m", "app.lipsync_metrics",
videoPath]` to `["lipsync-metrics", videoPath, "--json"]`.

No Python fallback path — if the Swift binary is missing, `ensureBinary()`
already handles the "build it once" case (same as every other `ltx-video`
subcommand callers in this repo), so there is nothing extra to add for the
missing-binary case.

**Tests:** `runpy_lipsync.test.ts` (moves to `lipsync_metrics.test.ts`)
updates its `_spawnImpl` assertions to expect the new argv shape; no test
behavior changes beyond that (the tests exercise `buildLipsyncArgs()` and
JSON-parsing of the spawn's stdout, both of which stay structurally the
same — only the args and the binary being modeled change).

## Testing / acceptance

- Component 1: unit tests for `_lagged_pearson`-equivalent pure-math helpers
  (deterministic, no video/Vision dependency — synthetic arrays with known
  correlation). Vision-dependent paths (frame extraction, landmark
  detection) tested via a `RealCheckpoint`-style gated test (existing
  convention in this test target, see
  `NativeUpscaleStageRealCheckpointTests.swift`) using one committed short
  sample clip with a known-adequate verdict, skipped when the fixture is
  absent.
- Component 3's validation table (verdict agreement per clip) gets written
  into the PR description / a scratch report — not a permanent repo
  artifact, since the input clips themselves live in the scratch dir, not
  the repo.
- Component 4: `bun test` in `pi-agent-ext-movie-director` green after the
  rename; `evaluate-lipsync` end-to-end smoke test (one real clip) confirms
  the dispatch case still returns `{metrics, lesson}` with the Swift binary
  doing the work, matching the shape `lipsync-lesson.ts`'s
  `buildLipsyncLesson()` already expects.
