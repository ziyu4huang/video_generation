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
    /// For `lag >= 0`, `a[i]` is paired with `b[i + lag]` — a positive lag
    /// tests whether `b`, delayed by `lag` samples relative to `a`, best
    /// explains `a`'s trajectory. NaNs are dropped pairwise per-lag; a lag
    /// with fewer than 4 valid pairs is skipped. Returns (0.0, 0) if fewer
    /// than 8 total samples.
    ///
    /// The search order starts at lag 0 and expands outward
    /// (0, 1, -1, 2, -2, ...), and a candidate must *strictly* improve on
    /// the best |r| seen so far to replace it. This matters because two
    /// equal-length windows of a perfectly linear signal are perfectly
    /// correlated (r == 1.0, exactly, regardless of where the windows are
    /// taken from) — real mouth-ratio/audio-RMS series are never that
    /// clean, but degenerate ties are still possible on quiet/near-static
    /// stretches, and biasing ties toward the smallest |lag| picks the
    /// simplest explanation instead of an arbitrary later candidate.
    public static func laggedPearson(_ a: [Double], _ b: [Double], maxLag: Int) -> (r: Double, lag: Int) {
        let n = min(a.count, b.count)
        guard n >= 8 else { return (0.0, 0) }
        let a = Array(a.prefix(n))
        let b = Array(b.prefix(n))
        var lagOrder: [Int] = [0]
        if maxLag > 0 {
            for d in 1...maxLag {
                lagOrder.append(d)
                lagOrder.append(-d)
            }
        }
        var bestR = 0.0
        var bestLag = 0
        for lag in lagOrder {
            let aSeg: [Double]
            let bSeg: [Double]
            if lag >= 0 {
                guard lag < n else { continue }
                aSeg = Array(a[0..<(n - lag)])
                bSeg = Array(b[lag...])
            } else {
                guard -lag < n else { continue }
                aSeg = Array(a[(-lag)...])
                bSeg = Array(b[0..<(n + lag)])
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
