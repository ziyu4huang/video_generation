//
//  VideoGate.swift
//  LTXVideoDirector
//
//  Basic (VLM-free) video/image/voice quality gateway. Combines:
//    - per-frame ImageGate (CommonImageDirector) on N sampled frames — catches
//      noise/blank/NaN generation failures, same as the image directors.
//    - frame-to-frame SSIM (ImageGenUtils.ImageMetrics) — catches frozen/
//      duplicated-frame stalls (SSIM ~1.0 across the whole sample) as well as
//      catastrophic frame corruption (SSIM near 0 between adjacent samples).
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

        // Frame-to-frame SSIM: motion / frozen-frame / corruption check.
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
        if maxSSIM > 0.995 {
            escalate("WARN", "near-identical frames across the whole sample (max SSIM=\(String(format: "%.4f", maxSSIM))) — likely frozen/static output")
        }
        if minSSIM < 0.05 {
            escalate("WARN", "abrupt frame discontinuity detected (min SSIM=\(String(format: "%.4f", minSSIM))) — possible corruption or hard cut")
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
            frameGateFails: frameFails, frameGateWarns: frameWarns,
            sampledFrames: samples.count
        )
    }
}
