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

    @Option(help: "fast = LatentUpsampler, 2x, ~1-2s, native/no run.py (recommended for preview). hd = native IC-LoRA reference-conditioned restoration (real LoRA fusion + VideoConditionByReferenceLatent, see NativeUpscaleStage.generateHD's header) chained into the same fast 2x upscaler — requires --refine-prompt/--refine-audio and the restoration LoRA files under mlx-models/lora/ltx-2.3-restore/. UNVERIFIED against a real checkpoint in this environment (LoRA files are user-downloaded, gitignored) — see generateHD's doc comment.")
    var mode: String = "fast"

    @Option(name: .customLong("refine-prompt"),
            help: "fast mode: follow the neural upscale with a low-strength transformer denoise refinement pass (fixes the over-sharpened/halo artifact the raw upscale alone produces) — optional, requires --refine-audio. hd mode: the generation prompt for the IC-LoRA restoration pass — REQUIRED, reuse the same --prompt as the source native-i2v run.")
    var refinePrompt: String?

    @Option(name: .customLong("refine-audio"),
            help: "WAV to preserve through the refine/restoration pass — the joint audio-video transformer needs a valid audio branch even though audio itself isn't refined. Typically the source native-i2v run's own audio.wav. Required with --refine-prompt (fast mode) and always required for hd mode.")
    var refineAudio: String?

    @Option(help: "Output frame rate of the source clip (used for RoPE video positions in --refine-prompt/hd mode).")
    var fps: Double = 24.0

    @Option(name: .customLong("restoration-lora"), help: "hd mode only: override the restoration IC-LoRA path (default mlx-models/lora/ltx-2.3-restore/ltx2.3-video-restoration-general.safetensors).")
    var restorationLora: String?

    @Option(name: .customLong("upscale-lora"), help: "hd mode only: override the upscale IC-LoRA path (default mlx-models/lora/ltx-2.3-restore/ltx2.3-ic-video-upscale-general.safetensors).")
    var upscaleLora: String?

    @Flag(name: .customLong("mp4"), inversion: .prefixedNo,
          help: "Mux the upscaled PNG frame sequence + --refine-audio (if given) into a real H.264+AAC output.mp4 via AVAssetWriter. On by default — --no-mp4 to skip and keep just the frame sequence. (fast mode only; hd mode doesn't reach this.)")
    var mp4: Bool = true

    func run() throws {
        guard mode == "fast" || mode == "hd" else {
            throw ValidationError("--mode must be 'fast' or 'hd', got '\(mode)'")
        }

        let stage = NativeUpscaleStage()
        let wallStart = Date()
        let result: NativeUpscaleStage.Result
        let finalAudioURL: URL? = refineAudio.map { URL(fileURLWithPath: $0) }

        if mode == "hd" {
            guard let refinePrompt, let refineAudio else {
                throw ValidationError("--mode hd requires both --refine-prompt and --refine-audio (the IC-LoRA restoration pass's text prompt + preserved audio track)")
            }
            print("→ native upscale (no run.py): reading frames from \(input) [hd mode: IC-LoRA restoration + fast 2x upscale]")
            let restoredDir = URL(fileURLWithPath: output).appendingPathComponent("restored")
            let restored = try stage.generateHD(
                inputFrameDirectory: URL(fileURLWithPath: input), outputDir: restoredDir,
                prompt: refinePrompt, audioURL: URL(fileURLWithPath: refineAudio),
                fps: fps,
                restorationLoraURL: restorationLora.map { URL(fileURLWithPath: $0) },
                upscaleLoraURL: upscaleLora.map { URL(fileURLWithPath: $0) })
            print("   [restoration] \(restored.frameCount) frames: \(restored.frameDirectory.path)")
            result = try stage.generate(
                inputFrameDirectory: restored.frameDirectory,
                outputDir: URL(fileURLWithPath: output),
                fps: fps)
        } else {
            print("→ native upscale (no run.py): reading frames from \(input) [fast/preview mode]")
            result = try stage.generate(
                inputFrameDirectory: URL(fileURLWithPath: input),
                outputDir: URL(fileURLWithPath: output),
                refinePrompt: refinePrompt,
                refineAudioURL: finalAudioURL,
                fps: fps)
        }
        let wallSeconds = Date().timeIntervalSince(wallStart)

        print("\n✅ wall time: \(String(format: "%.1f", wallSeconds))s")
        print("   \(result.inputSize.width)x\(result.inputSize.height) -> \(result.outputSize.width)x\(result.outputSize.height)")
        print("   \(result.frameCount) frames: \(result.frameDirectory.path)")
        print("   100% native Swift/MLX — zero run.py calls.")

        guard mp4 else { return }
        let mp4URL = URL(fileURLWithPath: output).appendingPathComponent("video.mp4")
        do {
            try MP4Writer.write(frameDirectory: result.frameDirectory, audioURL: finalAudioURL, fps: fps, to: mp4URL)
            print("\n[mp4] muxed: \(mp4URL.path)")
        } catch {
            print("⚠️  mp4 mux failed, PNG frame sequence above is still valid: \(error)")
        }
    }
}
