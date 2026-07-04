//
//  NativeRelayStage.swift
//  LTXVideoDirector
//
//  `ltx-video native-relay` — native (no run.py, no ffmpeg) port of the
//  CORE chaining mechanism in app/commands/video-relay.py's Prompt-Relay
//  pattern: generate segment 1 (I2V from --first-image if given, else T2V
//  via NativeI2VStage's default T2I-then-I2V), extract its LAST decoded
//  frame, feed that forward as the next segment's frame-0 conditioning
//  image (NativeI2VStage.Request.inputImagePath — see that type's header),
//  repeat, then concatenate all segments into one final video
//  (VideoConcatenator, AVFoundation composition — no ffmpeg).
//
//  Deliberately narrower than the Python version for this first cut (see
//  PLAN.md's matching milestone for the full remaining-work writeup):
//    - no custom audio track overlay/replace on the final concatenated
//      output (WAVReader/AudioVAEEncoder exist for GENERATION-time audio
//      conditioning, not for post-hoc mixing onto an already-muxed clip)
//    - no TTS narration, no variant A/B comparison harness
//    - each segment always runs at the SAME resolution (the "last frame of
//      segment N becomes segment N+1's frame 0" invariant requires it,
//      since inputImagePath needs an exact width/height match)
//

import Foundation

public struct NativeRelayStage {
    public enum StageError: Error, CustomStringConvertible {
        case noSegments
        case firstImageNotFound(URL)

        public var description: String {
            switch self {
            case .noSegments: return "NativeRelayStage: at least one segment prompt is required"
            case .firstImageNotFound(let url): return "--relay-first-image not found at \(url.path)"
            }
        }
    }

    public struct Request {
        /// One prompt per segment — segment count is `prompts.count`.
        public var prompts: [String]
        /// Optional reference image for segment 1 (I2V). When nil, segment
        /// 1 behaves like plain native-i2v with no --input-image: frame 0
        /// is T2I-generated from `prompts[0]` (this package's closest
        /// equivalent to the Python version's "T2V" mode — NativeI2VStage
        /// has no true from-scratch T2V path with zero frame-0
        /// conditioning; see NativeI2VStage.swift's header).
        public var firstImagePath: URL?
        public var seconds: Double
        public var fps: Double
        public var width: Int
        public var height: Int
        public var seed: UInt64
        public var t2iTransformer: String
        public var textMaxLength: Int
        public var loraPaths: [(path: URL, strength: Float)]

        public init(
            prompts: [String], firstImagePath: URL? = nil, seconds: Double = 2.0, fps: Double = 24.0,
            width: Int = 640, height: Int = 960, seed: UInt64 = 42,
            t2iTransformer: String = "moody-pro-mix", textMaxLength: Int = 128,
            loraPaths: [(path: URL, strength: Float)] = []
        ) {
            self.prompts = prompts
            self.firstImagePath = firstImagePath
            self.seconds = seconds
            self.fps = fps
            self.width = width
            self.height = height
            self.seed = seed
            self.t2iTransformer = t2iTransformer
            self.textMaxLength = textMaxLength
            self.loraPaths = loraPaths
        }
    }

    public struct Result {
        public let segmentResults: [NativeI2VStage.Result]
        public let segmentVideoURLs: [URL]
        public let finalVideoURL: URL
    }

    public init() {}

    public func generate(_ request: Request, outputDir: URL) throws -> Result {
        guard !request.prompts.isEmpty else { throw StageError.noSegments }
        if let firstImagePath = request.firstImagePath {
            guard FileManager.default.fileExists(atPath: firstImagePath.path) else {
                throw StageError.firstImageNotFound(firstImagePath)
            }
        }

        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        let stage = NativeI2VStage()
        var segmentResults: [NativeI2VStage.Result] = []
        var segmentVideoURLs: [URL] = []
        var nextInputImage: URL? = request.firstImagePath

        for (index, prompt) in request.prompts.enumerated() {
            let segNum = index + 1
            print("[relay] ═══ Segment \(segNum)/\(request.prompts.count) ═══")
            let segDir = outputDir.appendingPathComponent("seg\(String(format: "%02d", segNum))")

            var segRequest = NativeI2VStage.Request(
                prompt: prompt, seconds: request.seconds, fps: request.fps,
                width: request.width, height: request.height,
                seed: request.seed &+ UInt64(index),
                t2iTransformer: request.t2iTransformer, textMaxLength: request.textMaxLength,
                loraPaths: request.loraPaths)
            segRequest.inputImagePath = nextInputImage

            let result = try stage.generate(segRequest, outputDir: segDir)
            segmentResults.append(result)

            let lastFrameURL = result.frameDirectory.appendingPathComponent(
                String(format: "frame_%04d.png", result.frameCount - 1))
            print("[relay] segment \(segNum) last frame: \(lastFrameURL.lastPathComponent) — feeding forward as segment \(segNum + 1)'s --input-image")
            nextInputImage = lastFrameURL

            let segMP4 = segDir.appendingPathComponent("segment.mp4")
            try MP4Writer.write(frameDirectory: result.frameDirectory, audioURL: result.audioURL, fps: request.fps, to: segMP4)
            segmentVideoURLs.append(segMP4)
        }

        let finalURL = outputDir.appendingPathComponent("relay.mp4")
        print("[relay] concatenating \(segmentVideoURLs.count) segment(s) -> \(finalURL.lastPathComponent)")
        try VideoConcatenator.concatenate(segmentVideoURLs, to: finalURL)

        return Result(segmentResults: segmentResults, segmentVideoURLs: segmentVideoURLs, finalVideoURL: finalURL)
    }
}
