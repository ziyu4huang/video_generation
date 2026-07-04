//
//  NativeRelayCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video native-relay` — PURE SWIFT (no run.py, no ffmpeg) port of the
//  CORE chaining mechanism in app/commands/video-relay.py's Prompt-Relay
//  pattern. See NativeRelayStage.swift's header for exactly what's scoped
//  out of this first version (audio overlay is "replace" mode only; TTS is
//  macOS `say` only, no edge-tts; no variant A/B).
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

    func run() throws {
        guard !prompts.isEmpty else {
            throw ValidationError("--prompts requires at least one prompt")
        }

        var request = NativeRelayStage.Request(
            prompts: prompts, seconds: seconds, fps: fps, width: width, height: height,
            seed: seed, t2iTransformer: t2iTransformer, textMaxLength: textMaxLength)
        request.firstImagePath = firstImage.map { URL(fileURLWithPath: $0) }
        request.audioOverlayPath = relayAudio.map { URL(fileURLWithPath: $0) }

        if let ttsText = relayTTSText, relayAudio == nil {
            let ttsURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("native_relay_tts_\(UUID().uuidString).aiff")
            print("→ synthesizing TTS narration (voice=\(relayTTSVoice), rate=\(relayTTSRate))...")
            try MacTTS.synthesize(text: ttsText, voice: relayTTSVoice, rate: relayTTSRate, to: ttsURL)
            request.audioOverlayPath = ttsURL
        }
        request.loraPaths = try loras.map { spec in
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

        print("→ native relay (no run.py, no ffmpeg): \(prompts.count) segment(s) @ \(width)x\(height), \(seconds)s/segment, transformer=distilled")
        let wallStart = Date()
        let stage = NativeRelayStage()
        let result = try stage.generate(request, outputDir: URL(fileURLWithPath: output))
        let wallSeconds = Date().timeIntervalSince(wallStart)

        print("\n✅ wall time: \(String(format: "%.1f", wallSeconds))s")
        for (i, url) in result.segmentVideoURLs.enumerated() {
            print("   segment \(i + 1): \(url.path)")
        }
        print("   final: \(result.finalVideoURL.path)")
        print("   100% native Swift/MLX + AVFoundation — zero run.py calls, zero ffmpeg calls.")
    }
}
