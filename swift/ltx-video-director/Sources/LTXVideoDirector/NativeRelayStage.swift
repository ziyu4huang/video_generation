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
//    - custom audio track overlay landed (Request.audioOverlayPath /
//      VideoConcatenator.replaceAudioTrack), but only the Python version's
//      default "replace" mode — "mix" (blend model + custom audio) and
//      "keep" (explicit no-op) aren't ported
//    - no TTS narration, no variant A/B comparison harness
//    - each segment always runs at the SAME resolution (the "last frame of
//      segment N becomes segment N+1's frame 0" invariant requires it,
//      since inputImagePath needs an exact width/height match)
//

import CoreGraphics
import Foundation

public struct NativeRelayStage {
    public enum StageError: Error, CustomStringConvertible {
        case noSegments
        case firstImageNotFound(URL)
        case audioOverlayNotFound(URL)
        case segmentGridPanelsCountMismatch(panels: Int, segments: Int)
        case segmentGridPanelsRequireGridImage
        case segmentGridImageNotFound(URL)
        case invalidSegmentGridPanel(segment: Int, panel: Int, panelCount: Int)
        case secondsPerSegmentCountMismatch(count: Int, segments: Int)
        case segmentContinuityCountMismatch(count: Int, segments: Int)

        public var description: String {
            switch self {
            case .noSegments: return "NativeRelayStage: at least one segment prompt is required"
            case .firstImageNotFound(let url): return "--relay-first-image not found at \(url.path)"
            case .audioOverlayNotFound(let url): return "--relay-audio not found at \(url.path)"
            case .segmentGridPanelsCountMismatch(let panels, let segments):
                return "NativeRelayStage: segmentGridPanels has \(panels) entries, expected \(segments) (one per segment/prompt)"
            case .segmentGridPanelsRequireGridImage:
                return "NativeRelayStage: segmentGridPanels requires gridImagePath to also be set"
            case .segmentGridImageNotFound(let url):
                return "NativeRelayStage: grid image not found at \(url.path)"
            case .invalidSegmentGridPanel(let segment, let panel, let panelCount):
                return "NativeRelayStage: segmentGridPanels[\(segment)]=\(panel) out of range [0, \(panelCount)) for gridColumns*gridRows"
            case .secondsPerSegmentCountMismatch(let count, let segments):
                return "NativeRelayStage: secondsPerSegment has \(count) entries, expected \(segments) (one per segment/prompt)"
            case .segmentContinuityCountMismatch(let count, let segments):
                return "NativeRelayStage: segmentContinuity has \(count) entries, expected \(segments) (one per segment/prompt)"
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
        /// Custom audio track that REPLACES the final concatenated video's
        /// audio entirely (mirrors the Python version's default
        /// `--relay-audio-mode replace`; `mix`/`keep` aren't ported — see
        /// this file's header). Any AVFoundation-decodable format (WAV,
        /// MP3, M4A, AAC — no ffmpeg dependency). Trimmed to the final
        /// video's duration if longer; only the covered span is replaced
        /// if shorter.
        public var audioOverlayPath: URL?

        /// Per-segment duration override (seconds), one entry per `prompts.count`
        /// when given — overrides `seconds` for that segment only. Omitted (nil)
        /// -> every segment uses the uniform `seconds` (unchanged default).
        public var secondsPerSegment: [Double]?

        /// Per-segment continuity override, one entry per `prompts.count` when
        /// given. `false` at index i means segment i ignores `nextInputImage`
        /// and generates fresh via T2I from `prompts[i]` (a hard cut) — exactly
        /// like segment 0's default behavior. Omitted (nil) -> every non-first
        /// segment continues from the previous segment's last frame (unchanged
        /// default); segment 0 never continues regardless of this array.
        public var segmentContinuity: [Bool]?

        /// Grid guide (see NativeI2VStage.Request.gridImagePath's header):
        /// applied IDENTICALLY to every segment, same as loraPaths — there
        /// is one grid-guide config per relay run, not one per segment.
        /// Ignored when `gridFrameIndices` is empty.
        public var gridImagePath: URL?
        public var gridColumns: Int = 2
        public var gridRows: Int = 2
        public var gridFrameIndices: [Int] = []
        public var gridStrengths: [Float] = []

        /// Per-segment single-panel override for a "hard-cut" storyboard
        /// (see StoryboardConfig.swift): when set, must have exactly
        /// `prompts.count` entries, each a row-major panel index into the
        /// SHARED `gridImagePath` grid. Segment `i` skips the default
        /// continuity chaining (previous segment's last decoded frame
        /// feeding this segment's frame 0) entirely — it generates fresh
        /// from its own `prompts[i]` via T2I, then pins panel
        /// `segmentGridPanels[i]` at that segment's OWN frame 0 (via the
        /// existing single-panel grid-guide mechanism —
        /// `NativeI2VStage.Request.gridImagePath`/gridColumns=1/gridRows=1/
        /// gridFrameIndices=[0]) at `segmentGridStrengths[i]` (default 1.0 =
        /// fully pinned; lower values blend the panel with the fresh T2I
        /// generation instead). Distinct from `gridFrameIndices` above,
        /// which applies the SAME whole-grid conditioning identically to
        /// every segment — this applies a DIFFERENT single panel per
        /// segment, which is what "each storyboard panel becomes its own
        /// shot" (a true hard cut) requires. When nil (default), behaves
        /// exactly as before.
        public var segmentGridPanels: [Int]?
        /// Per-segment strength paired with `segmentGridPanels`, same
        /// count when both are set. Missing entries (nil array, or this
        /// left empty) default to 1.0 for every segment.
        public var segmentGridStrengths: [Float]?

        public init(
            prompts: [String], firstImagePath: URL? = nil, seconds: Double = 2.0, fps: Double = 24.0,
            width: Int = 640, height: Int = 960, seed: UInt64 = 42,
            t2iTransformer: String = "moody-pro-mix", textMaxLength: Int = 128,
            loraPaths: [(path: URL, strength: Float)] = [],
            audioOverlayPath: URL? = nil
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
            self.audioOverlayPath = audioOverlayPath
        }
    }

    public struct Result {
        public let segmentResults: [NativeI2VStage.Result]
        public let segmentVideoURLs: [URL]
        public let finalVideoURL: URL
        /// Actual generated duration per segment (frameCount / fps) — NOT the
        /// requested value, since LTX's 8k+1 frame-stride alignment means
        /// requested and actual can differ.
        public let segmentDurations: [Double]
    }

    public init() {}

    public func generate(_ request: Request, outputDir: URL) throws -> Result {
        guard !request.prompts.isEmpty else { throw StageError.noSegments }
        if let firstImagePath = request.firstImagePath {
            guard FileManager.default.fileExists(atPath: firstImagePath.path) else {
                throw StageError.firstImageNotFound(firstImagePath)
            }
        }
        if let audioOverlayPath = request.audioOverlayPath {
            guard FileManager.default.fileExists(atPath: audioOverlayPath.path) else {
                throw StageError.audioOverlayNotFound(audioOverlayPath)
            }
        }
        if let segmentGridPanels = request.segmentGridPanels {
            guard segmentGridPanels.count == request.prompts.count else {
                throw StageError.segmentGridPanelsCountMismatch(panels: segmentGridPanels.count, segments: request.prompts.count)
            }
            guard let gridImagePath = request.gridImagePath else {
                throw StageError.segmentGridPanelsRequireGridImage
            }
            guard FileManager.default.fileExists(atPath: gridImagePath.path) else {
                throw StageError.segmentGridImageNotFound(gridImagePath)
            }
            let panelCount = request.gridColumns * request.gridRows
            for (i, panel) in segmentGridPanels.enumerated() {
                guard panel >= 0, panel < panelCount else {
                    throw StageError.invalidSegmentGridPanel(segment: i, panel: panel, panelCount: panelCount)
                }
            }
        }
        if let secondsPerSegment = request.secondsPerSegment {
            guard secondsPerSegment.count == request.prompts.count else {
                throw StageError.secondsPerSegmentCountMismatch(count: secondsPerSegment.count, segments: request.prompts.count)
            }
        }
        if let segmentContinuity = request.segmentContinuity {
            guard segmentContinuity.count == request.prompts.count else {
                throw StageError.segmentContinuityCountMismatch(count: segmentContinuity.count, segments: request.prompts.count)
            }
        }

        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        let stage = NativeI2VStage()
        var segmentResults: [NativeI2VStage.Result] = []
        var segmentVideoURLs: [URL] = []
        var segmentDurations: [Double] = []
        var nextInputImage: URL? = request.firstImagePath

        // Split the shared grid image once, up front, if any segment needs a
        // panel from it — avoids re-decoding the same PNG per segment.
        var gridPanels: [CGImage] = []
        if let segmentGridPanels = request.segmentGridPanels, !segmentGridPanels.isEmpty {
            guard let gridImagePath = request.gridImagePath,
                  let gridCGImage = FrameLoad.loadCGImage(from: gridImagePath) else {
                throw StageError.segmentGridImageNotFound(request.gridImagePath ?? URL(fileURLWithPath: ""))
            }
            gridPanels = FrameLoad.splitGrid(gridCGImage, columns: request.gridColumns, rows: request.gridRows)
        }

        for (index, prompt) in request.prompts.enumerated() {
            let segNum = index + 1
            print("[relay] ═══ Segment \(segNum)/\(request.prompts.count) ═══")
            let segDir = outputDir.appendingPathComponent("seg\(String(format: "%02d", segNum))")
            try FileManager.default.createDirectory(at: segDir, withIntermediateDirectories: true)

            let segSeconds = request.secondsPerSegment?[index] ?? request.seconds
            var segRequest = NativeI2VStage.Request(
                prompt: prompt, seconds: segSeconds, fps: request.fps,
                width: request.width, height: request.height,
                seed: request.seed &+ UInt64(index),
                t2iTransformer: request.t2iTransformer, textMaxLength: request.textMaxLength,
                loraPaths: request.loraPaths)

            if let segmentGridPanels = request.segmentGridPanels, index < segmentGridPanels.count {
                // Hard-cut storyboard segment: a NEW shot, not a continuation
                // — deliberately skip the continuity chain (`nextInputImage`)
                // so this segment's frame 0 is generated fresh from its own
                // `prompt`, then pinned to its own storyboard panel below.
                // Note: this branch takes silent precedence over
                // `segmentContinuity[index]` when both are set for the same
                // segment — the grid-panel hard-cut always wins.
                let panelIdx = segmentGridPanels[index]
                let panelPNG = segDir.appendingPathComponent("panel_source.png")
                FrameLoad.savePNG(gridPanels[panelIdx], to: panelPNG)
                let strength = request.segmentGridStrengths.flatMap { index < $0.count ? $0[index] : nil } ?? 1.0
                print("[relay] segment \(segNum) pinned to grid panel \(panelIdx) (strength \(strength)) — hard cut, no continuity from previous segment")
                segRequest.gridImagePath = panelPNG
                segRequest.gridColumns = 1
                segRequest.gridRows = 1
                segRequest.gridFrameIndices = [0]
                segRequest.gridStrengths = [strength]
            } else {
                // Segment 0 always resolves `nextInputImage` (== firstImagePath,
                // or nil if none given) regardless of segmentContinuity[0] — per
                // the doc comment's guarantee that "segment 0 never continues
                // regardless of this array"; only segments 1+ can opt out of
                // consuming the previous segment's forwarded last frame.
                let continueFromPrevious = index == 0 ? true : (request.segmentContinuity?[index] ?? true)
                segRequest.inputImagePath = continueFromPrevious ? nextInputImage : nil
                if !request.gridFrameIndices.isEmpty {
                    segRequest.gridImagePath = request.gridImagePath
                    segRequest.gridColumns = request.gridColumns
                    segRequest.gridRows = request.gridRows
                    segRequest.gridFrameIndices = request.gridFrameIndices
                    segRequest.gridStrengths = request.gridStrengths
                }
            }

            let result = try stage.generate(segRequest, outputDir: segDir)
            segmentResults.append(result)
            segmentDurations.append(Double(result.frameCount) / request.fps)

            let lastFrameURL = result.frameDirectory.appendingPathComponent(
                String(format: "frame_%04d.png", result.frameCount - 1))
            print("[relay] segment \(segNum) last frame: \(lastFrameURL.lastPathComponent) — feeding forward as segment \(segNum + 1)'s --input-image")
            nextInputImage = lastFrameURL

            let segMP4 = segDir.appendingPathComponent("segment.mp4")
            try MP4Writer.write(frameDirectory: result.frameDirectory, audioURL: result.audioURL, fps: request.fps, to: segMP4)
            segmentVideoURLs.append(segMP4)
        }

        let concatenatedURL = outputDir.appendingPathComponent(
            request.audioOverlayPath != nil ? "relay_concat.mp4" : "relay.mp4")
        print("[relay] concatenating \(segmentVideoURLs.count) segment(s) -> \(concatenatedURL.lastPathComponent)")
        try VideoConcatenator.concatenate(segmentVideoURLs, to: concatenatedURL)

        var finalURL = concatenatedURL
        if let audioOverlayPath = request.audioOverlayPath {
            let overlaidURL = outputDir.appendingPathComponent("relay.mp4")
            print("[relay] overlaying custom audio (replace): \(audioOverlayPath.lastPathComponent)")
            try VideoConcatenator.replaceAudioTrack(videoURL: concatenatedURL, audioURL: audioOverlayPath, to: overlaidURL)
            finalURL = overlaidURL
        }

        return Result(segmentResults: segmentResults, segmentVideoURLs: segmentVideoURLs, finalVideoURL: finalURL, segmentDurations: segmentDurations)
    }
}
