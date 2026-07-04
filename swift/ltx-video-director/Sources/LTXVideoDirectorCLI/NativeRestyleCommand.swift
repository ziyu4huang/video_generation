//
//  NativeRestyleCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video native-restyle` — V2V restyle: fully native (no run.py)
//  IC-LoRA reference-conditioned style transfer over an existing PNG frame
//  sequence, at the reference's own resolution. See NativeUpscaleStage
//  .generateRestyle's header — the "easiest, near-zero new preprocessing"
//  application identified in PLAN.md's IC-LoRA scoping research, sharing
//  the same reference-conditioning primitive `native-upscale --mode hd`
//  uses but with a single user-supplied style LoRA instead of the bundled
//  restoration pair.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

struct NativeRestyle: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "native-restyle",
        abstract: "V2V restyle a PNG frame sequence 100% natively (no run.py) via a user-supplied IC-LoRA style adapter."
    )

    @Option(name: .shortAndLong, help: "Input frame directory (frame_%04d.png sequence, e.g. native-i2v's frames/ output) — the reference clip to restyle.")
    var input: String

    @Option(name: .shortAndLong, help: "Output directory (frames/ subdirectory holds the restyled PNG sequence).")
    var output: String = "native_restyle_output"

    @Option(help: "Generation prompt describing the target style.")
    var prompt: String

    @Option(help: "WAV to preserve through the pass — the joint audio-video transformer needs a valid audio branch even though audio itself isn't restyled. Typically the source native-i2v run's own audio.wav.")
    var audio: String

    @Option(help: "Path to the V2V-style IC-LoRA .safetensors checkpoint. No bundled default — this is a user-supplied style adapter (e.g. a Lightricks or community LTX-2.3 IC-LoRA).")
    var lora: String

    @Option(name: .customLong("lora-strength"), help: "Fusion strength for --lora.")
    var loraStrength: Float = 1.0

    @Option(help: "Output frame rate of the source clip (used for RoPE video positions).")
    var fps: Double = 24.0

    @Option(help: "Random seed for the denoise pass.")
    var seed: UInt64 = 42

    @Flag(name: .customLong("mp4"), inversion: .prefixedNo,
          help: "Mux the restyled PNG frame sequence + --audio into a real H.264+AAC output.mp4 via AVAssetWriter. On by default.")
    var mp4: Bool = true

    func run() throws {
        let stage = NativeUpscaleStage()
        let wallStart = Date()
        let audioURL = URL(fileURLWithPath: audio)

        print("→ native restyle (no run.py): reading frames from \(input) [V2V, lora=\(lora)]")
        let result = try stage.generateRestyle(
            inputFrameDirectory: URL(fileURLWithPath: input),
            outputDir: URL(fileURLWithPath: output),
            prompt: prompt, audioURL: audioURL,
            loraURL: URL(fileURLWithPath: lora),
            fps: fps, seed: seed, loraStrength: loraStrength)
        let wallSeconds = Date().timeIntervalSince(wallStart)

        print("\n✅ wall time: \(String(format: "%.1f", wallSeconds))s")
        print("   \(result.inputSize.width)x\(result.inputSize.height) (unchanged — restyle, not upscale)")
        print("   \(result.frameCount) frames: \(result.frameDirectory.path)")
        print("   100% native Swift/MLX — zero run.py calls.")

        guard mp4 else { return }
        let mp4URL = URL(fileURLWithPath: output).appendingPathComponent("video.mp4")
        do {
            try MP4Writer.write(frameDirectory: result.frameDirectory, audioURL: audioURL, fps: fps, to: mp4URL)
            print("\n[mp4] muxed: \(mp4URL.path)")
        } catch {
            print("⚠️  mp4 mux failed, PNG frame sequence above is still valid: \(error)")
        }
    }
}
