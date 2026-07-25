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

import AVFoundation
import Foundation
import Vision

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
    /// Positive lag means `b` is shifted forward relative to `a` (`b` lags
    /// `a`) — matches the pairing convention of Python's `_lagged_pearson`
    /// in python/mlx-movie-director/app/lipsync_metrics.py, which this
    /// function ports. For `lag >= 0`, `a[lag...]` is paired against
    /// `b[0..<(n - lag)]`; for `lag < 0`, `a[0..<(n + lag)]` is paired
    /// against `b[(-lag)...]`. NaNs are dropped pairwise per-lag; a lag
    /// with fewer than 4 valid pairs is skipped. Returns (0.0, 0) if fewer
    /// than 8 total samples.
    ///
    /// The search order is ascending, `-maxLag...maxLag`, matching Python's
    /// `_lagged_pearson` exactly — a candidate must *strictly* improve on
    /// the best |r| seen so far to replace it, so on a tie the first-seen
    /// (most-negative) lag wins. This is a deliberate behavioral match, not
    /// just a numeric one: on ties, this biases toward the most-negative
    /// lag rather than the smallest |lag|, and callers relying on
    /// Swift-vs-Python lag agreement depend on that exact order.
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

    /// r >= 0.3 (positive direction) is a conventional "weak-to-moderate but
    /// real" correlation floor — same value/rationale as the Python version's
    /// ADEQUATE_R_THRESHOLD. See Task 4 (validation against real clips) for
    /// whether this (and minMouthStdThreshold below) need retuning under
    /// Vision's landmark scale — ADEQUATE_R_THRESHOLD is a correlation
    /// coefficient and should be scale-invariant; minMouthStdThreshold is a
    /// raw ratio magnitude and is the one actually sensitive to
    /// landmark-scale differences from mediapipe.
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
    ///
    /// Scope: this decodes and holds EVERY frame of the clip in memory at
    /// once (via `VideoProbe.consecutiveFrames`) and runs a Vision face
    /// request per frame — fine for this repo's actual use case (short
    /// 2-5s talking-head dialogue shots, per the design doc), but would be
    /// a real memory/perf concern on long clips. Not a general-purpose
    /// long-video tool — don't reach for this on a 10-minute video without
    /// budgeting for the cost.
    ///
    /// Assumes `VideoProbe.consecutiveFrames` returns frames without gaps
    /// — it silently drops (does not pad) any frame it fails to decode, so
    /// a dropped mid-clip frame would shift every later position by one,
    /// desyncing the array-position-as-time-proxy this series is built on
    /// (the audio envelope gets resampled onto these same positions). In
    /// practice this is low-risk: the ±`maxLagFrames` lag search absorbs
    /// small timing skews like this, and dropped frames should be rare on
    /// clean mp4s — but it's not a guarantee of perfect frame-to-index
    /// correspondence.
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
    ///
    /// Divergence from Python: `measure_lipsync_precision` never raises —
    /// it always returns a verdict dict, even for a totally undecodable
    /// file. This port intentionally DOES throw for a genuinely unreadable
    /// file (via `VideoProbe.info`'s `VideoProbeError.noVideoTrack` etc.),
    /// matching how other commands in this package already handle this
    /// (e.g. `VideoGate.evaluate` also throws) — the CLI command layer
    /// lets ArgumentParser report the thrown error with a nonzero exit
    /// rather than this function synthesizing an error verdict itself.
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
}
