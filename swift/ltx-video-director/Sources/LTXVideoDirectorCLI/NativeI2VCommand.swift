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

    @Option(help: "LTX-2.3 VIDEO transformer variant (mlx-models/ltx-mlx/{variant}/). Default distilled is the only variant this native pipeline has real-checkpoint tests for. dev/dasiwa load their own checkpoint and use the manifest's 30-step schedule; classifier-free guidance, STG, and modality guidance all run automatically for them unless --cfg-scale/--stg-scale/--modality-scale override (see docs/native-i2v-dev-variant-study.md). Not the same flag as --t2i-transformer (that's the T2I image model).")
    var transformer: LTXTransformerVariant = .distilled

    @Option(help: "Classifier-free guidance scale for the video stream. Omit to use the transformer variant's own default: 1.0 (off) for distilled, 5.0 for dev/dasiwa. Set 1.0 to force CFG off even for dev/dasiwa.")
    var cfgScale: Double?

    @Option(help: "Variance-preserving rescale strength applied after the CFG/STG/modality blend (0 disables). Ignored when CFG, STG, and modality guidance are all inactive.")
    var rescaleScale: Double = 0.7

    @Option(help: "Spatio-temporal guidance scale for the video stream (self-attention perturbation on --stg-blocks). Omit to use the transformer variant's own default: 0.0 (off) for distilled, 1.0 for dev/dasiwa. Set 0.0 to force STG off even for dev/dasiwa.")
    var stgScale: Double?

    @Option(parsing: .upToNextOption, help: "Transformer block indices perturbed when STG is active. Default: 28 (matches production's _GUIDER_STG_BLOCKS).")
    var stgBlocks: [Int] = [28]

    @Option(help: "Modality guidance scale for the video stream (isolates cross-modal A2V/V2A attention). Omit to use the transformer variant's own default: 1.0 (off) for distilled, 3.0 for dev/dasiwa. Set 1.0 to force modality guidance off even for dev/dasiwa.")
    var modalityScale: Double?

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
            help: "First-Last-Frame (FFLF): pin this image as the clip's LAST frame (frame 0 is always the T2I-generated --prompt image). Must already be exactly --width x --height unless --last-frame-auto-resize is given.")
    var lastFrame: String?

    @Option(name: .customLong("last-frame-strength"),
            help: "Conditioning strength for --last-frame, 0.0-1.0 (default 1.0 = fully preserved/pinned; lower values partially blend it with generated content instead of hard-pinning it). Matches the reference ComfyUI workflows' per-slot MultiImageLoader strength.")
    var lastFrameStrength: Double = 1.0

    @Flag(name: .customLong("last-frame-auto-resize"),
          help: "Auto-resize --last-frame to exactly --width x --height (aspect-fill + center-crop, bicubic) instead of requiring an exact match. Off by default (fails fast on a size mismatch instead of silently degrading input).")
    var lastFrameAutoResize: Bool = false

    @Flag(name: .customLong("last-frame-derives-resolution"),
          help: "When --last-frame is given: derive the BASE generation --width/--height as half the last-frame image's own dimensions (snapped to the nearest 32), overriding any explicit --width/--height. Implies --last-frame-auto-resize (the full-resolution image is downscaled to the derived base resolution for conditioning). Pairs with --upscale (on by default) to bring the final output back to the last-frame image's own resolution — mirrors the reference ComfyUI FFLF workflows' GetImageSize->EmptyLTXVLatentVideo auto-sizing (see docs/reference/comfyui_workflows/README.md).")
    var lastFrameDerivesResolution: Bool = false

    @Option(name: .customLong("grid-image"),
            help: "Grid guide: a single image containing an NxN grid of storyboard panels, split in-memory and pinned as N independent keyframe guides (see --grid-frame-indices/--grid-strengths). Requires --grid-frame-indices.")
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

    @Option(name: .customLong("audio-track"),
            help: "Custom audio injection: preserve this WAV's content through generation instead of generating audio from scratch. Any sample rate/channel count (resampled to 16kHz, mono duplicated to stereo). If shorter than the clip, only the covered portion is preserved; the rest is still generated.")
    var audioTrack: String?

    @Option(name: .customLong("input-image"),
            help: "I2V from an arbitrary supplied image instead of a T2I-generated one: skips NativeT2IStage entirely and VAE-encodes this image as the frame-0 conditioning latent. Must already be exactly --width x --height. Useful for chaining (e.g. feeding a prior clip's last decoded frame back in as the next segment's start).")
    var inputImage: String?

    @Option(name: .customLong("anchor-image"), parsing: .upToNextOption,
            help: "Multi-anchor I2V conditioning image (repeatable), temporal-keyframing generalization of --last-frame: path:frameIndex[:strength] (strength defaults to 1.0). frameIndex is a LATENT frame index (0 = frame 0, same slot --input-image/T2I already fill — collides last-writer-wins; must be < the clip's latent frame count). Must already be exactly --width x --height. Example: --anchor-image mid.png:12:1.0 --anchor-image end.png:24")
    var anchorImages: [String] = []

    @Flag(name: .customLong("mp4"), inversion: .prefixedNo,
          help: "Mux the final PNG frame sequence (post-upscale if --upscale is on) + audio.wav into a real H.264+AAC output.mp4 via AVAssetWriter. On by default — --no-mp4 to skip and keep just the frame sequence.")
    var mp4: Bool = true

    @Option(name: .customLong("second-stage"),
            help: "When --upscale/--refine are on: chain a SECOND upscale+refine pass, mirroring the reference 3-stage FFLF workflow's Stage #3 (see NativeUpscaleStage.SecondStageUpscaler). 'x1.5' -> spatial_upscaler_x1_5_v1_0 (2x*1.5x=3x total). 'x2' -> spatial_upscaler_x2_v1_1 reused a second time (2x*2x=4x total). Off by default.")
    var secondStage: String?

    func run() throws {
        guard LTXModelRegistry.installedVariants().contains(transformer) else {
            let installed = LTXModelRegistry.installedVariants().map(\.rawValue).joined(separator: ", ")
            throw ValidationError("--transformer '\(transformer.rawValue)' not found under mlx-models/ltx-mlx/ (installed: \(installed.isEmpty ? "none" : installed))")
        }
        var secondStageUpscaler: NativeUpscaleStage.SecondStageUpscaler?
        if let secondStage {
            switch secondStage {
            case "x1.5", "x1_5": secondStageUpscaler = .x1_5
            case "x2": secondStageUpscaler = .x2Again
            default: throw ValidationError("--second-stage must be 'x1.5' or 'x2', got '\(secondStage)'")
            }
            guard upscale, refine else {
                throw ValidationError("--second-stage requires --upscale and --refine (both on by default)")
            }
        }
        var effectiveWidth = width
        var effectiveHeight = height
        if lastFrameDerivesResolution {
            guard let lastFrame else {
                throw ValidationError("--last-frame-derives-resolution requires --last-frame")
            }
            guard let cgImage = FrameLoad.loadCGImage(from: URL(fileURLWithPath: lastFrame)) else {
                throw ValidationError("--last-frame-derives-resolution: could not load image at \(lastFrame)")
            }
            let halved = ResolutionResolver.optimize(width: cgImage.width / 2, height: cgImage.height / 2)
            print("[fflf] --last-frame-derives-resolution: deriving base resolution \(halved.width)x\(halved.height) "
                + "from \(cgImage.width)x\(cgImage.height) last-frame image (halved — --upscale brings it back)")
            effectiveWidth = halved.width
            effectiveHeight = halved.height
        }
        var request = NativeI2VStage.Request(
            prompt: prompt, seconds: seconds, fps: fps, width: effectiveWidth, height: effectiveHeight,
            seed: seed, t2iTransformer: t2iTransformer, textMaxLength: textMaxLength)
        request.fps = fps
        request.transformerVariant = transformer
        request.cfgScale = cfgScale
        request.rescaleScale = Float(rescaleScale)
        request.stgScale = stgScale
        request.stgBlocks = stgBlocks
        request.modalityScale = modalityScale
        request.lastFrameImagePath = lastFrame.map { URL(fileURLWithPath: $0) }
        request.lastFrameStrength = Float(lastFrameStrength)
        request.lastFrameAutoResize = lastFrameAutoResize || lastFrameDerivesResolution
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
        request.audioTrackPath = audioTrack.map { URL(fileURLWithPath: $0) }
        request.inputImagePath = inputImage.map { URL(fileURLWithPath: $0) }
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
        request.anchorImages = try anchorImages.map { spec in
            let parts = spec.split(separator: ":")
            guard parts.count == 2 || parts.count == 3 else {
                throw ValidationError("invalid --anchor-image '\(spec)' — expected path:frameIndex[:strength]")
            }
            let path = String(parts[0])
            guard let frameIndex = Int(parts[1]) else {
                throw ValidationError("invalid --anchor-image frameIndex in '\(spec)' — expected an integer")
            }
            var strength: Float = 1.0
            if parts.count == 3 {
                guard let s = Float(parts[2]) else {
                    throw ValidationError("invalid --anchor-image strength in '\(spec)' — expected path:frameIndex[:strength]")
                }
                strength = s
            }
            return (path: URL(fileURLWithPath: path), frameIndex: frameIndex, strength: strength)
        }

        let recommended = ResolutionResolver.modelOptimalDefault
        if width != recommended.width || height != recommended.height {
            print("[recommend] \(width)x\(height) requested — \(recommended.width)x\(recommended.height) is this "
                + "pipeline's best-verified speed/quality tradeoff (production resolution, matches training "
                + "aspect). Non-default sizes still work (auto-snapped to the nearest multiple of 32) but are "
                + "less validated.")
        }
        // effectiveWidth/effectiveHeight (not width/height) — when
        // --last-frame-derives-resolution overrides the requested dims, this
        // line must report what generation ACTUALLY ran at, since
        // s2-agent-ext-ltx's result.ts parses this exact line for
        // details.width/details.height (found by
        // s2-agent-ext-ltx-self-improve's review lane, 2026-07-05).
        print("→ native I2V (no run.py): \(request.frames) frames @ \(fps)fps, \(effectiveWidth)x\(effectiveHeight), transformer=\(transformer.rawValue)")
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
                    fps: fps,
                    preserveFirstAndLastFrame: lastFrame != nil,
                    secondStage: refine ? secondStageUpscaler : nil)
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
