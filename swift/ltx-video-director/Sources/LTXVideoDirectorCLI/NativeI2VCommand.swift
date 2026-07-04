//
//  NativeI2VCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video native-i2v` — the FIRST fully native (no run.py, no
//  RunPyBridge, no Python anywhere) end-to-end I2V generation path,
//  backed by NativeI2VStage. Separate from `i2v` (which still uses
//  RunPyBridge for production-quality output) because this assembly is
//  new, distilled-transformer-only, has no VLM prompt expansion, no VAE
//  tiling, and no mp4 muxing yet (PNG frame sequence + WAV instead) — see
//  NativeI2VStage.swift's header and PLAN.md for exactly what's scoped
//  out of this first version.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

struct NativeI2V: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "native-i2v",
        abstract: "Generate I2V frames + audio 100% natively (no run.py) — experimental, distilled-only, PNG+WAV output."
    )

    @Option(help: "Text prompt (used verbatim for both T2I and video stages — no VLM expansion yet).")
    var prompt: String

    @Option(help: "Target clip duration in seconds (frame count snapped to LTX's 8k+1 stride).")
    var seconds: Double = 0.5

    @Option(help: "Output frame rate.")
    var fps: Double = 24.0

    @Option(help: "Output width (must be a multiple of 32).")
    var width: Int = 640

    @Option(help: "Output height (must be a multiple of 32).")
    var height: Int = 960

    @Option(help: "Random seed.")
    var seed: UInt64 = 42

    @Option(help: "T2I transformer variant under models/transformer/.")
    var t2iTransformer: String = "moody-pro-mix"

    @Option(help: "Gemma text-encoder max token length.")
    var textMaxLength: Int = 128

    @Option(name: .shortAndLong, help: "Output directory (source.png, frames/, audio.wav).")
    var output: String = "native_i2v_output"

    @Flag(name: .customLong("upscale"), inversion: .prefixedNo,
          help: "Auto-run the native 2x spatial upscaler (LatentUpsampler) on the generated frames after decode. On by default.")
    var upscale: Bool = true

    @Flag(name: .customLong("refine"), inversion: .prefixedNo,
          help: "When --upscale is on, also run the low-strength transformer refinement pass after it (fixes the raw upscaler's over-sharpened/halo artifact — see NativeUpscaleStage.swift's header). On by default; costs one more real 48-block transformer pass (3 steps) at 2x resolution.")
    var refine: Bool = true

    @Option(name: .customLong("lora"), parsing: .upToNextOption,
            help: "LoRA safetensors to fuse into the distilled transformer, repeatable to stack multiple: path[:strength] (strength defaults to 1.0). Example: --lora a.safetensors:0.8 b.safetensors")
    var loras: [String] = []

    @Option(name: .customLong("last-frame"),
            help: "First-Last-Frame (FFLF): pin this image as the clip's LAST frame (frame 0 is always the T2I-generated --prompt image). Must already be exactly --width x --height.")
    var lastFrame: String?

    @Option(name: .customLong("audio-track"),
            help: "Custom audio injection: preserve this WAV's content through generation instead of generating audio from scratch. Any sample rate/channel count (resampled to 16kHz, mono duplicated to stereo). If shorter than the clip, only the covered portion is preserved; the rest is still generated.")
    var audioTrack: String?

    @Flag(name: .customLong("mp4"), inversion: .prefixedNo,
          help: "Mux the final PNG frame sequence (post-upscale if --upscale is on) + audio.wav into a real H.264+AAC output.mp4 via AVAssetWriter. On by default — --no-mp4 to skip and keep just the frame sequence.")
    var mp4: Bool = true

    func run() throws {
        var request = NativeI2VStage.Request(
            prompt: prompt, seconds: seconds, fps: fps, width: width, height: height,
            seed: seed, t2iTransformer: t2iTransformer, textMaxLength: textMaxLength)
        request.fps = fps
        request.lastFrameImagePath = lastFrame.map { URL(fileURLWithPath: $0) }
        request.audioTrackPath = audioTrack.map { URL(fileURLWithPath: $0) }
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

        let recommended = ResolutionResolver.modelOptimalDefault
        if width != recommended.width || height != recommended.height {
            print("[recommend] \(width)x\(height) requested — \(recommended.width)x\(recommended.height) is this "
                + "pipeline's best-verified speed/quality tradeoff (production resolution, matches training "
                + "aspect). Non-default sizes still work (auto-snapped to the nearest multiple of 32) but are "
                + "less validated.")
        }
        print("→ native I2V (no run.py): \(request.frames) frames @ \(fps)fps, \(width)x\(height), transformer=distilled")
        let wallStart = Date()
        let stage = NativeI2VStage()
        let result = try stage.generate(request, outputDir: URL(fileURLWithPath: output))
        let wallSeconds = Date().timeIntervalSince(wallStart)

        print("\n✅ wall time: \(String(format: "%.1f", wallSeconds))s")
        print("   source image: \(result.sourceImageURL.path)")
        print("   \(result.frameCount) frames: \(result.frameDirectory.path)")
        print("   audio: \(result.audioURL.path)")
        print("   100% native Swift/MLX — zero run.py calls.")

        var finalFrameDirectory = result.frameDirectory
        if upscale {
            let refineNote = refine ? " + refine pass" : ""
            print("\n[upscale] auto-upscaling (native LatentUpsampler, 2x spatial\(refineNote), --no-upscale to skip)...")
            let upscaleStart = Date()
            let upscaleDir = URL(fileURLWithPath: output).appendingPathComponent("upscaled")
            do {
                let upscaleResult = try NativeUpscaleStage().generate(
                    inputFrameDirectory: result.frameDirectory, outputDir: upscaleDir,
                    refinePrompt: refine ? prompt : nil,
                    refineAudioURL: refine ? result.audioURL : nil,
                    fps: fps)
                let upscaleSeconds = Date().timeIntervalSince(upscaleStart)
                print("✅ upscale wall time: \(String(format: "%.1f", upscaleSeconds))s")
                print("   \(upscaleResult.inputSize.width)x\(upscaleResult.inputSize.height) -> "
                    + "\(upscaleResult.outputSize.width)x\(upscaleResult.outputSize.height)")
                print("   \(upscaleResult.frameCount) frames: \(upscaleResult.frameDirectory.path)")
                finalFrameDirectory = upscaleResult.frameDirectory
            } catch {
                // Upscaling is a value-add, not the primary deliverable — a failure
                // here (e.g. missing spatial_upscaler_x2_v1_1.safetensors) should not
                // make the overall native-i2v run look like it failed.
                print("⚠️  auto-upscale failed, base-resolution output above is still valid: \(error)")
            }
        }

        guard mp4 else { return }
        let mp4URL = URL(fileURLWithPath: output).appendingPathComponent("video.mp4")
        do {
            try MP4Writer.write(frameDirectory: finalFrameDirectory, audioURL: result.audioURL, fps: fps, to: mp4URL)
            print("\n[mp4] muxed: \(mp4URL.path)")
        } catch {
            // Muxing is a convenience on top of the PNG+WAV output above, not
            // the primary deliverable — a failure here (e.g. an unsupported
            // codec configuration on this machine) should not make the
            // overall native-i2v run look like it failed.
            print("⚠️  mp4 mux failed, PNG frame sequence + audio.wav above are still valid: \(error)")
        }
    }
}
