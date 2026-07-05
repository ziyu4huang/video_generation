//
//  StoryboardConfig.swift
//  LTXVideoDirector
//
//  JSON-driven storyboard config: describes a multi-segment/multi-panel
//  storyboard (per-segment prompts, a shared NxN grid image, per-panel
//  frame index + strength, and a `transitionMode` switch) as ONE file
//  instead of a long run of individual `--grid-*`/`--prompts` CLI flags.
//  Consumed by `ltx-video native-storyboard` (NativeStoryboardCommand).
//
//  Design note — the two `transitionMode`s map onto this package's TWO
//  existing native stages rather than introducing a third:
//    - "camera-move": ONE continuous NativeI2VStage generation. Every grid
//      panel is pinned as a keyframe guide at its own `frameIndex` within
//      that single clip's timeline (NativeI2VStage.Request.gridFrameIndices/
//      gridStrengths, already supported) — reads as one shot with the
//      camera moving through the storyboard. Because a single generation
//      has exactly one text-conditioning pass (this pipeline has no
//      per-keyframe prompt mechanism — matches the underlying LTX-2.3
//      model's one-CLIPTextEncode-per-generation architecture, not a
//      limitation specific to this config format), every grid panel must
//      be covered by exactly one segment and segment `prompt`s are only
//      used as a fallback to build one combined description when no
//      top-level `prompt` is given.
//    - "hard-cut": NativeRelayStage, one discrete I2V generation per
//      segment, concatenated with a true cut (no cross-fade — the
//      existing default VideoConcatenator behavior). Each segment picks
//      ONE grid panel as its own reference image via the new
//      `NativeRelayStage.Request.segmentGridPanels`/`segmentGridStrengths`
//      fields (see that file) instead of the default continuity chaining
//      (previous segment's last decoded frame feeding the next segment's
//      frame 0) — a hard cut is a new shot, not a continuation.
//
//  Both modes reuse the SAME grid image + FrameLoad.splitGrid mechanism
//  already ported from the reference ComfyUI grid-guide node (see
//  NativeI2VStage.Request.gridImagePath's header) — this file only adds a
//  JSON front-end and the segment/panel bookkeeping to route into one
//  stage or the other.
//

import Foundation

public struct StoryboardConfig: Codable {
    public enum TransitionMode: String, Codable {
        case cameraMove = "camera-move"
        case hardCut = "hard-cut"
    }

    public struct GridSpec: Codable {
        /// Path to the NxN grid image, resolved relative to the config
        /// file's own directory (or absolute).
        public var image: String
        public var columns: Int
        public var rows: Int
    }

    public struct Segment: Codable {
        /// Row-major grid panel index (0 = top-left), matching
        /// FrameLoad.splitGrid's output order.
        public var panel: Int
        /// Required for "hard-cut" (this segment's own I2V prompt).
        /// Optional for "camera-move" (only used, joined across segments,
        /// as a fallback when the top-level `prompt` is omitted).
        public var prompt: String?
        /// Required for "camera-move": the latent frame index (within the
        /// single continuous clip) this panel is pinned at. Ignored for
        /// "hard-cut" (each segment's own panel always conditions ITS OWN
        /// frame 0 — the establishing frame of that segment's shot).
        public var frameIndex: Int?
        /// Conditioning strength for this panel, 0.0-1.0. Default 1.0 (fully
        /// pinned) in both modes.
        public var strength: Double?
    }

    public struct LoRASpec: Codable {
        public var path: String
        public var strength: Double?
    }

    public struct AudioSpec: Codable {
        /// "hard-cut" only (mirrors NativeRelayStage.Request.audioOverlayPath) —
        /// REPLACES the final concatenated video's audio entirely.
        public var overlayPath: String?
    }

    public enum ConfigError: Error, CustomStringConvertible {
        case noSegments
        case invalidPanelIndex(panel: Int, panelCount: Int)
        case missingPromptForSegment(Int)
        case missingCombinedPrompt
        case cameraMoveMissingFrameIndex(panel: Int)
        case cameraMovePanelCoverage(panelCount: Int)

        public var description: String {
            switch self {
            case .noSegments:
                return "storyboard config: `segments` must have at least one entry"
            case .invalidPanelIndex(let panel, let panelCount):
                return "storyboard config: segment `panel` \(panel) out of range [0, \(panelCount)) for a \(panelCount)-panel grid"
            case .missingPromptForSegment(let i):
                return "storyboard config: segments[\(i)] is missing `prompt` (required for transitionMode \"hard-cut\")"
            case .missingCombinedPrompt:
                return "storyboard config: transitionMode \"camera-move\" needs a top-level `prompt`, or at least one segment `prompt` to fall back to"
            case .cameraMoveMissingFrameIndex(let panel):
                return "storyboard config: segment for panel \(panel) is missing `frameIndex` (required for transitionMode \"camera-move\")"
            case .cameraMovePanelCoverage(let panelCount):
                return "storyboard config: transitionMode \"camera-move\" requires exactly one segment per grid panel (0..<\(panelCount)), each panel covered exactly once"
            }
        }
    }

