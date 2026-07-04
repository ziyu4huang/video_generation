//
//  VideoSceneDetector.swift
//  LTXVideoDirector
//
//  Native port of `run.py video segment`'s scene-cut detection
//  (app/video_utils.py's `detect_scenes`/`scenes_to_timestamps`): decode
//  each frame, compute an HSV hue histogram (32 bins over [0,180), matching
//  OpenCV's 8-bit hue storage), compare consecutive frames via Pearson
//  correlation, and flag a scene cut when correlation drops below
//  `threshold` — merging cuts closer than `minSceneFrames` into the
//  previous scene, exactly like the Python implementation. No VLM scoring
//  (Python's optional `--segment-vlm` flag) — that's a separate HTTP call
//  to LM Studio, not part of this CV algorithm.
//
//  cv2.calcHist + cv2.normalize(..., NORM_MINMAX) followed by
//  cv2.compareHist(..., HISTCMP_CORREL) is mathematically identical to
//  Pearson correlation on the RAW (unnormalized) histogram counts — Pearson
//  correlation is invariant to any per-array positive affine rescaling, and
//  NORM_MINMAX is exactly that. So this port skips the normalize step
//  entirely and computes the correlation directly on raw bin counts.
//

import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

public struct SceneRange: Equatable {
    public let sceneNum: Int
    public let startFrame: Int
    public let endFrame: Int
    public let frames: Int
    public let startSec: Double
    public let endSec: Double
    public let durationSec: Double
}

public enum VideoSceneDetector {
    /// Detects scene boundaries. Returns (start, end) frame-index ranges,
    /// one per detected scene — same shape as Python's `detect_scenes`.
    public static func detectScenes(url: URL, threshold: Double = 0.4, minSceneFrames: Int = 8) throws -> [(start: Int, end: Int)] {
        let asset = AVURLAsset(url: url)
        guard let track = asset.tracks(withMediaType: .video).first else {
            throw VideoProbeError.noVideoTrack(url)
        }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else {
            throw VideoProbeError.readerFailedToStart(url)
        }

        var sceneStarts = [0]
        var prevHist: [Double]?
        var frameIdx = 0

        while let sampleBuffer = output.copyNextSampleBuffer() {
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { continue }
            let hist = hueHistogram(pixelBuffer: pixelBuffer)
            if let prev = prevHist {
                let corr = pearsonCorrelation(prev, hist)
                if corr < threshold {
                    let framesSinceLast = frameIdx - sceneStarts[sceneStarts.count - 1]
                    if framesSinceLast >= minSceneFrames {
                        sceneStarts.append(frameIdx)
                        prevHist = hist
                        frameIdx += 1
                        continue
                    }
                }
            }
            prevHist = hist
            frameIdx += 1
        }

        let totalFrames = frameIdx
        if totalFrames <= 1 { return [(0, max(0, totalFrames - 1))] }
        // scene_starts stays [0] iff no cut ever passed both gates above —
        // mirrors Python's `if not scene_starts or scene_starts[-1] == 0`.
        if sceneStarts.count <= 1 { return [(0, totalFrames - 1)] }

        var scenes: [(start: Int, end: Int)] = []
        for i in 0..<sceneStarts.count {
            let start = sceneStarts[i]
            let end = (i + 1 < sceneStarts.count) ? sceneStarts[i + 1] - 1 : totalFrames - 1
            scenes.append((start, end))
        }
        return scenes
    }

    /// Converts frame-range scenes to display/JSON-ready timestamp structs.
    /// Rounds start/end/duration to 2 decimal places, same as Python's
    /// `round(x, 2)`.
    public static func scenesToTimestamps(_ scenes: [(start: Int, end: Int)], fps: Double) -> [SceneRange] {
        scenes.enumerated().map { i, range in
            let (s, e) = range
            func round2(_ v: Double) -> Double { (v * 100).rounded() / 100 }
            return SceneRange(
                sceneNum: i + 1, startFrame: s, endFrame: e, frames: e - s + 1,
                startSec: fps > 0 ? round2(Double(s) / fps) : 0,
                endSec: fps > 0 ? round2(Double(e) / fps) : 0,
                durationSec: fps > 0 ? round2(Double(e - s + 1) / fps) : 0
            )
        }
    }

    /// 32-bin histogram of hue (OpenCV's BGR2HSV 8-bit convention: hue in
    /// [0,180) rather than [0,360)), computed directly from a BGRA pixel
    /// buffer — no intermediate HSV image materialized, matching the
    /// aggregate cv2.calcHist([hsv],[0],None,[32],[0,180]) result.
    private static func hueHistogram(pixelBuffer: CVPixelBuffer) -> [Double] {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else {
            return [Double](repeating: 0, count: 32)
        }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let ptr = base.assumingMemoryBound(to: UInt8.self)

        var hist = [Double](repeating: 0, count: 32)
        let binWidth = 180.0 / 32.0
        for y in 0..<height {
            let rowBase = y * bytesPerRow
            for x in 0..<width {
                let p = rowBase + x * 4  // BGRA
                let b = Double(ptr[p])
                let g = Double(ptr[p + 1])
                let r = Double(ptr[p + 2])
                let maxV = max(r, g, b)
                let minV = min(r, g, b)
                let delta = maxV - minV

                var h: Double
                if delta == 0 {
                    h = 0
                } else if maxV == r {
                    h = 60 * (((g - b) / delta).truncatingRemainder(dividingBy: 6))
                } else if maxV == g {
                    h = 60 * ((b - r) / delta + 2)
                } else {
                    h = 60 * ((r - g) / delta + 4)
                }
                if h < 0 { h += 360 }
                let h8 = h / 2.0  // OpenCV 8-bit hue storage: [0,360) -> [0,180)

                var bin = Int(h8 / binWidth)
                if bin >= 32 { bin = 31 }
                if bin < 0 { bin = 0 }
                hist[bin] += 1
            }
        }
        return hist
    }

    /// Pearson correlation — equivalent to cv2.compareHist(..., HISTCMP_CORREL)
    /// on min-max-normalized histograms (see file header). Degenerate
    /// zero-variance case (both histograms constant, e.g. a single-hue
    /// frame) is treated as perfectly correlated (1.0) rather than NaN.
    private static func pearsonCorrelation(_ a: [Double], _ b: [Double]) -> Double {
        let n = Double(a.count)
        let meanA = a.reduce(0, +) / n
        let meanB = b.reduce(0, +) / n
        var num = 0.0, denA = 0.0, denB = 0.0
        for i in 0..<a.count {
            let da = a[i] - meanA
            let db = b[i] - meanB
            num += da * db
            denA += da * da
            denB += db * db
        }
        let den = (denA * denB).squareRoot()
        return den == 0 ? 1.0 : num / den
    }
}
