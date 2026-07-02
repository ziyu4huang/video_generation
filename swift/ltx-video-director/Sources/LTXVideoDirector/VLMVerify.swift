//
//  VLMVerify.swift
//  LTXVideoDirector
//
//  Semantic keyframe verification: extract keyframes -> LM Studio VLM
//  (ImageGenUtils.CaptionClient, same client z-image-director/flux2-image-
//  director use) -> per-frame score/review JSON. This is the "does the
//  content/motion actually match the prompt and look right" check that sits
//  above the basic (VLM-free) VideoGate.
//

import Foundation
import ImageGenUtils

public struct KeyframeVerdict {
    public let time: Double
    public let imagePath: URL
    public let score: CaptionScore?
    public let raw: String
}

public struct VLMVerifyResult {
    public let frames: [KeyframeVerdict]
    public var meanOverall: Double {
        let scores = frames.compactMap { $0.score?.overall }
        guard !scores.isEmpty else { return 0 }
        return Double(scores.reduce(0, +)) / Double(scores.count)
    }
    public var worstOverall: Double {
        Double(frames.compactMap { $0.score?.overall }.min() ?? 0)
    }
    public var allIssues: [String] {
        frames.flatMap { $0.score?.issues ?? [] }
    }
}

public enum VLMVerify {
    /// Extracts `count` evenly spaced keyframes to a temp dir, scores each
    /// with the VLM using the `review` style (checks prompt adherence +
    /// defects), and aggregates. `prompt` is the original generation prompt
    /// so `review` can check element-level adherence (subject/setting/pose).
    public static func verify(
        videoURL: URL, prompt: String, keyframeCount: Int = 4,
        style: String = "review",
        apiURL: String = CaptionClient.defaultAPIURL, model: String = CaptionClient.defaultModel
    ) throws -> VLMVerifyResult {
        let samples = try VideoProbe.evenlySpacedFrames(url: videoURL, count: keyframeCount)
        let workDir = FileManager.default.temporaryDirectory.appendingPathComponent(
            "ltx-video-verify-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: workDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: workDir) }

        var results: [KeyframeVerdict] = []
        for (i, sample) in samples.enumerated() {
            let framePath = workDir.appendingPathComponent("frame_\(i).png")
            guard FrameLoad.savePNG(sample.image, to: framePath) else { continue }
            let raw = (try? CaptionClient.caption(
                imageURL: framePath, style: style,
                prompt: style == "review" ? prompt : nil,
                apiURL: apiURL, model: model
            )) ?? ""
            let score = CaptionClient.parseScore(raw)
            results.append(KeyframeVerdict(time: sample.time, imagePath: framePath, score: score, raw: raw))
        }
        return VLMVerifyResult(frames: results)
    }
}
