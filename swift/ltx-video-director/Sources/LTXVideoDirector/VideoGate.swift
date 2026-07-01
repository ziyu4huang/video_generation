//
//  VideoGate.swift
//  LTXVideoDirector
//
//  Basic (VLM-free) video/image/voice quality gateway. Combines:
//    - per-frame ImageGate (CommonImageDirector) on N sampled frames — catches
//      noise/blank/NaN generation failures, same as the image directors.
//    - sparse-sample SSIM (ImageGenUtils.ImageMetrics) — hard-cut/corruption
//      detection only (see motionMeanConsecutiveFrames for why sparse
//      SSIM/RMS-diff can't tell real motion from diffusion frame flicker).
//    - consecutive-frame motion_mean — the actual motion/frozen-frame check,
//      same metric+threshold as run.py's own signal-based quality gate.
//    - AudioProbe loudness/silence — catches missing or inaudible voice track.
//  This is the "basic gateway" layer; VLM keyframe verification (semantic
//  content/motion correctness) is a separate, heavier check — see VLMVerify.swift.
//

import CommonImageDirector
import Foundation
import ImageGenUtils

public struct VideoGateVerdict: Codable {
    public let status: String  // PASS / WARN / FAIL
    public let reasons: [String]
    public let duration: Double
    public let fps: Double
    public let width: Int
    public let height: Int
    public let frameCount: Int
    public let hasAudio: Bool
    public let meanDBFS: Double
    public let silenceRatio: Double
    public let minFrameSSIM: Double
    public let maxFrameSSIM: Double
    /// Mean absolute pixel diff between consecutive native frames (0-255
    /// scale) — same metric/threshold as run.py's `motion_mean`. nil if
    /// frame extraction failed.
    public let motionMean: Double?
    public let frameGateFails: Int
    public let frameGateWarns: Int
    public let sampledFrames: Int
}

public enum VideoGate {
    /// Number of frames sampled for the per-frame ImageGate + motion checks.
    public static let sampleCount = 8

