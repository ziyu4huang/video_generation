//
//  NativeT2ACommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video native-t2a` — pure text-to-audio (no video at all), backed
//  by NativeT2AStage. See NativeT2AStage.swift's header for the ported
//  reference workflow and the audio-only mode mechanism.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

struct NativeT2A: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "native-t2a",
        abstract: "Generate audio ONLY from a text prompt, 100% natively (no run.py, no video) — WAV output."
    )

    @Option(help: "Text prompt.")
    var prompt: String

    @Option(help: "Target audio duration in seconds (internally expressed as a virtual video frame count snapped to LTX's 8k+1 stride — no video is ever generated or decoded).")
    var seconds: Double = 3.84

    @Option(help: "Virtual frame rate used only for the audio-token-count formula.")
    var frameRate: Double = 25.0

    @Option(help: "Random seed.")
    var seed: UInt64 = 42

    @Option(help: "Gemma text-encoder max token length.")
    var textMaxLength: Int = 128

    @Option(name: .shortAndLong, help: "Output directory (audio.wav).")
    var output: String = "native_t2a_output"

    @Option(name: .customLong("lora"), parsing: .upToNextOption,
            help: "LoRA safetensors to fuse into the distilled transformer, repeatable to stack multiple: path[:strength] (strength defaults to 1.0).")
    var loras: [String] = []

    func run() throws {
        var request = NativeT2AStage.Request(
            prompt: prompt, seconds: seconds, frameRate: frameRate,
            seed: seed, textMaxLength: textMaxLength)
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

        print("→ native T2A (no run.py, no video): \(request.virtualVideoFrames) virtual frames @ \(frameRate)fps, transformer=distilled")
        let wallStart = Date()
        let stage = NativeT2AStage()
        let result = try stage.generate(request, outputDir: URL(fileURLWithPath: output))
        let wallSeconds = Date().timeIntervalSince(wallStart)

        print("\n✅ wall time: \(String(format: "%.1f", wallSeconds))s")
        print("   audio: \(result.audioURL.path)")
        print("   100% native Swift/MLX — zero run.py calls, zero video generated.")
    }
}
