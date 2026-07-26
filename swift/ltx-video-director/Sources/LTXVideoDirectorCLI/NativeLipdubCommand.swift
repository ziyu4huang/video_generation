//
//  NativeLipdubCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video native-lipdub` — reference-video lip-dubbing via the LipDub
//  IC-LoRA, fully native (no run.py). Port of Python's `video lipdub`
//  (app/commands/video-lipdub.py) — see NativeUpscaleStage.generateLipdub's
//  header and docs/superpowers/specs/2026-07-26-swift-lipdub-port-design.md.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

struct NativeLipdub: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "native-lipdub",
        abstract: "Re-sync a reference video's mouth to its own audio track 100% natively (no run.py) via a user-supplied LipDub IC-LoRA adapter."
    )

    @Option(name: .customLong("reference-video"), help: "Reference talking-head video (supplies visual structure + target speech audio). Must contain an audio stream.")
    var referenceVideo: String

    @Option(name: .shortAndLong, help: "Output directory (frames/ subdirectory holds the generated PNG sequence, audio.wav holds generated audio).")
    var output: String = "native_lipdub_output"

    @Option(help: "Generation prompt describing the target scene.")
    var prompt: String

    @Option(help: "Path to the LipDub IC-LoRA .safetensors checkpoint (e.g. Lightricks/LTX-2.3-22b-IC-LoRA-LipDub's ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors). No bundled default.")
    var lora: String

    @Option(name: .customLong("lora-strength"), help: "Fusion strength for --lora.")
    var loraStrength: Float = 1.0

    @Option(name: .customLong("reference-strength"), help: "IC-LoRA reference-video conditioning strength (applied at both stages).")
    var referenceStrength: Float = 1.0

    @Option(help: "Output width (snapped to a multiple of 64 — stage 1 runs at width/2).")
    var width: Int = 640

    @Option(help: "Output height (snapped to a multiple of 64 — stage 1 runs at height/2).")
    var height: Int = 960

    @Option(help: "Random seed for the denoise passes.")
    var seed: UInt64 = 42

    @Flag(name: .customLong("mp4"), inversion: .prefixedNo,
          help: "Mux the generated PNG frame sequence + generated audio into a real H.264+AAC output.mp4 via AVAssetWriter. On by default.")
    var mp4: Bool = true

    func run() throws {
        let stage = NativeUpscaleStage()
        let wallStart = Date()

        print("→ native lipdub (no run.py): reference=\(referenceVideo) [lora=\(lora)]")
        let result = try stage.generateLipdub(
            referenceVideoURL: URL(fileURLWithPath: referenceVideo),
            outputDir: URL(fileURLWithPath: output),
            prompt: prompt, loraURL: URL(fileURLWithPath: lora),
            width: width, height: height,
            referenceStrength: referenceStrength, loraStrength: loraStrength,
            seed: seed)
        let wallSeconds = Date().timeIntervalSince(wallStart)

        print("\n✅ wall time: \(String(format: "%.1f", wallSeconds))s")
        print("   \(result.outputSize.width)x\(result.outputSize.height) @ \(result.fps)fps")
        print("   \(result.frameCount) frames: \(result.frameDirectory.path)")
        print("   audio: \(result.audioURL.path)")
        print("   100% native Swift/MLX — zero run.py calls.")

        guard mp4 else { return }
        let mp4URL = URL(fileURLWithPath: output).appendingPathComponent("video.mp4")
        do {
            try MP4Writer.write(frameDirectory: result.frameDirectory, audioURL: result.audioURL, fps: result.fps, to: mp4URL)
            print("\n[mp4] muxed: \(mp4URL.path)")
        } catch {
            print("⚠️  mp4 mux failed, PNG frame sequence above is still valid: \(error)")
        }
    }
}
