//
//  NativeUpscaleCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video native-upscale` — the FIRST fully native (no run.py) spatial
//  upscale path, backed by NativeUpscaleStage (LTX-2.3's real
//  LatentUpsampler neural network, spatial_x2 variant). Separate from
//  `upscale` (which bridges to run.py's IC-LoRA restoration/upscale
//  pipeline — a different, larger mechanism, see NativeUpscaleStage.swift's
//  header and PLAN.md).
//

import ArgumentParser
import Foundation
import LTXVideoDirector

struct NativeUpscale: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "native-upscale",
        abstract: "2x spatial upscale a PNG frame sequence 100% natively (no run.py) via LTX-2.3's LatentUpsampler."
    )

    @Option(name: .shortAndLong, help: "Input frame directory (frame_%04d.png sequence, e.g. native-i2v's frames/ output).")
    var input: String

    @Option(name: .shortAndLong, help: "Output directory (frames/ subdirectory holds the upscaled PNG sequence).")
    var output: String = "native_upscale_output"

    @Option(help: "fast = LatentUpsampler, 2x, ~1-2s, native/no run.py (recommended for preview). hd = IC-LoRA generative restoration+upscale, higher quality but slower and not yet natively ported — this mode just prints the equivalent `ltx-video upscale` invocation instead of running.")
    var mode: String = "fast"

    @Option(name: .customLong("refine-prompt"),
            help: "Follow the neural upscale with a low-strength transformer denoise refinement pass (fixes the over-sharpened/halo artifact the raw upscale alone produces). Requires --refine-audio. Text prompt — reuse the same --prompt as the source native-i2v run.")
    var refinePrompt: String?

    @Option(name: .customLong("refine-audio"),
            help: "WAV to preserve through the refine pass (required with --refine-prompt) — the joint audio-video transformer needs a valid audio branch even though audio itself isn't refined. Typically the source native-i2v run's own audio.wav.")
    var refineAudio: String?

    @Option(help: "Output frame rate of the source clip (only used by --refine-prompt, for RoPE video positions).")
    var fps: Double = 24.0

    func run() throws {
        guard mode == "fast" || mode == "hd" else {
            throw ValidationError("--mode must be 'fast' or 'hd', got '\(mode)'")
        }
        if mode == "hd" {
            print("→ hd mode is not natively ported yet (IC-LoRA needs LoRA fusion + reference conditioning — "
                + "see PLAN.md's \"Research: native spatial upscaling\"). Use the run.py-bridged path instead:")
            print("   ltx-video upscale --input \(input) --output \(output)")
            return
        }
        print("→ native upscale (no run.py): reading frames from \(input) [fast/preview mode]")
        let wallStart = Date()
        let stage = NativeUpscaleStage()
        let result = try stage.generate(
            inputFrameDirectory: URL(fileURLWithPath: input),
            outputDir: URL(fileURLWithPath: output),
            refinePrompt: refinePrompt,
            refineAudioURL: refineAudio.map { URL(fileURLWithPath: $0) },
            fps: fps)
        let wallSeconds = Date().timeIntervalSince(wallStart)

        print("\n✅ wall time: \(String(format: "%.1f", wallSeconds))s")
        print("   \(result.inputSize.width)x\(result.inputSize.height) -> \(result.outputSize.width)x\(result.outputSize.height)")
        print("   \(result.frameCount) frames: \(result.frameDirectory.path)")
        print("   100% native Swift/MLX — zero run.py calls.")
    }
}
