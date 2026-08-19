//
//  NativeIngredientsCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video native-ingredients` — one-or-more-reference-image IC-LoRA
//  conditioning, fully native (no run.py). See NativeUpscaleStage
//  .generateIngredients's header — the sibling "easy tier" application to
//  `native-restyle` identified in PLAN.md's IC-LoRA scoping research: each
//  reference is a single still image tiled across the generation's frame
//  count (not a real input video clip), so there's no --input frame
//  directory — just one or more reference images, a target resolution, and
//  a duration.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

struct NativeIngredients: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "native-ingredients",
        abstract: "Generate a video from one or more reference images 100% natively (no run.py) via a user-supplied Ingredients IC-LoRA adapter."
    )

    @Option(name: .customLong("input"), parsing: .upToNextOption,
            help: "Reference image(s) (e.g. a character/product/scene reference sheet). Repeatable — pass multiple --input flags (or multiple paths after one --input) to condition on more than one reference simultaneously. Experimental multi-reference compositing: see python/mlx-movie-director/docs/openmontage-capability-matrix.md and docs/superpowers/specs/2026-07-26-multi-reference-ingredients-design.md.")
    var input: [String] = []

    @Option(name: .shortAndLong, help: "Output directory (frames/ subdirectory holds the generated PNG sequence, audio.wav holds generated audio).")
    var output: String = "native_ingredients_output"

    @Option(help: "Generation prompt describing the target scene.")
    var prompt: String

    @Option(help: "Path to the Ingredients IC-LoRA .safetensors checkpoint (e.g. Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients's ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors). No bundled default.")
    var lora: String

    @Option(name: .customLong("lora-strength"), help: "Fusion strength for --lora.")
    var loraStrength: Float = 1.0

    @Option(help: "Output width (snapped to a valid resolution — see ResolutionResolver).")
    var width: Int = 640

    @Option(help: "Output height (snapped to a valid resolution — see ResolutionResolver).")
    var height: Int = 960

    @Option(help: "Target duration in seconds (rounded to the nearest valid LTX frame count, 8k+1).")
    var seconds: Double = 5.0

    @Option(help: "Output frame rate (used for RoPE video positions and audio token count).")
    var fps: Double = 24.0

    @Option(help: "Random seed for the denoise pass.")
    var seed: UInt64 = 42

    @Flag(name: .customLong("mp4"), inversion: .prefixedNo,
          help: "Mux the generated PNG frame sequence + generated audio into a real H.264+AAC output.mp4 via AVAssetWriter. On by default.")
    var mp4: Bool = true

    func run() throws {
        let stage = NativeUpscaleStage()
        let wallStart = Date()

        print("→ native ingredients (no run.py): reference=\(input) [lora=\(lora)]")
        let result = try stage.generateIngredients(
            referenceImageURLs: input.map { URL(fileURLWithPath: $0) },
            outputDir: URL(fileURLWithPath: output),
            prompt: prompt, loraURL: URL(fileURLWithPath: lora),
            width: width, height: height, seconds: seconds,
            fps: fps, seed: seed, loraStrength: loraStrength)
        let wallSeconds = Date().timeIntervalSince(wallStart)

        print("\n✅ wall time: \(String(format: "%.1f", wallSeconds))s")
        print("   \(result.outputSize.width)x\(result.outputSize.height)")
        print("   \(result.frameCount) frames: \(result.frameDirectory.path)")
        print("   audio: \(result.audioURL.path)")
        print("   100% native Swift/MLX — zero run.py calls.")

        guard mp4 else { return }
        let mp4URL = URL(fileURLWithPath: output).appendingPathComponent("video.mp4")
        do {
            try MP4Writer.write(frameDirectory: result.frameDirectory, audioURL: result.audioURL, fps: fps, to: mp4URL)
            print("\n[mp4] muxed: \(mp4URL.path)")
        } catch {
            print("⚠️  mp4 mux failed, PNG frame sequence above is still valid: \(error)")
        }
    }
}
