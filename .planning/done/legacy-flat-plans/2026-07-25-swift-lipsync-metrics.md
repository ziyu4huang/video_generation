# Swift-Native Lipsync Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python dependency in `evaluate-lipsync`'s lipsync scoring
with a pure Swift implementation (`ltx-video lipsync-metrics`), using macOS's
`Vision` framework for mouth-landmark tracking (zero ML model porting) and
`AVFoundation` for audio decode.

**Architecture:** New algorithm file + CLI command in the existing
`swift/ltx-video-director` package (already home to `gate`/`quality`/
`asr-gate`, the repo's "native quality gateway" commands), reusing its
existing `VideoProbe`/frame-extraction utilities. `pi-agent-ext-movie-director`'s
`runpy_lipsync.ts` is renamed to `lipsync_metrics.ts` and repointed at the new
Swift binary via `pi-agent-ext-ltx`'s `ensureBinary()` — no Python fallback.

**Tech Stack:** Swift 6, `Vision` (`VNDetectFaceLandmarksRequest`),
`AVFoundation`/`Accelerate` (already used by `AudioProbe.swift` in the same
package), Bun/TypeScript for the adapter layer.

---

## Task 1: Pure-math helpers (resample + lagged Pearson correlation)

No video/Vision/AVFoundation dependency — TDD-able with synthetic arrays.
This becomes the base of `LipsyncMetrics.swift` (Task 3 adds the
Vision/AVFoundation-dependent parts to the same file).

**Files:**
- Create: `swift/ltx-video-director/Sources/LTXVideoDirector/LipsyncMetrics.swift`
- Test: `swift/ltx-video-director/Tests/LTXVideoDirectorTests/LipsyncMetricsTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
@testable import LTXVideoDirector

final class LipsyncMetricsTests: XCTestCase {
    func testLinearResampleUpsamples() {
        let result = LipsyncMetrics.linearResample([0.0, 10.0], to: 5)
        XCTAssertEqual(result.count, 5)
        XCTAssertEqual(result.first!, 0.0, accuracy: 1e-9)
        XCTAssertEqual(result.last!, 10.0, accuracy: 1e-9)
        XCTAssertEqual(result[2], 5.0, accuracy: 1e-9)
    }

    func testLinearResampleSinglePoint() {
        let result = LipsyncMetrics.linearResample([7.0], to: 3)
        XCTAssertEqual(result, [7.0, 7.0, 7.0])
    }

    func testLinearResampleEmptySourceReturnsZeros() {
        let result = LipsyncMetrics.linearResample([], to: 4)
        XCTAssertEqual(result, [0.0, 0.0, 0.0, 0.0])
    }

    func testLaggedPearsonPerfectPositiveCorrelationAtLagZero() {
        let a = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
        let b = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
        let (r, lag) = LipsyncMetrics.laggedPearson(a, b, maxLag: 2)
        XCTAssertEqual(r, 1.0, accuracy: 1e-6)
        XCTAssertEqual(lag, 0)
    }

    func testLaggedPearsonFindsShiftedCorrelation() {
        // b is a shifted onto a by 2 positions — best match at lag=2.
        let a = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
        let b = [0.0, 0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
        let (r, lag) = LipsyncMetrics.laggedPearson(a, b, maxLag: 4)
        XCTAssertEqual(lag, 2)
        XCTAssertGreaterThan(r, 0.99)
    }

    func testLaggedPearsonTooFewSamplesReturnsZero() {
        let (r, lag) = LipsyncMetrics.laggedPearson([1.0, 2.0], [1.0, 2.0], maxLag: 2)
        XCTAssertEqual(r, 0.0)
        XCTAssertEqual(lag, 0)
    }

    func testLaggedPearsonSkipsNaNPairs() {
        let a = [1.0, 2.0, Double.nan, 4.0, 5.0, 6.0, 7.0, 8.0]
        let b = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
        let (r, lag) = LipsyncMetrics.laggedPearson(a, b, maxLag: 1)
        XCTAssertGreaterThan(r, 0.9)
        XCTAssertEqual(lag, 0)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `swift test --package-path swift/ltx-video-director --filter LipsyncMetricsTests`
Expected: FAIL — `LipsyncMetrics` type does not exist / no such module member.

- [ ] **Step 3: Write the minimal implementation**

```swift
//
//  LipsyncMetrics.swift
//  LTXVideoDirector
//
//  Native (Vision + AVFoundation) port of
//  python/mlx-movie-director/app/lipsync_metrics.py's
//  measure_lipsync_precision(): does generated mouth motion track the
//  audio, or is it "a face talking in general"? No Python, no mediapipe —
//  Vision's VNDetectFaceLandmarksRequest is a system framework, not a
//  ported model. Landmark topology differs from mediapipe's 468-point
//  FaceMesh, so this is a fresh implementation of the same CONCEPT
//  (mouth-gap / interocular-distance ratio, correlated against audio RMS
//  via a small lag search), not a numeric port — see
//  docs/superpowers/specs/2026-07-25-swift-lipsync-metrics-design.md for
//  the validation approach against the Python version's verdicts.
//

import Foundation

public enum LipsyncMetrics {
    /// Resample `source` onto `count` points via linear interpolation over
    /// a shared [0, 1] parameterization of both series — same behavior as
    /// `np.interp(np.linspace(0,1,count), np.linspace(0,1,source.count), source)`.
    public static func linearResample(_ source: [Double], to count: Int) -> [Double] {
        guard count > 0 else { return [] }
        guard let first = source.first else { return Array(repeating: 0.0, count: count) }
        guard source.count > 1 else { return Array(repeating: first, count: count) }
        if count == 1 { return [source[0]] }
        var result: [Double] = []
        result.reserveCapacity(count)
        let srcLast = Double(source.count - 1)
        for i in 0..<count {
            let dstFrac = Double(i) / Double(count - 1)
            let srcPos = dstFrac * srcLast
            let lo = Int(srcPos.rounded(.down))
            let hi = min(lo + 1, source.count - 1)
            let frac = srcPos - Double(lo)
            result.append(source[lo] * (1 - frac) + source[hi] * frac)
        }
        return result
    }

    /// Best |Pearson r| between `a` and `b` over lags in [-maxLag, maxLag].
    /// Positive lag means `b` is shifted forward relative to `a`. NaNs are
    /// dropped pairwise per-lag; a lag with fewer than 4 valid pairs is
    /// skipped. Returns (0.0, 0) if fewer than 8 total samples.
    public static func laggedPearson(_ a: [Double], _ b: [Double], maxLag: Int) -> (r: Double, lag: Int) {
        let n = min(a.count, b.count)
        guard n >= 8 else { return (0.0, 0) }
        let a = Array(a.prefix(n))
        let b = Array(b.prefix(n))
        var bestR = 0.0
        var bestLag = 0
        for lag in -maxLag...maxLag {
            let aSeg: [Double]
            let bSeg: [Double]
            if lag >= 0 {
                guard lag < n else { continue }
                aSeg = Array(a[lag...])
                bSeg = Array(b[0..<(n - lag)])
            } else {
                guard -lag < n else { continue }
                aSeg = Array(a[0..<(n + lag)])
                bSeg = Array(b[(-lag)...])
            }
            guard let r = pearson(aSeg, bSeg), abs(r) > abs(bestR) else { continue }
            bestR = r
            bestLag = lag
        }
        return (bestR, bestLag)
    }

    /// Pearson correlation over paired samples, dropping any pair where
    /// either value is NaN. Returns nil if fewer than 4 valid pairs remain,
    /// or either series has ~zero variance.
    static func pearson(_ a: [Double], _ b: [Double]) -> Double? {
        var av: [Double] = []
        var bv: [Double] = []
        av.reserveCapacity(a.count)
        bv.reserveCapacity(a.count)
        for i in 0..<min(a.count, b.count) {
            if !a[i].isNaN && !b[i].isNaN {
                av.append(a[i])
                bv.append(b[i])
            }
        }
        guard av.count >= 4 else { return nil }
        let meanA = av.reduce(0, +) / Double(av.count)
        let meanB = bv.reduce(0, +) / Double(bv.count)
        let stdA = sqrt(av.reduce(0) { $0 + ($1 - meanA) * ($1 - meanA) } / Double(av.count))
        let stdB = sqrt(bv.reduce(0) { $0 + ($1 - meanB) * ($1 - meanB) } / Double(bv.count))
        guard stdA > 1e-9, stdB > 1e-9 else { return nil }
        var cov = 0.0
        for i in 0..<av.count { cov += (av[i] - meanA) * (bv[i] - meanB) }
        cov /= Double(av.count)
        return cov / (stdA * stdB)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `swift test --package-path swift/ltx-video-director --filter LipsyncMetricsTests`
Expected: PASS (6/6 tests).

- [ ] **Step 5: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirector/LipsyncMetrics.swift swift/ltx-video-director/Tests/LTXVideoDirectorTests/LipsyncMetricsTests.swift
git commit -m "feat(ltx-video-director): pure-math lipsync-metrics helpers (resample + lagged Pearson)"
```

---

## Task 2: Verdict/caveat classification (pure logic, no I/O)

Ports `measure_lipsync_precision`'s threshold/caveat decision tree exactly
(same constants, same three special cases), kept separate from the
Vision/AVFoundation extraction code so it's testable with synthetic inputs.

**Files:**
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirector/LipsyncMetrics.swift`
- Test: `swift/ltx-video-director/Tests/LTXVideoDirectorTests/LipsyncMetricsTests.swift`

- [ ] **Step 1: Write the failing tests**

Append to `LipsyncMetricsTests.swift`:

```swift
    func testClassifyVerdictAdequate() {
        let v = LipsyncMetrics.classifyVerdict(r: 0.55, lag: 0, maxLag: 4, lag0R: 0.5, mouthRatioStd: 0.03)
        XCTAssertEqual(v.verdict, "adequate")
        XCTAssertNil(v.caveat)
    }

    func testClassifyVerdictBelowThresholdIsInadequate() {
        let v = LipsyncMetrics.classifyVerdict(r: 0.2, lag: 0, maxLag: 4, lag0R: 0.2, mouthRatioStd: 0.03)
        XCTAssertEqual(v.verdict, "inadequate")
        XCTAssertNil(v.caveat)
    }

    func testClassifyVerdictFlatMouthSpuriousRTreatedInadequateWithCaveat() {
        let v = LipsyncMetrics.classifyVerdict(r: 0.4, lag: 0, maxLag: 4, lag0R: 0.4, mouthRatioStd: 0.004)
        XCTAssertEqual(v.verdict, "inadequate")
        XCTAssertNotNil(v.caveat)
        XCTAssertTrue(v.caveat!.contains("barely moves"))
    }

    func testClassifyVerdictStronglyNegativeRIsInadequateWithCaveat() {
        let v = LipsyncMetrics.classifyVerdict(r: -0.45, lag: 0, maxLag: 4, lag0R: -0.4, mouthRatioStd: 0.03)
        XCTAssertEqual(v.verdict, "inadequate")
        XCTAssertNotNil(v.caveat)
        XCTAssertTrue(v.caveat!.contains("anti-correlated"))
    }

    func testClassifyVerdictLagBoundaryCaveatOverridesOthers() {
        let v = LipsyncMetrics.classifyVerdict(r: 0.5, lag: 4, maxLag: 4, lag0R: 0.1, mouthRatioStd: 0.03)
        XCTAssertEqual(v.verdict, "adequate")
        XCTAssertNotNil(v.caveat)
        XCTAssertTrue(v.caveat!.contains("search boundary"))
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `swift test --package-path swift/ltx-video-director --filter LipsyncMetricsTests`
Expected: FAIL — `classifyVerdict` does not exist.

- [ ] **Step 3: Write the minimal implementation**

Add to `LipsyncMetrics.swift` (inside the `LipsyncMetrics` enum):

```swift
    /// r >= 0.3 (positive direction) is a conventional "weak-to-moderate but
    /// real" correlation floor — same value/rationale as the Python version's
    /// ADEQUATE_R_THRESHOLD. See Task 4's validation step for whether this
    /// (and minMouthStdThreshold below) need retuning under Vision's
    /// landmark scale — ADEQUATE_R_THRESHOLD is a correlation coefficient
    /// and should be scale-invariant; minMouthStdThreshold is a raw ratio
    /// magnitude and is the one actually sensitive to landmark-scale
    /// differences from mediapipe.
    public static let adequateRThreshold = 0.3

    /// Same rationale as the Python version's MIN_MOUTH_STD_THRESHOLD: a
    /// near-flat mouth_ratio series can still clear adequateRThreshold by
    /// chance (Pearson r on a near-constant signal is noise-dominated).
    public static let minMouthStdThreshold = 0.01

    public struct VerdictResult {
        public let verdict: String
        public let caveat: String?
    }

    /// Direct port of measure_lipsync_precision's verdict/caveat decision
    /// tree. `lag0R` is accepted (not currently read) to keep the call site
    /// symmetric with the Python version's signature/data available at the
    /// call site — Swift's classify step does not use it to decide the
    /// verdict, only the lag-boundary caveat text references lag0R being
    /// "the more trustworthy statistic," same as Python.
    public static func classifyVerdict(r: Double, lag: Int, maxLag: Int, lag0R: Double, mouthRatioStd: Double) -> VerdictResult {
        let flatMouth = mouthRatioStd < minMouthStdThreshold
        let verdict = (r >= adequateRThreshold && !flatMouth) ? "adequate" : "inadequate"
        var caveat: String? = nil
        if flatMouth && r >= adequateRThreshold {
            caveat = "pearson_r cleared \(adequateRThreshold) but mouth_ratio_std "
                + "(\(String(format: "%.4f", mouthRatioStd))) is below \(minMouthStdThreshold) — the mouth "
                + "barely moves at all, so this correlation is almost certainly spurious "
                + "noise-alignment rather than real lip-sync. Treated as inadequate."
        } else if r <= -adequateRThreshold {
            caveat = "pearson_r (\(String(format: "%.4f", r))) is strongly negative — the mouth is anti-correlated "
                + "with audio loudness (opens when quiet, closes when loud), which is not "
                + "genuine lip-sync even though |r| clears threshold. Treated as inadequate."
        }
        // A plain `if` (not `else if`) — mirrors the Python version, where
        // the lag-boundary caveat OVERWRITES any caveat set above if both
        // conditions are true.
        if abs(lag) == maxLag {
            caveat = "best_lag_frames hit the search boundary (±\(maxLag)); on short "
                + "clips this can reflect fewer valid sample pairs at extreme lags rather "
                + "than genuine lip-sync offset — treat lag0_pearson_r as the more "
                + "trustworthy statistic in this case."
        }
        return VerdictResult(verdict: verdict, caveat: caveat)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `swift test --package-path swift/ltx-video-director --filter LipsyncMetricsTests`
Expected: PASS (11/11 tests).

- [ ] **Step 5: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirector/LipsyncMetrics.swift swift/ltx-video-director/Tests/LTXVideoDirectorTests/LipsyncMetricsTests.swift
git commit -m "feat(ltx-video-director): lipsync-metrics verdict/caveat classification"
```

---

## Task 3: Vision + AVFoundation extraction and orchestrator

Adds the I/O-dependent half: per-frame mouth-ratio via Vision, audio RMS
envelope via AVFoundation, and `measure(url:)` tying Tasks 1+2 together into
the full `LipsyncResult`.

**Files:**
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirector/LipsyncMetrics.swift`
- Test: `swift/ltx-video-director/Tests/LTXVideoDirectorTests/LipsyncMetricsRealCheckpointTests.swift`

- [ ] **Step 1: Write the failing (gated) integration test**

```swift
//
//  LipsyncMetricsRealCheckpointTests.swift
//  LTXVideoDirectorTests
//
//  Integration smoke test against a REAL talking-head clip — no fixture is
//  committed to the repo (Vision needs an actual face; can't synthesize
//  one), so this is gated on an env var pointing at a clip with a KNOWN
//  verdict, same "skip gracefully if the dependency is absent" pattern as
//  NativeUpscaleStageRealCheckpointTests.swift (checkpoint files there,
//  an env-provided clip here).
//
//  Point LIPSYNC_TEST_VIDEO at a real produced dialogue-scene clip to run
//  this locally, e.g.:
//    LIPSYNC_TEST_VIDEO=/path/to/known_adequate_shot.mp4 swift test \
//      --package-path swift/ltx-video-director --filter LipsyncMetricsRealCheckpointTests
//

import XCTest
@testable import LTXVideoDirector

final class LipsyncMetricsRealCheckpointTests: XCTestCase {
    func testMeasureOnRealClipProducesAScoredVerdict() throws {
        guard let path = ProcessInfo.processInfo.environment["LIPSYNC_TEST_VIDEO"] else {
            throw XCTSkip("LIPSYNC_TEST_VIDEO not set — skipping real-clip integration test")
        }
        let url = URL(fileURLWithPath: path)
        let result = try LipsyncMetrics.measure(url: url)

        // Not asserting a specific verdict (depends on which clip the
        // developer points this at) — asserting the pipeline actually ran
        // end-to-end and produced a real measurement, not a degenerate one.
        XCTAssertTrue(["adequate", "inadequate", "no_face", "no_audio"].contains(result.verdict))
        if result.verdict == "adequate" || result.verdict == "inadequate" {
            XCTAssertNotNil(result.pearsonR)
            XCTAssertNotNil(result.mouthRatioStd)
            XCTAssertNotNil(result.nDetected)
            XCTAssertGreaterThan(result.nDetected!, 0)
        }
    }
}
```

- [ ] **Step 2: Run test to verify it's skipped (no env var set yet)**

Run: `swift test --package-path swift/ltx-video-director --filter LipsyncMetricsRealCheckpointTests`
Expected: SKIP (not a failure) — confirms the gate compiles even before
`LipsyncMetrics.measure`/`LipsyncResult` exist... except it will actually
FAIL TO COMPILE at this point since `measure`/`LipsyncResult` don't exist
yet. Confirm the expected failure is a build error naming `measure`/
`LipsyncResult`, not a test-runtime failure.

- [ ] **Step 3: Write the minimal implementation**

Add to `LipsyncMetrics.swift` (top of file, alongside existing `import Foundation`):

```swift
import AVFoundation
import Vision
```

Add inside the `LipsyncMetrics` enum:

```swift
    public struct LipsyncResult: Codable {
        public let verdict: String
        public let pearsonR: Double?
        public let mouthRatioStd: Double?
        public let caveat: String?
        public let note: String?
        public let bestLagFrames: Int?
        public let lag0PearsonR: Double?
        public let fps: Double?
        public let nFrames: Int?
        public let nDetected: Int?
        public let mouthRatioMean: Double?
        public let audioRmsMean: Double?

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

    struct MouthSeries {
        let ratios: [Double]  // NaN for frames with no detected face
        let fps: Double
        let nFrames: Int
        let nDetected: Int
    }

    /// Lag search window in video frames — same value as the Python
    /// version's _MAX_LAG_FRAMES.
    public static let maxLagFrames = 4

    static func mean(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0.0 }
        return values.reduce(0, +) / Double(values.count)
    }

    static func standardDeviation(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0.0 }
        let m = mean(values)
        let variance = values.reduce(0) { $0 + ($1 - m) * ($1 - m) } / Double(values.count)
        return sqrt(variance)
    }

    private static func centroid(_ points: [CGPoint]) -> CGPoint {
        guard !points.isEmpty else { return .zero }
        let sum = points.reduce(CGPoint.zero) { CGPoint(x: $0.x + $1.x, y: $0.y + $1.y) }
        return CGPoint(x: sum.x / Double(points.count), y: sum.y / Double(points.count))
    }

    /// Inner-lip vertical extent / interocular distance, in image-pixel
    /// space, for one face observation. `boundingBox` is Vision's
    /// full-image-normalized, bottom-left-origin face rect;
    /// `landmarks.*.normalizedPoints` are normalized WITHIN that box —
    /// converting both to a shared pixel space cancels out face-scale/zoom,
    /// same intent as the Python version's mediapipe-normalized-space ratio.
    static func mouthOpenRatio(landmarks: VNFaceLandmarks2D, boundingBox: CGRect, imageWidth: Int, imageHeight: Int) -> Double? {
        guard let innerLips = landmarks.innerLips, innerLips.pointCount > 0,
              let leftEye = landmarks.leftEye, leftEye.pointCount > 0,
              let rightEye = landmarks.rightEye, rightEye.pointCount > 0
        else { return nil }

        func toPixel(_ p: CGPoint) -> CGPoint {
            CGPoint(
                x: (boundingBox.origin.x + p.x * boundingBox.width) * Double(imageWidth),
                y: (boundingBox.origin.y + p.y * boundingBox.height) * Double(imageHeight)
            )
        }

        let lipYs = innerLips.normalizedPoints.map { toPixel($0).y }
        guard let maxY = lipYs.max(), let minY = lipYs.min() else { return nil }
        let mouthGap = maxY - minY

        let leftCenter = centroid(leftEye.normalizedPoints.map(toPixel))
        let rightCenter = centroid(rightEye.normalizedPoints.map(toPixel))
        let interocular = hypot(leftCenter.x - rightCenter.x, leftCenter.y - rightCenter.y)
        guard interocular > 1e-6 else { return nil }
        return mouthGap / interocular
    }

    /// Per-frame mouth-open ratio for every frame of the video (NaN where no
    /// face is detected). Reuses VideoProbe's existing consecutive-frame
    /// extraction (the same utility VideoGate's motion check uses) rather
    /// than writing a new AVAssetReader frame walk.
    static func extractMouthOpenSeries(url: URL) throws -> MouthSeries {
        let info = try VideoProbe.info(url: url)
        guard info.fps > 0, info.duration > 0 else {
            return MouthSeries(ratios: [], fps: info.fps, nFrames: 0, nDetected: 0)
        }
        let frameCount = max(1, Int((info.duration * info.fps).rounded()))
        let frames = try VideoProbe.consecutiveFrames(url: url, startTime: 0, count: frameCount, fps: info.fps)

        var ratios: [Double] = []
        ratios.reserveCapacity(frames.count)
        var nDetected = 0
        for image in frames {
            var ratio = Double.nan
            let request = VNDetectFaceLandmarksRequest()
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            if (try? handler.perform([request])) != nil,
               let face = request.results?.first,
               let landmarks = face.landmarks,
               let r = mouthOpenRatio(landmarks: landmarks, boundingBox: face.boundingBox, imageWidth: image.width, imageHeight: image.height) {
                ratio = r
                nDetected += 1
            }
            ratios.append(ratio)
        }
        return MouthSeries(ratios: ratios, fps: info.fps, nFrames: frames.count, nDetected: nDetected)
    }

    /// Decode the first audio track to mono Float32 PCM. Deliberately
    /// separate from AudioProbe.swift's own private decode loop (same
    /// AVAssetReader settings, small duplication) rather than refactoring
    /// AudioProbe to expose raw samples — that file serves a different
    /// consumer (VideoGate) and isn't part of this change's scope.
    private static func decodeMonoPCM(url: URL) -> [Float] {
        let asset = AVURLAsset(url: url)
        guard let track = asset.tracks(withMediaType: .audio).first,
              let reader = try? AVAssetReader(asset: asset)
        else { return [] }
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVNumberOfChannelsKey: 1,
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        reader.add(output)
        reader.startReading()
        var samples: [Float] = []
        while let buffer = output.copyNextSampleBuffer() {
            guard let blockBuffer = CMSampleBufferGetDataBuffer(buffer) else { continue }
            let length = CMBlockBufferGetDataLength(blockBuffer)
            var data = [UInt8](repeating: 0, count: length)
            CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: &data)
            data.withUnsafeBytes { raw in
                let floats = raw.bindMemory(to: Float32.self)
                samples.append(contentsOf: floats)
            }
        }
        return samples
    }

    /// Audio RMS envelope resampled onto `nSamples` points spanning the
    /// clip — mirrors the Python version's extract_audio_envelope.
    static func extractAudioEnvelope(url: URL, nSamples: Int) -> [Double] {
        guard nSamples > 0 else { return [] }
        let samples = decodeMonoPCM(url: url)
        guard samples.count >= 1024 else { return Array(repeating: 0.0, count: nSamples) }

        let windowSize = 1024
        var rmsFrames: [Double] = []
        var i = 0
        while i < samples.count {
            let end = min(i + windowSize, samples.count)
            let chunk = samples[i..<end]
            var sumSq: Float = 0
            for v in chunk { sumSq += v * v }
            rmsFrames.append(Double(sqrt(sumSq / Float(chunk.count))))
            i = end
        }
        guard rmsFrames.count >= 2 else { return Array(repeating: 0.0, count: nSamples) }
        return linearResample(rmsFrames, to: nSamples)
    }

    /// End-to-end: extract both series, correlate, verdict. Mirrors
    /// measure_lipsync_precision()'s structure exactly (same early-exit
    /// order: no_face check before no_audio check).
    public static func measure(url: URL) throws -> LipsyncResult {
        let mouth = try extractMouthOpenSeries(url: url)
        guard mouth.nDetected >= 4 else {
            return LipsyncResult(
                verdict: "no_face", pearsonR: nil, mouthRatioStd: nil, caveat: nil,
                note: "insufficient face detections", bestLagFrames: nil, lag0PearsonR: nil,
                fps: mouth.fps, nFrames: mouth.nFrames, nDetected: mouth.nDetected,
                mouthRatioMean: nil, audioRmsMean: nil)
        }

        let audioEnv = extractAudioEnvelope(url: url, nSamples: mouth.ratios.count)
        let audioStd = standardDeviation(audioEnv.filter { !$0.isNaN })
        guard audioStd >= 1e-9 else {
            return LipsyncResult(
                verdict: "no_audio", pearsonR: nil, mouthRatioStd: nil, caveat: nil,
                note: "audio envelope has ~zero variance (silent/missing track)",
                bestLagFrames: nil, lag0PearsonR: nil,
                fps: mouth.fps, nFrames: mouth.nFrames, nDetected: mouth.nDetected,
                mouthRatioMean: nil, audioRmsMean: nil)
        }

        let (r, lag) = laggedPearson(mouth.ratios, audioEnv, maxLag: maxLagFrames)
        let lag0R = pearson(mouth.ratios, audioEnv) ?? 0.0
        let validRatios = mouth.ratios.filter { !$0.isNaN }
        let mouthRatioStd = standardDeviation(validRatios)
        let mouthRatioMean = mean(validRatios)
        let audioRmsMean = mean(audioEnv)

        let classification = classifyVerdict(r: r, lag: lag, maxLag: maxLagFrames, lag0R: lag0R, mouthRatioStd: mouthRatioStd)

        func round4(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }
        func round6(_ v: Double) -> Double { (v * 1_000_000).rounded() / 1_000_000 }

        return LipsyncResult(
            verdict: classification.verdict,
            pearsonR: round4(r),
            mouthRatioStd: round4(mouthRatioStd),
            caveat: classification.caveat,
            note: nil,
            bestLagFrames: lag,
            lag0PearsonR: round4(lag0R),
            fps: mouth.fps,
            nFrames: mouth.nFrames,
            nDetected: mouth.nDetected,
            mouthRatioMean: round4(mouthRatioMean),
            audioRmsMean: round6(audioRmsMean)
        )
    }
```

- [ ] **Step 4: Build and run the full test target**

Run: `swift build --package-path swift/ltx-video-director`
Expected: builds clean (no Vision/AVFoundation linking errors — both are
system frameworks on macOS, no Package.swift dependency changes needed).

Run: `swift test --package-path swift/ltx-video-director --filter LipsyncMetricsTests`
Expected: PASS (still 11/11 — Task 1/2 tests unaffected).

Run: `swift test --package-path swift/ltx-video-director --filter LipsyncMetricsRealCheckpointTests`
Expected: SKIP (env var not set in this environment) — confirms it compiles
and skips cleanly rather than failing.

- [ ] **Step 5: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirector/LipsyncMetrics.swift swift/ltx-video-director/Tests/LTXVideoDirectorTests/LipsyncMetricsRealCheckpointTests.swift
git commit -m "feat(ltx-video-director): Vision+AVFoundation lipsync extraction + measure() orchestrator"
```

---

## Task 4: CLI command + registration

**Files:**
- Create: `swift/ltx-video-director/Sources/LTXVideoDirectorCLI/LipsyncMetricsCommand.swift`
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirectorCLI/LTXVideoDirectorCLI.swift`

Note: the CLI command struct is named `LipsyncMetricsCommand`, not the
terser `LipsyncMetrics` some sibling commands use (`Gate`, `Quality`) —
`LTXVideoDirectorCLI.swift` does `import LTXVideoDirector`, which brings the
library's `LipsyncMetrics` enum (Task 1-3) into unqualified scope; naming
the CLI struct identically would shadow it and force every internal call
site to write the fully-qualified `LTXVideoDirector.LipsyncMetrics.measure`.
Keep the descriptive name — do not "fix" this into a collision.

- [ ] **Step 1: Create the command file**

```swift
//
//  LipsyncMetricsCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video lipsync-metrics` — measure whether generated mouth motion
//  tracks the audio. Pure Swift port of
//  python/mlx-movie-director/app/lipsync_metrics.py's
//  measure_lipsync_precision(); see LTXVideoDirector/LipsyncMetrics.swift.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

extension LTXVideoDirectorCLI {
    struct LipsyncMetricsCommand: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "lipsync-metrics",
            abstract: "Measure mouth-motion/audio correlation for a talking-head video (no Python)."
        )

        @Argument(help: "Video file to measure.")
        var video: String

        @Flag(help: "Emit machine-readable JSON.")
        var json = false

        func run() throws {
            let url = URL(fileURLWithPath: video)
            let result = try LipsyncMetrics.measure(url: url)

            if json {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                let data = try encoder.encode(result)
                print(String(data: data, encoding: .utf8) ?? "{}")
            } else {
                print("verdict: \(result.verdict)")
                if let r = result.pearsonR { print("pearson_r: \(r)") }
                if let std = result.mouthRatioStd { print("mouth_ratio_std: \(std)") }
                if let lag = result.bestLagFrames { print("best_lag_frames: \(lag)") }
                if let caveat = result.caveat { print("caveat: \(caveat)") }
                if let note = result.note { print("note: \(note)") }
            }
        }
    }
}
```

- [ ] **Step 2: Register the subcommand**

In `LTXVideoDirectorCLI.swift`, add a line to the doc comment block (after
the `transcribe` line) and add `LipsyncMetricsCommand.self` to the
`subcommands` array:

```swift
//    transcribe    — PURE SWIFT (no run.py): native Whisper → WhisperResult JSON
//                    (segment-level timestamps), the bun:whisper backend
//    lipsync-metrics — PURE SWIFT (no run.py, no Python): mouth-motion/audio
//                    correlation for a talking-head video (Vision + AVFoundation)
//
```

```swift
        subcommands: [I2V.self, NativeI2V.self, NativeRelay.self, NativeStoryboard.self, NativeT2A.self, Vbvr.self, Gate.self, AsrGate.self, Review.self, Compare.self, Quality.self, Verify.self, Upscale.self, NativeUpscale.self, NativeRestyle.self, NativeIngredients.self, Models.self, AudioDecode.self, VideoDecode.self, T2I.self, Segment.self, Transcribe.self, LipsyncMetricsCommand.self]
```

- [ ] **Step 3: Build and smoke-test**

Run: `swift build -c release --package-path swift/ltx-video-director`
Expected: builds clean.

Run: `swift/ltx-video-director/.build/release/ltx-video lipsync-metrics --help`
Expected: prints the command's usage/options (confirms registration).

Run against a real clip if one is available locally (any dialogue-scene shot
from this session's scratch dir works):
```bash
swift/ltx-video-director/.build/release/ltx-video lipsync-metrics \
  /path/to/some_shot.mp4 --json
```
Expected: JSON with `verdict`/`pearson_r`/`mouth_ratio_std` keys, no crash.

- [ ] **Step 4: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirectorCLI/LipsyncMetricsCommand.swift swift/ltx-video-director/Sources/LTXVideoDirectorCLI/LTXVideoDirectorCLI.swift
git commit -m "feat(ltx-video-director): register ltx-video lipsync-metrics subcommand"
```

---

## Task 5: Validate against the Python version's verdicts

Not a permanent repo test (the input clips live in a scratch dir, not the
repo) — a one-time calibration check, written up in the PR description.

**Files:**
- Create (scratch, not committed): a comparison script, e.g.
  `/tmp/compare_lipsync_verdicts.sh` — exact path doesn't matter, it's not
  part of the deliverable.

- [ ] **Step 1: Build the release binary**

Run: `swift build -c release --package-path swift/ltx-video-director`

- [ ] **Step 2: Run the Swift binary against every clip with a known Python verdict**

For every `*_shot.mp4` / `*_metrics.json` pair produced in this session's
`dialogue-scene-v4`/`v5` work (12 v4 lines + 6 v5 dialogue lines = 18 known
verdicts — skip the 5 v5 action-shot clips, they were never scored by the
Python version), run:

```bash
BIN=swift/ltx-video-director/.build/release/ltx-video
for clip in <path-to-each-known-verdict-clip>.mp4; do
  echo "=== $clip ==="
  "$BIN" lipsync-metrics "$clip" --json
done
```

Compare each Swift `verdict` against the corresponding `*_metrics.json`'s
`verdict` field.

- [ ] **Step 3: Evaluate against the acceptance bar**

Acceptance: verdict agreement on at least 10/12 of the v4 clips specifically
(the v5 clips are a bonus check, not the acceptance gate — the v4 set is
what the design doc's Component 3 named as the calibration baseline).

If below that bar: do not ship silently. Inspect the disagreements — likely
candidates are the flat-mouth-spurious-r case or the lag-boundary case
(both threshold-sensitive under Vision's different landmark scale). Adjust
`LipsyncMetrics.minMouthStdThreshold` specifically (documented in Task 2's
code comment as the constant most likely to need retuning) — do NOT touch
`adequateRThreshold`, which is a correlation coefficient and should already
be scale-invariant. If a threshold is changed, update the code comment
above it in `LipsyncMetrics.swift` explaining the new value and why (do not
carry the Python constant forward silently once it's been changed).

- [ ] **Step 4: Write up the comparison table**

Include the per-clip Swift-vs-Python verdict comparison table in this task's
completion notes / the eventual PR description — not a new repo file.

---

## Task 6: Wire `evaluate-lipsync` to the Swift binary

**Files:**
- Modify: `bun-apps/pi-agent-ext-ltx/src/index.ts:36`
- Rename: `bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.ts` →
  `bun-apps/pi-agent-ext-movie-director/src/lipsync_metrics.ts`
- Rename: `bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.test.ts` →
  `bun-apps/pi-agent-ext-movie-director/src/lipsync_metrics.test.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/dispatch.ts:51`

- [ ] **Step 1: Export `ensureBinary` from pi-agent-ext-ltx**

In `bun-apps/pi-agent-ext-ltx/src/index.ts`, change line 36 from:

```ts
export { resolveRepoRoot, defaultBinaryPath } from "./binary.ts";
```

to:

```ts
export { resolveRepoRoot, defaultBinaryPath, ensureBinary } from "./binary.ts";
```

- [ ] **Step 2: Verify the export compiles**

Run: `( cd bun-apps/pi-agent-ext-ltx && bun run typecheck )`
Expected: no new errors.

- [ ] **Step 3: Rewrite the adapter module**

Delete `bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.ts`, create
`bun-apps/pi-agent-ext-movie-director/src/lipsync_metrics.ts`:

```ts
/**
 * lipsync_metrics.ts — the `ltx-video lipsync-metrics` adapter (mouth-motion
 * vs. audio-loudness correlation for a talking-head video).
 *
 * Pure Swift (Vision + AVFoundation), no Python — see
 * swift/ltx-video-director/Sources/LTXVideoDirector/LipsyncMetrics.swift and
 * docs/superpowers/specs/2026-07-25-swift-lipsync-metrics-design.md. This
 * module replaces the prior `python -m app.lipsync_metrics` adapter
 * (formerly runpy_lipsync.ts) — same interface, different binary.
 *
 * Unlike runpy_tts's best-effort posture (which protects an already-succeeded
 * generation), evaluation IS the point here — callers get a real {ok, error}
 * on any failure, nothing is swallowed at this layer.
 *
 * This module returns a flat `{ok, metrics, error, stderrTail}` instead of the
 * sibling `{details, summary, stderrTail}` shape because there's no multi-field
 * "details" worth summarizing — `metrics` IS the whole payload, and `error`
 * already carries the exit code inline for the (rare) transport-failure case.
 */
import { ensureBinary } from "@repo/pi-agent-ext-ltx";

export interface LipsyncMetrics {
  verdict: string;
  pearson_r?: number | null;
  mouth_ratio_std?: number | null;
  caveat?: string;
  /** Human-readable reason, present on no_face/no_audio verdicts (and sometimes others). */
  note?: string;
}

export interface RunPyLipsyncInput {
  videoPath: string;
  signal?: AbortSignal;
  /**
   * Test seam: inject a canned spawn result so unit tests can drive
   * runPyLipsync without a built ltx-video binary. The real path resolves
   * (building if needed) the ltx-video Swift binary and spawns
   * `ltx-video lipsync-metrics <videoPath> --json`.
   */
  _spawnImpl?: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface RunPyLipsyncOutput {
  ok: boolean;
  metrics: LipsyncMetrics | null;
  error: string | null;
  stderrTail: string;
}

/** Build the argv for `ltx-video lipsync-metrics <videoPath> --json`. */
export function buildLipsyncArgs(videoPath: string): string[] {
  return ["lipsync-metrics", videoPath, "--json"];
}

async function defaultSpawn(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const bin = await ensureBinary();
  const proc = Bun.spawn({
    cmd: [bin, ...args],
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

/** Run `ltx-video lipsync-metrics <videoPath> --json` and parse its JSON stdout. */
export async function runPyLipsync(input: RunPyLipsyncInput): Promise<RunPyLipsyncOutput> {
  const args = buildLipsyncArgs(input.videoPath);
  const spawnFn = input._spawnImpl ?? ((a: string[]) => defaultSpawn(a, input.signal));

  let res: { stdout: string; stderr: string; exitCode: number };
  try {
    res = await spawnFn(args);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, metrics: null, error: `lipsync-metrics spawn failed: ${msg}`, stderrTail: "" };
  }

  const stderrTail = res.stderr.slice(-2000);
  if (res.exitCode !== 0) {
    return { ok: false, metrics: null, error: `lipsync-metrics exited ${res.exitCode}`, stderrTail };
  }

  try {
    const metrics = JSON.parse(res.stdout) as LipsyncMetrics;
    return { ok: true, metrics, error: null, stderrTail };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, metrics: null, error: `lipsync-metrics produced non-JSON stdout: ${msg}`, stderrTail };
  }
}
```

Function/type names (`runPyLipsync`, `RunPyLipsyncInput`, `RunPyLipsyncOutput`)
are kept as-is — only the module is renamed. Renaming every symbol too is a
larger, separate cross-cutting rename, out of scope here.

- [ ] **Step 4: Update the test file**

Delete `runpy_lipsync.test.ts`, create `lipsync_metrics.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { buildLipsyncArgs, runPyLipsync } from "./lipsync_metrics.ts";

describe("buildLipsyncArgs", () => {
  it("builds the exact ltx-video lipsync-metrics argv", () => {
    expect(buildLipsyncArgs("/fake/shot.mp4")).toEqual(["lipsync-metrics", "/fake/shot.mp4", "--json"]);
  });
});

describe("runPyLipsync — spawn injection (no built binary needed)", () => {
  it("ok=true with parsed metrics on exit 0 + valid JSON stdout", async () => {
    let capturedArgs: string[] = [];
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async (args) => {
        capturedArgs = args;
        return {
          stdout: JSON.stringify({
            verdict: "adequate",
            pearson_r: 0.55,
            mouth_ratio_std: 0.05,
          }),
          stderr: "",
          exitCode: 0,
        };
      },
    });
    expect(capturedArgs).toEqual(["lipsync-metrics", "/fake/shot.mp4", "--json"]);
    expect(result.ok).toBe(true);
    expect(result.metrics?.verdict).toBe("adequate");
    expect(result.metrics?.pearson_r).toBe(0.55);
    expect(result.metrics?.mouth_ratio_std).toBe(0.05);
    expect(result.error).toBeNull();
  });

  it("ok=true and preserves an optional caveat field", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({
        stdout: JSON.stringify({
          verdict: "inadequate",
          pearson_r: -0.35,
          mouth_ratio_std: 0.018,
          caveat: "pearson_r is strongly negative — anti-phase, not genuine lip-sync.",
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.metrics?.caveat).toContain("anti-phase");
  });

  it("ok=true when verdict is no_face/no_audio with pearson_r/mouth_ratio_std absent (not null)", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({
        stdout: JSON.stringify({
          verdict: "no_face",
          note: "No face detected in any sampled frame.",
          n_frames: 73,
          n_detected: 0,
        }),
        stderr: "",
        exitCode: 0,
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.metrics?.verdict).toBe("no_face");
    expect(result.metrics?.note).toContain("No face detected");
    expect(result.metrics?.pearson_r).toBeUndefined();
    expect(result.metrics?.mouth_ratio_std).toBeUndefined();
  });

  it("ok=false on non-zero exit code", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({ stdout: "", stderr: "Fatal error...", exitCode: 1 }),
    });
    expect(result.ok).toBe(false);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("exited 1");
    expect(result.stderrTail).toContain("Fatal error");
  });

  it("ok=false on malformed JSON stdout", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => ({ stdout: "not json", stderr: "", exitCode: 0 }),
    });
    expect(result.ok).toBe(false);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("non-JSON");
  });

  it("ok=false when the spawn itself throws", async () => {
    const result = await runPyLipsync({
      videoPath: "/fake/shot.mp4",
      _spawnImpl: async () => {
        throw new Error("ENOENT: ltx-video not found");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.metrics).toBeNull();
    expect(result.error).toContain("ENOENT");
  });
});
```

- [ ] **Step 5: Update dispatch.ts's import**

In `bun-apps/pi-agent-ext-movie-director/src/dispatch.ts`, change line 51 from:

```ts
import { runPyLipsync, type RunPyLipsyncInput, type RunPyLipsyncOutput } from "./runpy_lipsync.ts";
```

to:

```ts
import { runPyLipsync, type RunPyLipsyncInput, type RunPyLipsyncOutput } from "./lipsync_metrics.ts";
```

(Line 361's `runPyLipsyncImpl?: (input: RunPyLipsyncInput) => Promise<RunPyLipsyncOutput>;`
needs no change — the imported type names are unchanged.)

- [ ] **Step 6: Run the full test suite**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: all tests pass, including the renamed `lipsync_metrics.test.ts`
and the existing `evaluate-lipsync` tests in `commands.test.ts` (those use
`deps.runPyLipsyncImpl` injection and are unaffected by this rename).

- [ ] **Step 7: End-to-end smoke test with the real binary**

```bash
export MLX_VENV_PYTHON=/Users/huangziyu/proj/video_generation__venv/bin/python  # unrelated to this change, but this session's shell needs it for other movie-director commands
bun bun-apps/pi-agent-ext-movie-director/src/cli.ts evaluate-lipsync \
  --videoPath <path-to-a-real-shot.mp4> --seed 501 --identityRef dov --voice am_onyx --json
```

Expected: same `{metrics, lesson}` JSON shape as before, now computed by the
Swift binary — confirm `ensureBinary()` built `ltx-video` if it wasn't
already (first run may print build progress to stderr).

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-ltx/src/index.ts bun-apps/pi-agent-ext-movie-director/src/lipsync_metrics.ts bun-apps/pi-agent-ext-movie-director/src/lipsync_metrics.test.ts bun-apps/pi-agent-ext-movie-director/src/dispatch.ts
git rm bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.ts bun-apps/pi-agent-ext-movie-director/src/runpy_lipsync.test.ts
git commit -m "feat(pi-agent-ext-movie-director): evaluate-lipsync calls the Swift lipsync-metrics binary, drops Python"
```