    public static func evaluate(videoURL: URL, expectVoice: Bool = true) throws -> VideoGateVerdict {
        let info = try VideoProbe.info(url: videoURL)
        let samples = try VideoProbe.evenlySpacedFrames(url: videoURL, count: sampleCount)
        var reasons: [String] = []
        var status = "PASS"

        func escalate(_ s: String, _ reason: String) {
            reasons.append(reason)
            if s == "FAIL" { status = "FAIL" }
            else if s == "WARN" && status != "FAIL" { status = "WARN" }
        }

        if samples.isEmpty {
            escalate("FAIL", "could not extract any frames from the video")
        }

        // Per-frame degenerate-image check.
        var frameFails = 0
        var frameWarns = 0
        for (t, cgImage) in samples {
            let arr = FrameLoad.toArray(cgImage)
            let verdict = ImageGate.verdict(ImageGate.analyze(arr))
            if verdict.status == .fail {
                frameFails += 1
                escalate("FAIL", "frame@\(String(format: "%.2f", t))s: \(verdict.reason)")
            } else if verdict.status == .warn {
                frameWarns += 1
                escalate("WARN", "frame@\(String(format: "%.2f", t))s: \(verdict.reason)")
            }
        }

        // Sparse (1s+ apart) SSIM between the evenly-spaced samples — useful
        // only for detecting hard cuts/corruption (which move it a lot).
        // NOT useful for motion detection: measured empirically on a
        // confirmed-motion PASS clip vs a confirmed-static clip, sparse
        // SSIM/RMS-diff between far-apart samples was statistically
        // indistinguishable (0.9986-0.99999 SSIM on BOTH) because motion
        // between 1.25s-apart samples and diffusion frame-to-frame
        // flicker/noise accumulate into similar magnitudes. Real motion
        // detection needs adjacent-frame deltas (below).
        var ssims: [Float] = []
        if samples.count >= 2 {
            for i in 1..<samples.count {
                let (buf0, w0, h0) = FrameLoad.toGrayscaleBuffer(samples[i - 1].image)
                let (buf1, _, _) = FrameLoad.toGrayscaleBuffer(samples[i].image)
                let result = ImageMetrics.compute(buffer1: buf0, buffer2: buf1, width: w0, height: h0)
                ssims.append(result.ssim)
            }
        }
        let minSSIM = ssims.min() ?? 1.0
        let maxSSIM = ssims.max() ?? 1.0

        // Motion check: mean absolute pixel diff between CONSECUTIVE native
        // frames (0-255 scale) in two 1-second windows, mirroring run.py's
        // own `motion_mean` signal (video-t2i2v.py) — the SAME metric and
        // threshold (<0.5 = static) this repo already calibrated against
        // real LTX output (see docs/ltx-tuning.md history).
        // NOTE: this threshold only catches TRULY frozen output (near-zero
        // pixel change — e.g. a stalled/degenerate denoiser). Validated
        // against run.py's own signal for a clip its VLM separately flagged
        // "static image, no motion": motion_mean was 2.11 there (this
        // implementation independently measured 2.24 on the same file) —
        // both far above 0.5. Distinguishing "technically some pixel churn"
        // from "meaningful narrative motion" is a semantic judgment; that's
        // what VLMVerify.swift/`ltx-video verify` is for, not this gate.
        let motionMean = try motionMeanConsecutiveFrames(url: videoURL, info: info)
        if let motionMean, motionMean < 0.5 {
            escalate("WARN", "consecutive-frame motion too low (motion_mean=\(String(format: "%.3f", motionMean)), threshold 0.5) — likely frozen/static output")
        }

        if info.duration < 1.0 {
            escalate("FAIL", "video duration too short (\(String(format: "%.2f", info.duration))s)")
        }
        if info.width < 64 || info.height < 64 {
            escalate("FAIL", "resolution too small (\(info.width)x\(info.height))")
        }

        // Voice/audio gate.
        let audio = AudioProbe.analyze(url: videoURL)
        if expectVoice && !audio.hasTrack {
            escalate("FAIL", "no audio track present")
        } else if audio.hasTrack {
            if audio.silenceRatio > 0.9 {
                escalate("FAIL", "audio track is near-silent (silence_ratio=\(String(format: "%.2f", audio.silenceRatio)))")
            } else if audio.silenceRatio > 0.6 {
                escalate("WARN", "audio track is mostly silent (silence_ratio=\(String(format: "%.2f", audio.silenceRatio)))")
            }
            if audio.meanDBFS < -45 && audio.silenceRatio <= 0.6 {
                escalate("WARN", "audio is very quiet (mean=\(String(format: "%.1f", audio.meanDBFS)) dBFS)")
            }
        }

        if reasons.isEmpty {
            reasons.append("ok")
        }

        return VideoGateVerdict(
            status: status, reasons: reasons,
            duration: info.duration, fps: info.fps, width: info.width, height: info.height,
            frameCount: info.frameCount, hasAudio: audio.hasTrack,
            meanDBFS: audio.hasTrack ? audio.meanDBFS : -.infinity,
            silenceRatio: audio.silenceRatio,
            minFrameSSIM: Double(minSSIM), maxFrameSSIM: Double(maxSSIM),
            motionMean: motionMean,
            frameGateFails: frameFails, frameGateWarns: frameWarns,
            sampledFrames: samples.count
        )
    }

    /// Mean absolute pixel diff (0-255 scale) between consecutive native
    /// frames, sampled in two 1-second windows (25% and 70% through the
    /// clip) to keep decode cost bounded while still covering more than one
    /// moment. Mirrors run.py video-t2i2v.py's `motion_mean` signal exactly
    /// (same scale, same <0.5 static threshold) so the two are comparable.
    private static func motionMeanConsecutiveFrames(url: URL, info: VideoInfo) throws -> Double? {
        guard info.fps > 0, info.duration > 1.5 else { return nil }
        let windowFrameCount = min(24, Int(info.fps))
        let starts = [info.duration * 0.25, info.duration * 0.70]
        var diffs: [Double] = []
        for start in starts {
            let frames = try VideoProbe.consecutiveFrames(url: url, startTime: start, count: windowFrameCount, fps: info.fps)
            guard frames.count >= 2 else { continue }
            for i in 1..<frames.count {
                let (buf0, w, h) = FrameLoad.toGrayscaleBuffer(frames[i - 1])
                let (buf1, _, _) = FrameLoad.toGrayscaleBuffer(frames[i])
                var sum = 0.0
                for p in 0..<(w * h) {
                    sum += Double(abs(buf0[p] - buf1[p]))
                }
                diffs.append((sum / Double(w * h)) * 255.0)
            }
        }
        guard !diffs.isEmpty else { return nil }
        return diffs.reduce(0, +) / Double(diffs.count)
    }
}
