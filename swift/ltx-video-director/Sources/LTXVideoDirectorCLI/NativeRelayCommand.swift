//
//  NativeRelayCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video native-relay` — PURE SWIFT (no run.py, no ffmpeg) port of the
//  CORE chaining mechanism in app/commands/video-relay.py's Prompt-Relay
//  pattern. See NativeRelayStage.swift's header for exactly what's scoped
//  out of this first version (audio overlay is "replace" mode only; TTS is
//  macOS `say` only, no edge-tts).
//
//  --variant (A/B comparison): unlike the Python version's _RELAY_VARIANTS
//  (which also toggles distilled-vs-dev pipeline + cfg/stg scale — this
//  native port is distilled-only, so those axes don't apply), the only
//  variant axis available here is "which LoRA(s), if any." No side-by-side
//  HTML reviewer is launched afterward (the Python version's video-review.py
//  has no Swift-side equivalent) — this only runs each variant and prints a
//  plain-text summary table; reviewing the outputs is manual.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

struct NativeRelay: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "native-relay",
        abstract: "Generate a multi-segment prompt-relay video 100% natively (no run.py, no ffmpeg) — experimental, distilled-only."
    )

    @Option(parsing: .upToNextOption, help: "One prompt per segment (2+ args = multi-segment relay).")
    var prompts: [String]

    @Option(name: .customLong("first-image"),
            help: "Reference image for segment 1 (I2V). Must already be exactly --width x --height. Omit for T2I-then-I2V on segment 1.")
    var firstImage: String?

    @Option(help: "Duration per segment in seconds (frame count snapped to LTX's 8k+1 stride).")
    var seconds: Double = 2.0

    @Option(help: "Output frame rate.")
    var fps: Double = 24.0

    @Option(name: .customLong("seconds-per-segment"), parsing: .upToNextOption,
            help: "Per-segment duration override (seconds), one value per --prompts entry. Omit to use --seconds uniformly for every segment.")
    var secondsPerSegment: [Double] = []

    @Option(name: .customLong("segment-continuity"), parsing: .upToNextOption,
            help: "Per-segment continuity override ('true'/'false'), one value per --prompts entry. false = fresh T2I for that segment (hard cut), ignoring the previous segment's last frame. Omit to continue every non-first segment from the previous segment's last frame (default).")
    var segmentContinuity: [Bool] = []

    @Option(help: "Output width (must be a multiple of 32).")
    var width: Int = 640

    @Option(help: "Output height (must be a multiple of 32).")
    var height: Int = 960

    @Option(help: "Base random seed (each segment uses seed + segment index).")
    var seed: UInt64 = 42

    @Option(help: "T2I transformer variant under models/transformer/ (segment 1 only, when --first-image is omitted).")
    var t2iTransformer: String = "moody-pro-mix"

    @Option(help: "Gemma text-encoder max token length.")
    var textMaxLength: Int = 128

    @Option(name: .customLong("lora"), parsing: .upToNextOption,
            help: "LoRA safetensors to fuse into the distilled transformer, repeatable to stack multiple: path[:strength] (strength defaults to 1.0). Applied to every segment.")
    var loras: [String] = []

    @Option(name: .shortAndLong, help: "Output directory (seg01/, seg02/, ..., relay.mp4).")
    var output: String = "native_relay_output"

    @Option(name: .customLong("relay-audio"),
            help: "Custom audio track that REPLACES the final concatenated video's audio entirely (any AVFoundation-decodable format: WAV, MP3, M4A, AAC — no ffmpeg needed). Trimmed to the video's duration if longer. Ignored if --relay-tts-text is also set.")
    var relayAudio: String?

    @Option(name: .customLong("relay-tts-text"),
            help: "Narration text to synthesize via macOS 'say' and use as --relay-audio. Ignored if --relay-audio is also set.")
    var relayTTSText: String?

    @Option(name: .customLong("relay-tts-voice"),
            help: "Voice name for --relay-tts-text (default: Meijia, zh-TW). List available voices with: say -v '?'")
    var relayTTSVoice: String = "Meijia"

    @Option(name: .customLong("relay-tts-rate"),
            help: "Speech rate in words/min for --relay-tts-text.")
    var relayTTSRate: Int = 145

    @Option(name: .customLong("variant"), parsing: .upToNextOption,
            help: "Run once per named variant for A/B comparison: name[=lora_path[:strength]]. A bare name (no '=') runs with no LoRA (e.g. 'baseline'). Repeatable. Each variant's output goes to <output>/<name>/ and overrides --lora for that run.")
    var variantSpecs: [String] = []

    @Option(name: .customLong("grid-image"),
            help: "Grid guide: a single image containing an NxN grid of storyboard panels, split in-memory and pinned as N independent keyframe guides, applied to EVERY segment (see --grid-frame-indices/--grid-strengths). Requires --grid-frame-indices.")
    var gridImage: String?

    @Option(name: .customLong("grid-columns"), help: "Grid guide column count.")
    var gridColumns: Int = 2

    @Option(name: .customLong("grid-rows"), help: "Grid guide row count.")
    var gridRows: Int = 2

    @Option(name: .customLong("grid-frame-indices"), parsing: .upToNextOption,
            help: "Latent frame index for each grid panel, row-major (top-left, top-right, ..., bottom-right). Must have exactly --grid-columns * --grid-rows entries.")
    var gridFrameIndices: [Int] = []

    @Option(name: .customLong("grid-strengths"), parsing: .upToNextOption,
            help: "Per-panel conditioning strength (0.0-1.0, default 1.0 for all panels if omitted). Must match --grid-frame-indices count when given.")
    var gridStrengths: [Double] = []

    private func parseLoRASpecs(_ specs: [String]) throws -> [(path: URL, strength: Float)] {
        try specs.map { spec in
            let parts = spec.split(separator: ":", maxSplits: 1)
            let path = String(parts[0])
            let strength: Float
            if parts.count == 2 {
                guard let s = Float(parts[1]) else {
                    throw ValidationError("invalid --lora strength in '\(spec)' — expected path[:strength]")
                }
                strength = s
            } else {
                strength = 1.0
            }
            return (path: URL(fileURLWithPath: path), strength: strength)
        }
    }

    private func baseRequest() throws -> NativeRelayStage.Request {
        var request = NativeRelayStage.Request(
            prompts: prompts, seconds: seconds, fps: fps, width: width, height: height,
            seed: seed, t2iTransformer: t2iTransformer, textMaxLength: textMaxLength)
        request.firstImagePath = firstImage.map { URL(fileURLWithPath: $0) }
        request.audioOverlayPath = relayAudio.map { URL(fileURLWithPath: $0) }

        if let gridImage {
            guard !gridFrameIndices.isEmpty else {
                throw ValidationError("--grid-image requires --grid-frame-indices")
            }
            request.gridImagePath = URL(fileURLWithPath: gridImage)
            request.gridColumns = gridColumns
            request.gridRows = gridRows
            request.gridFrameIndices = gridFrameIndices
            request.gridStrengths = gridStrengths.map { Float($0) }
        }

        if let ttsText = relayTTSText, relayAudio == nil {
            let ttsURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("native_relay_tts_\(UUID().uuidString).aiff")
            print("→ synthesizing TTS narration (voice=\(relayTTSVoice), rate=\(relayTTSRate))...")
            try MacTTS.synthesize(text: ttsText, voice: relayTTSVoice, rate: relayTTSRate, to: ttsURL)
            request.audioOverlayPath = ttsURL
        }

        if !secondsPerSegment.isEmpty { request.secondsPerSegment = secondsPerSegment }
        if !segmentContinuity.isEmpty { request.segmentContinuity = segmentContinuity }
        return request
    }

    private func runOnce(_ request: NativeRelayStage.Request, outputDir: URL) throws -> NativeRelayStage.Result {
        print("→ native relay (no run.py, no ffmpeg): \(request.prompts.count) segment(s) @ \(width)x\(height), \(seconds)s/segment, transformer=distilled")
        let stage = NativeRelayStage()
        let result = try stage.generate(request, outputDir: outputDir)
        for (i, url) in result.segmentVideoURLs.enumerated() {
            let duration = i < result.segmentDurations.count ? result.segmentDurations[i] : 0
            print("   segment \(i + 1): \(url.path) (\(String(format: "%.2f", duration))s)")
        }
        print("   final: \(result.finalVideoURL.path)")
        print("   100% native Swift/MLX + AVFoundation — zero run.py calls, zero ffmpeg calls.")
        return result
    }

    func run() throws {
        guard !prompts.isEmpty else {
            throw ValidationError("--prompts requires at least one prompt")
        }

        if variantSpecs.isEmpty {
            var request = try baseRequest()
            request.loraPaths = try parseLoRASpecs(loras)
            let wallStart = Date()
            _ = try runOnce(request, outputDir: URL(fileURLWithPath: output))
            print("\n✅ wall time: \(String(format: "%.1f", Date().timeIntervalSince(wallStart)))s")
            return
        }

        print("═══ Relay Variant A/B Comparison: \(variantSpecs.count) variant(s) ═══")
        var results: [(name: String, status: String, elapsed: Double)] = []
        for spec in variantSpecs {
            let parts = spec.split(separator: "=", maxSplits: 1)
            let name = String(parts[0])
            let loraSpecs = parts.count == 2 ? [String(parts[1])] : []

            print("\n═══ Variant: \(name) (\(loraSpecs.isEmpty ? "no LoRA" : loraSpecs[0])) ═══")
            var request = try baseRequest()
            do {
                request.loraPaths = try parseLoRASpecs(loraSpecs)
            } catch {
                results.append((name, "error: \(error)", 0))
                continue
            }

            let variantDir = URL(fileURLWithPath: output).appendingPathComponent(name)
            let wallStart = Date()
            do {
                _ = try runOnce(request, outputDir: variantDir)
                results.append((name, "ok", Date().timeIntervalSince(wallStart)))
            } catch {
                results.append((name, "error: \(error)", Date().timeIntervalSince(wallStart)))
                print("⚠️  variant '\(name)' failed: \(error)")
            }
        }

        print("\n═══ Variant Comparison Summary ═══")
        for r in results {
            let tag = r.status == "ok" ? "✓" : "✗"
            let minutes = String(format: "%.1f", r.elapsed / 60)
            print("  \(r.name.padding(toLength: 20, withPad: " ", startingAt: 0)) \(tag) \(r.status)  \(minutes) min")
        }
    }
}
