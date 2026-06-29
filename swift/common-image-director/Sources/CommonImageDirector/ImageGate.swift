//
//  ImageGate.swift
//  CommonImageDirector
//
//  Fast, VLM-free self-gated image reviewer. Catches "stupid" generation errors
//  (pure noise / TV static, all-black, all-white, flat/collapsed, dead channel,
//  NaN/Inf) using only basic pixel statistics. Shared by flux2-image-director and
//  z-image-director so every generation self-gates its output.
//
//  The single most discriminative metric is neighborDiff: the mean absolute delta
//  between adjacent pixels. Real photos are spatially correlated (neighborDiff
//  typically <~25 on the 0-255 scale); synthetic uniform noise is not (~85 = 255/3).
//  That alone separates the classic "model emitted noise" failure from a real image.
//
//  Operates on an MLXArray (1, 3, H, W) float32 in [0, 1] — the exact format both
//  pipelines produce in memory before savePNG. All reported metrics are on the
//  0-255 scale (multiply by 255 internally) so thresholds match the reference
//  Python implementation in (former) scripts/image_gate.py for parity checks.
//

import Accelerate
import Foundation
import MLX

/// Basic pixel statistics used to detect degenerate images.
public struct ImageGateMetrics: Codable, Equatable {
    public let width: Int
    public let height: Int
    /// Per-channel (R, G, B) mean on the 0-255 scale.
    public let perChannelMean: [Double]
    /// Per-channel std on the 0-255 scale.
    public let perChannelStd: [Double]
    /// Combined std over all pixels on the 0-255 scale.
    public let overallStd: Double
    /// Average per-channel Shannon entropy (bits, 0-8).
    public let entropyBits: Double
    /// Mean absolute adjacent-pixel difference on the 0-255 scale (the noise discriminator).
    public let neighborDiff: Double
    /// Fraction of pixels that are near-black (all channels <= 8).
    public let nearBlack: Double
    /// Fraction of pixels that are near-white (all channels >= 247).
    public let nearWhite: Double
    /// Fraction of clipped pixels (any channel exactly 0 or 255).
    public let satFrac: Double
    /// Fraction of unique colors in a capped sample (low => flat/collapsed).
    public let uniqueFrac: Double
    /// True iff no NaN/Inf pixels.
    public let finite: Bool

    /// JSON-friendly (numeric fields only).
    public var dictionary: [String: Double] {
        [
            "width": Double(width), "height": Double(height),
            "overall_std": overallStd, "entropy_bits": entropyBits,
            "neighbor_diff": neighborDiff, "near_black": nearBlack,
            "near_white": nearWhite, "sat_frac": satFrac,
            "unique_frac": uniqueFrac, "finite": finite ? 1 : 0,
        ]
    }
}

public enum GateStatus: String, Codable {
    case pass = "PASS"
    case warn = "WARN"
    case fail = "FAIL"
}

public struct ImageGateVerdict: Codable {
    public let status: GateStatus
    public let reason: String
    public let metrics: ImageGateMetrics
}

/// Error thrown by `ImageGate.check` when `strict` is set and the image FAILs.
public enum ImageGateError: Error, CustomStringConvertible {
    case failed(label: String, reason: String)
    public var description: String {
        switch self {
        case let .failed(label, reason): return "image gate FAIL [\(label)]: \(reason)"
        }
    }
}

public enum ImageGate {

    /// Analyze an MLXArray (1, 3, H, W) float32 [0, 1].
    public static func analyze(_ image: MLXArray) -> ImageGateMetrics {
        let dims = image.shape
        precondition(dims.count == 4 && dims[0] == 1 && dims[1] == 3,
                     "expected (1, 3, H, W), got \(dims)")
        let height = dims[2]
        let width = dims[3]
        let flat = image.reshaped([3, height, width]).asType(.float32)
        MLX.eval(flat)

        let channels: [[Float]] = (0..<3).map { flat[$0].asArray(Float.self) }

        // NaN/Inf check (single pass over all channels).
        var finite = true
        outer: for ch in channels {
            for v in ch where !v.isFinite { finite = false; break outer }
        }

        var means = [Double](repeating: 0, count: 3)
        var stds = [Double](repeating: 0, count: 3)
        var entropySum = 0.0
        var neighborSum = 0.0
        for i in 0..<3 {
            let scaled = channels[i].map { Double($0) * 255.0 }
            let m = vDSP.mean(scaled)
            let v = vDSP.sum(scaled.map { ($0 - m) * ($0 - m) }) / Double(scaled.count)
            means[i] = m
            stds[i] = sqrt(v)
            entropySum += entropyBits(scaled)
            neighborSum += neighborDiff(channel: scaled, width: width, height: height)
        }

        // Overall std over all 3 channels combined.
        let all = channels.flatMap { $0.map { Double($0) * 255.0 } }
        let allMean = vDSP.mean(all)
        let overallStd = sqrt(vDSP.sum(all.map { ($0 - allMean) * ($0 - allMean) }) / Double(all.count))

        // Fractions over all pixels (cross-channel conditions).
        let count = width * height
        var nearBlack = 0, nearWhite = 0, sat = 0
        for i in 0..<count {
            let r = channels[0][i] * 255.0, g = channels[1][i] * 255.0, b = channels[2][i] * 255.0
            if r <= 8 && g <= 8 && b <= 8 { nearBlack += 1 }
            if r >= 247 && g >= 247 && b >= 247 { nearWhite += 1 }
            if r <= 0 || r >= 255 || g <= 0 || g >= 255 || b <= 0 || b >= 255 { sat += 1 }
        }

        // Unique-color fraction on a capped sample.
        let uniqueFrac = uniqueColorFraction(channels: channels, count: count)

        return ImageGateMetrics(
            width: width, height: height,
            perChannelMean: means, perChannelStd: stds,
            overallStd: overallStd,
            entropyBits: entropySum / 3.0,
            neighborDiff: neighborSum / 3.0,
            nearBlack: Double(nearBlack) / Double(count),
            nearWhite: Double(nearWhite) / Double(count),
            satFrac: Double(sat) / Double(count),
            uniqueFrac: uniqueFrac,
            finite: finite
        )
    }