    public var version: Int
    public var transitionMode: TransitionMode
    /// Overall generation prompt for "camera-move" (one continuous shot).
    /// Ignored for "hard-cut" (each segment carries its own `prompt`).
    public var prompt: String?
    public var width: Int?
    public var height: Int?
    public var fps: Double?
    public var seed: UInt64?
    public var t2iTransformer: String?
    public var textMaxLength: Int?
    /// "camera-move": total clip duration. "hard-cut": duration PER segment
    /// (every segment shares this — matches NativeRelayStage.Request's
    /// existing single `seconds` field, which already applies uniformly).
    public var seconds: Double?
    public var grid: GridSpec
    public var segments: [Segment]
    public var loras: [LoRASpec]?
    public var audio: AudioSpec?
    /// Default output directory when the CLI's `--output` isn't given.
    public var output: String?

    public static func load(from url: URL) throws -> StoryboardConfig {
        let data = try Data(contentsOf: url)
        return try JSONDecoder().decode(StoryboardConfig.self, from: data)
    }

    private func resolvePath(_ path: String, baseDir: URL) -> URL {
        path.hasPrefix("/") ? URL(fileURLWithPath: path) : baseDir.appendingPathComponent(path)
    }

    private func resolvedLoRAPaths(baseDir: URL) -> [(path: URL, strength: Float)] {
        (loras ?? []).map { (path: resolvePath($0.path, baseDir: baseDir), strength: Float($0.strength ?? 1.0)) }
    }

    /// Build the single continuous NativeI2VStage.Request for
    /// `transitionMode: "camera-move"`.
    public func toCameraMoveRequest(baseDir: URL) throws -> NativeI2VStage.Request {
        guard !segments.isEmpty else { throw ConfigError.noSegments }
        let panelCount = grid.columns * grid.rows

        var frameIndices = Array(repeating: 0, count: panelCount)
        var strengths = Array(repeating: Float(1.0), count: panelCount)
        var covered = Array(repeating: false, count: panelCount)
        for segment in segments {
            guard segment.panel >= 0, segment.panel < panelCount else {
                throw ConfigError.invalidPanelIndex(panel: segment.panel, panelCount: panelCount)
            }
            guard let frameIndex = segment.frameIndex else {
                throw ConfigError.cameraMoveMissingFrameIndex(panel: segment.panel)
            }
            frameIndices[segment.panel] = frameIndex
            strengths[segment.panel] = Float(segment.strength ?? 1.0)
            covered[segment.panel] = true
        }
        guard covered.allSatisfy({ $0 }) else {
            throw ConfigError.cameraMovePanelCoverage(panelCount: panelCount)
        }

        let combinedPrompt = prompt ?? segments.compactMap(\.prompt).joined(separator: ". ")
        guard !combinedPrompt.isEmpty else { throw ConfigError.missingCombinedPrompt }

        var request = NativeI2VStage.Request(
            prompt: combinedPrompt,
            seconds: seconds ?? 2.0,
            fps: fps ?? 24.0,
            width: width ?? 640,
            height: height ?? 960,
            seed: seed ?? 42,
            t2iTransformer: t2iTransformer ?? "moody-pro-mix",
            textMaxLength: textMaxLength ?? 128)
        request.gridImagePath = resolvePath(grid.image, baseDir: baseDir)
        request.gridColumns = grid.columns
        request.gridRows = grid.rows
        request.gridFrameIndices = frameIndices
        request.gridStrengths = strengths
        request.loraPaths = resolvedLoRAPaths(baseDir: baseDir)
        return request
    }

    /// Build the multi-segment NativeRelayStage.Request for
    /// `transitionMode: "hard-cut"`.
    public func toHardCutRequest(baseDir: URL) throws -> NativeRelayStage.Request {
        guard !segments.isEmpty else { throw ConfigError.noSegments }
        let panelCount = grid.columns * grid.rows

        var prompts: [String] = []
        var panels: [Int] = []
        var strengths: [Float] = []
        for (i, segment) in segments.enumerated() {
            guard segment.panel >= 0, segment.panel < panelCount else {
                throw ConfigError.invalidPanelIndex(panel: segment.panel, panelCount: panelCount)
            }
            guard let segPrompt = segment.prompt, !segPrompt.isEmpty else {
                throw ConfigError.missingPromptForSegment(i)
            }
            prompts.append(segPrompt)
            panels.append(segment.panel)
            strengths.append(Float(segment.strength ?? 1.0))
        }

        var request = NativeRelayStage.Request(
            prompts: prompts,
            seconds: seconds ?? 2.0,
            fps: fps ?? 24.0,
            width: width ?? 640,
            height: height ?? 960,
            seed: seed ?? 42,
            t2iTransformer: t2iTransformer ?? "moody-pro-mix",
            textMaxLength: textMaxLength ?? 128)
        request.gridImagePath = resolvePath(grid.image, baseDir: baseDir)
        request.gridColumns = grid.columns
        request.gridRows = grid.rows
        request.segmentGridPanels = panels
        request.segmentGridStrengths = strengths
        request.loraPaths = resolvedLoRAPaths(baseDir: baseDir)
        request.audioOverlayPath = audio?.overlayPath.map { resolvePath($0, baseDir: baseDir) }
        return request
    }
}