    /// Classify metrics into PASS / WARN / FAIL with a human reason.
    /// Thresholds ported from the reference Python gate (scripts/image_gate.py).
    public static func verdict(_ m: ImageGateMetrics) -> ImageGateVerdict {
        if !m.finite {
            return ImageGateVerdict(status: .fail, reason: "NaN/Inf pixels (non-finite)", metrics: m)
        }
        if m.nearBlack > 0.95 {
            return ImageGateVerdict(status: .fail, reason: "near-blank black (near_black=\(fmt(m.nearBlack)))", metrics: m)
        }
        if m.nearWhite > 0.95 {
            return ImageGateVerdict(status: .fail, reason: "near-blank white (near_white=\(fmt(m.nearWhite)))", metrics: m)
        }
        // Strongest signal: spatial decorrelation = synthetic noise / TV static.
        if m.neighborDiff > 55 && m.entropyBits > 7.5 {
            return ImageGateVerdict(
                status: .fail,
                reason: "likely synthetic noise/static (neighbor_diff=\(Int(m.neighborDiff.rounded())), entropy=\(fmt(m.entropyBits)))",
                metrics: m)
        }
        if m.overallStd < 5 || m.uniqueFrac < 0.002 {
            return ImageGateVerdict(status: .fail, reason: "flat / collapsed (overall_std=\(fmt(m.overallStd)), unique_frac=\(fmt(m.uniqueFrac)))", metrics: m)
        }
        // Warnings (degraded, not fatal).
        let dead = zip(0..., m.perChannelStd).filter { $0.1 < 3 }.map { $0.0 }
        if !dead.isEmpty {
            return ImageGateVerdict(status: .warn, reason: "dead/low-variance channel(s) \(dead): std=\(m.perChannelStd.map { fmt($0) })", metrics: m)
        }
        if m.overallStd < 12 {
            return ImageGateVerdict(status: .warn, reason: "low contrast (overall_std=\(fmt(m.overallStd)))", metrics: m)
        }
        if m.satFrac > 0.5 {
            return ImageGateVerdict(status: .warn, reason: "heavy clipping/saturation (sat_frac=\(fmt(m.satFrac)))", metrics: m)
        }
        return ImageGateVerdict(status: .pass, reason: "ok", metrics: m)
    }

    /// In-process self-gate: analyze + verdict + print a one-line badge.
    /// When `strict` and status == .fail, throws `ImageGateError` so a caller can
    /// abort the pipeline (e.g. `--strict-gate`).
    @discardableResult
    public static func check(_ image: MLXArray, label: String, strict: Bool) throws -> ImageGateVerdict {
        let v = verdict(analyze(image))
        let icon = v.status == .pass ? "✅" : v.status == .warn ? "⚠️ " : "❌"
        print("  \(icon) gate[\(label)] \(v.status.rawValue) — \(v.reason)  [nbr=\(fmt(v.metrics.neighborDiff)) ent=\(fmt(v.metrics.entropyBits)) std=\(fmt(v.metrics.overallStd))]")
        if strict && v.status == .fail {
            throw ImageGateError.failed(label: label, reason: v.reason)
        }
        return v
    }

    // MARK: - internals

    /// Shannon entropy (bits) of a 0-255 channel.
    private static func entropyBits(_ channel: [Double]) -> Double {
        var hist = [Int](repeating: 0, count: 256)
        for v in channel {
            var b = Int(v.rounded())
            if b < 0 { b = 0 } else if b > 255 { b = 255 }
            hist[b] += 1
        }
        let n = Double(channel.count)
        var ent = 0.0
        for h in hist where h > 0 {
            let p = Double(h) / n
            ent -= p * log2(p)
        }
        return ent
    }

    /// Mean absolute adjacent-pixel difference (vertical + horizontal) for one
    /// 0-255 channel laid out row-major [height][width].
    private static func neighborDiff(channel: [Double], width: Int, height: Int) -> Double {
        var sum = 0.0
        var n = 0
        // vertical neighbors
        for y in 0..<(height - 1) {
            let r0 = y * width, r1 = (y + 1) * width
            for x in 0..<width {
                sum += abs(channel[r0 + x] - channel[r1 + x]); n += 1
            }
        }
        // horizontal neighbors
        for y in 0..<height {
            let r = y * width
            for x in 0..<(width - 1) {
                sum += abs(channel[r + x] - channel[r + x + 1]); n += 1
            }
        }
        return n > 0 ? sum / Double(n) : 0
    }

    /// Fraction of unique (R,G,B) colors in a capped sample (<=200k pixels).
    private static func uniqueColorFraction(channels: [[Float]], count: Int) -> Double {
        let step = max(1, count / 200_000)
        var seen = Set<UInt32>()
        var total = 0
        var i = 0
        while i < count {
            let r = UInt8(min(255, max(0, channels[0][i] * 255)))
            let g = UInt8(min(255, max(0, channels[1][i] * 255)))
            let b = UInt8(min(255, max(0, channels[2][i] * 255)))
            seen.insert((UInt32(r) << 16) | (UInt32(g) << 8) | UInt32(b))
            total += 1
            i += step
        }
        return total > 0 ? Double(seen.count) / Double(total) : 0
    }

    private static func fmt(_ d: Double) -> String {
        String(format: "%.2f", d)
    }
}
