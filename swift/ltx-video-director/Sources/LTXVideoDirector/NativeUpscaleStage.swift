//
//  NativeUpscaleStage.swift
//  LTXVideoDirector
//
//  First native (no run.py) spatial-upscale assembly: reads a PNG frame
//  sequence (e.g. `native-i2v`'s or `video-decode`'s output), VAE-encodes it
//  to LTX-2.3's 128-channel latent space, runs it through LatentUpsampler
//  (the real spatial_x2 neural upscaler — see LatentUpsampler.swift's
//  header for why this is a different, much smaller mechanism than the
//  IC-LoRA restoration path `ltx-video upscale` already bridges to run.py
//  for), VAE-decodes the doubled-resolution latent back to pixels, and
//  writes a new PNG frame sequence — 2x spatial resolution, zero run.py.
//
//  Scope, deliberately narrow (matches this package's other native stages):
//    - spatial_x2 ONLY (LatentUpsampler's ported variant).
//    - Optional "refine" pass (2026-07-03): the real two-stage LTX pipeline
//      follows the neural upscale with a transformer denoise refinement
//      step at low strength (see docs/reference/comfyui_workflows/README.md
//      finding 1 — linear_quadratic-ish schedule, NOT a fresh
//      noise-to-clean pass). When `refinePrompt`/`refineAudioURL` are
//      supplied, `generate` forward-noises the upscaled (normalized) video
//      latent to `SigmaSchedule.stage2Sigmas[0]` and re-runs
//      `DenoiseLoop.runStreaming` (same real 48-block distilled transformer
//      NativeI2VStage uses) over that short schedule, fixing the
//      over-sharpened/halo artifact the raw neural upscale alone produces
//      (documented in docs/TODO.md's "Default auto-upscale" milestone).
//      The audio track is NOT refined — it's re-encoded from
//      `refineAudioURL` and pinned fully preserved (denoiseMask=0
//      everywhere) purely so the joint audio-video transformer has a valid
//      audio branch to attend to; this is why a refine pass requires an
//      existing audio track (typically native-i2v's own `audio.wav`), not
//      just a prompt. When both are nil, behaves exactly as before
//      (upscale-only, encode -> upsample -> decode).
//    - Input frame count must already satisfy LTX's 8k+1 constraint (true
//      of any `native-i2v`/`video-decode` output) — this stage doesn't
//      re-derive or adjust frame counts.
//    - No VAE tiling — same constraint NativeI2VStage documents.
//

import AVFoundation
import Foundation
import MLX

public struct NativeUpscaleStage {
    public enum StageError: Error, CustomStringConvertible {
        case noFramesFound(URL)
        case videoEncoderCheckpointNotFound(URL)
        case videoDecoderCheckpointNotFound(URL)
        case upsamplerCheckpointNotFound(URL)
        case transformerCheckpointNotFound(URL)
        case audioEncoderCheckpointNotFound(URL)
        case refineNeedsAudioTrack
        case secondStageNeedsRefine
        case restorationLoraNotFound(URL)
        case upscaleLoraNotFound(URL)
        case restyleLoraNotFound(URL)
        case referenceImageNotFound(URL)
        case ingredientsLoraNotFound(URL)
        case noReferenceImages
        case invalidDimensions(String)
        case referenceVideoNotFound(URL)
        case referenceVideoNoAudioTrack(URL)
        case lipdubLoraNotFound(URL)

        public var description: String {
            switch self {
            case .noFramesFound(let url): return "NativeUpscaleStage: no frame_*.png files found in \(url.path)"
            case .videoEncoderCheckpointNotFound(let url): return "NativeUpscaleStage: video VAE encoder checkpoint not found at \(url.path)"
            case .videoDecoderCheckpointNotFound(let url): return "NativeUpscaleStage: video VAE decoder checkpoint not found at \(url.path)"
            case .upsamplerCheckpointNotFound(let url): return "NativeUpscaleStage: spatial upscaler checkpoint not found at \(url.path)"
            case .transformerCheckpointNotFound(let url): return "NativeUpscaleStage: LTX-2.3 distilled transformer checkpoint not found at \(url.path)"
            case .audioEncoderCheckpointNotFound(let url): return "NativeUpscaleStage: LTX-2.3 audio VAE checkpoint not found at \(url.path)"
            case .refineNeedsAudioTrack: return "NativeUpscaleStage: --refine-prompt requires --refine-audio (the joint audio-video transformer needs a preserved audio track to attend to during refinement, even though audio itself isn't refined)"
            case .secondStageNeedsRefine: return "NativeUpscaleStage: --second-stage requires --refine-prompt/--refine-audio (the reference 3-stage pipeline always refines each cascaded upscale stage, not just the last one)"
            case .restorationLoraNotFound(let url): return "NativeUpscaleStage: hd mode's restoration IC-LoRA not found at \(url.path) — download `ltx2.3-video-restoration-general.safetensors` per mlx-models/lora/ltx-2.3-restore/README.md"
            case .upscaleLoraNotFound(let url): return "NativeUpscaleStage: hd mode's upscale IC-LoRA not found at \(url.path) — download `ltx2.3-ic-video-upscale-general.safetensors` per mlx-models/lora/ltx-2.3-restore/README.md"
            case .restyleLoraNotFound(let url): return "NativeUpscaleStage: restyle IC-LoRA not found at \(url.path) — pass --lora pointing at a V2V-style IC-LoRA checkpoint (e.g. a Lightricks LTX-2.3 style-transfer adapter); no bundled default, unlike hd mode's restoration pair"
            case .referenceImageNotFound(let url): return "NativeUpscaleStage: ingredients reference image not found at \(url.path)"
            case .ingredientsLoraNotFound(let url): return "NativeUpscaleStage: ingredients IC-LoRA not found at \(url.path) — download Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients from HuggingFace (ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors) and pass its path via --lora; no bundled default, unlike hd mode's restoration pair"
            case .noReferenceImages: return "NativeUpscaleStage: generateIngredients requires at least one reference image"
            case .invalidDimensions(let msg): return "NativeUpscaleStage: \(msg)"
            case .referenceVideoNotFound(let url): return "NativeUpscaleStage: lipdub reference video not found at \(url.path)"
            case .referenceVideoNoAudioTrack(let url): return "NativeUpscaleStage: lipdub reference video has no audio stream (LipDub needs the target speech from the reference) at \(url.path)"
            case .lipdubLoraNotFound(let url): return "NativeUpscaleStage: LipDub IC-LoRA not found at \(url.path) — download Lightricks/LTX-2.3-22b-IC-LoRA-LipDub from HuggingFace (HF-gated) and pass its path via --lora"
            }
        }
    }

    /// Which second-stage neural upscaler checkpoint to chain after the
    /// mandatory first (spatial_x2) stage — mirrors the reference 3-stage
    /// FFLF workflow's `LatentUpscaleModelLoader` + `PrimitiveBoolean`
    /// 1.5x-total/2x-total toggle (see docs/reference/comfyui_workflows/
    /// README.md's second pass, "True N-stage cascade" finding): `.x1_5`
    /// gives 2x*1.5x=3x total (the reference's "1.5x-total" label refers to
    /// the SECOND stage's own factor, not the cumulative total — confirmed
    /// against the workflow JSON's stage graph, not assumed), `.x2Again`
    /// gives 2x*2x=4x total using the SAME already-ported x2 checkpoint
    /// twice (the reference's "2x-total" toggle branch, which reuses
    /// spatial_upscaler_x2_v1_1 rather than loading a distinct checkpoint).
    public enum SecondStageUpscaler {
        case x1_5
        case x2Again

        var checkpointFilename: String {
            switch self {
            case .x1_5: return "spatial_upscaler_x1_5_v1_0.safetensors"
            case .x2Again: return "spatial_upscaler_x2_v1_1.safetensors"
            }
        }
        var checkpointPrefix: String {
            switch self {
            case .x1_5: return "spatial_upscaler_x1_5_v1_0."
            case .x2Again: return "spatial_upscaler_x2_v1_1."
            }
        }
        var latentUpsamplerVariant: LatentUpsampler.Variant {
            switch self {
            case .x1_5: return .spatialX1_5
            case .x2Again: return .spatialX2
            }
        }
        var factor: Double {
            switch self {
            case .x1_5: return 1.5
            case .x2Again: return 2.0
            }
        }
    }

    public struct Result {
        public let frameDirectory: URL
        public let frameCount: Int
        public let inputSize: (width: Int, height: Int)
        public let outputSize: (width: Int, height: Int)
    }

    /// `generateIngredients`'s own result type, distinct from `Result` above:
    /// unlike `generateHD`/`generateRestyle` (which pass an existing input
    /// audio track straight to the CLI's MP4 mux step), Ingredients has no
    /// input video/audio at all — only a still reference image — so the
    /// audio track is generated by the transformer alongside video and must
    /// be decoded and written out here, hence `audioURL` instead of an
    /// `inputSize` that wouldn't mean anything (there's no "input clip").
    public struct IngredientsResult {
        public let frameDirectory: URL
        public let frameCount: Int
        public let outputSize: (width: Int, height: Int)
        public let audioURL: URL
    }

    /// `generateLipdub`'s own result type — same shape as `IngredientsResult`
    /// plus `fps` (derived from the reference video, not caller-supplied, so
    /// callers muxing an mp4 afterward need it back).
    public struct LipdubResult {
        public let frameDirectory: URL
        public let frameCount: Int
        public let outputSize: (width: Int, height: Int)
        public let audioURL: URL
        public let fps: Double
    }

    public init() {}

    /// Reads `frame_%04d.png` files from `inputFrameDirectory` (sorted by
    /// filename), 2x-spatially-upscales them natively, and writes the
    /// result to `outputDir`. When `refinePrompt` is supplied (together
    /// with `refineAudioURL`), follows the neural upscale with a
    /// low-strength transformer denoise refinement pass — see this file's
    /// header for why both are needed together.
    /// `secondStage`: chains a SECOND upscale+refine pass after the first
    /// (mirroring the reference 3-stage FFLF workflow's Stage #3 — see
    /// `SecondStageUpscaler`'s doc comment). Both stages refine in latent
    /// space before any pixel decode happens — only one final VideoDecoder
    /// call, matching the reference's own single-decode-at-the-end
    /// structure (LTXVSeparateAVLatent only appears once per stage in the
    /// reference too, but nothing is decoded to pixels between stages).
    /// Requires `refinePrompt`/`refineAudioURL` (see `.secondStageNeedsRefine`)
    /// since the reference always refines every cascaded stage, not just
    /// upscales it.
    public func generate(
        inputFrameDirectory: URL, outputDir: URL,
        refinePrompt: String? = nil, refineAudioURL: URL? = nil,
        fps: Double = 24.0, textMaxLength: Int = 128, seed: UInt64 = 42,
        preserveFirstAndLastFrame: Bool = false,
        secondStage: SecondStageUpscaler? = nil
    ) throws -> Result {
        if refinePrompt != nil, refineAudioURL == nil {
            throw StageError.refineNeedsAudioTrack
        }
        if secondStage != nil, refinePrompt == nil || refineAudioURL == nil {
            throw StageError.secondStageNeedsRefine
        }
        let fm = FileManager.default
        let frameFiles = (try fm.contentsOfDirectory(atPath: inputFrameDirectory.path))
            .filter { $0.hasPrefix("frame_") && $0.hasSuffix(".png") }
            .sorted()
        guard !frameFiles.isEmpty else {
            throw StageError.noFramesFound(inputFrameDirectory)
        }

        print("[1/4] Loading \(frameFiles.count) input frames...")
        var frameArrays: [MLXArray] = []
        var width = 0, height = 0
        for file in frameFiles {
            let url = inputFrameDirectory.appendingPathComponent(file)
            guard let cgImage = FrameLoad.loadCGImage(from: url) else { continue }
            let arr = FrameLoad.toArray(cgImage)  // (1, 3, H, W) [0, 1]
            width = arr.dim(3); height = arr.dim(2)
            frameArrays.append(arr)
        }
        guard !frameArrays.isEmpty else {
            throw StageError.noFramesFound(inputFrameDirectory)
        }
        // Stack along a new temporal axis: (1, 3, F, H, W), [-1, 1].
        let stacked = MLX.stacked(frameArrays.map { $0[0] }, axis: 1)  // (3, F, H, W)
        let pixelsBCFHW = (stacked.asType(.float32) * 2.0 - 1.0).expandedDimensions(axis: 0)

        print("[2/4] VideoEncoder: encoding \(width)x\(height) frames to latent...")
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        guard fm.fileExists(atPath: vaeEncoderURL.path) else {
            throw StageError.videoEncoderCheckpointNotFound(vaeEncoderURL)
        }
        let encRaw = try MLX.loadArrays(url: vaeEncoderURL)
        var encWeights: [String: MLXArray] = [:]
        for (key, value) in encRaw {
            let stripped = key.hasPrefix("vae_encoder.") ? String(key.dropFirst("vae_encoder.".count)) : key
            encWeights[stripped] = value.asType(.float32)
        }
        let videoEncoder = VideoEncoder(weights: encWeights)
        let latent = videoEncoder(pixelsBCFHW)  // (1, 128, F', H', W'), NORMALIZED ((x-mean)/std)
        MLX.eval(latent)

        print("[3/4] LatentUpsampler: 2x spatial upscale in latent space...")
        let upsamplerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors")
        guard fm.fileExists(atPath: upsamplerURL.path) else {
            throw StageError.upsamplerCheckpointNotFound(upsamplerURL)
        }
        let upRaw = try MLX.loadArrays(url: upsamplerURL)
        let upPrefix = "spatial_upscaler_x2_v1_1."
        var upWeights: [String: MLXArray] = [:]
        for (key, value) in upRaw {
            let stripped = key.hasPrefix(upPrefix) ? String(key.dropFirst(upPrefix.count)) : key
            upWeights[stripped] = value.asType(.float32)
        }
        let upsampler = LatentUpsampler(weights: upWeights)

        // LatentUpsampler was trained on DENORMALIZED (raw VAE-scale) latents
        // — confirmed against the vendor reference (ti2vid_two_stages.py's
        // Stage 1->2 handoff: `vae_encoder.denormalize_latent` before the
        // upsampler call, `vae_encoder.normalize_latent` after). Feeding it
        // the normalized latent directly (as VideoEncoder outputs it)
        // produces severe color-fringing/noise artifacts — found by visual
        // inspection, not caught by the tiny-random-latent parity test
        // (whose small values happen to tolerate the wrong scale less
        // visibly). Denormalize before, renormalize after, matching the
        // reference exactly.
        let meanC = videoEncoder.meanOfMeans.reshaped([1, -1, 1, 1, 1])
        let stdC = videoEncoder.stdOfMeans.reshaped([1, -1, 1, 1, 1])
        let denormLatent = latent * stdC + meanC
        let upscaledDenorm = upsampler(denormLatent)  // (1, 128, F', 2H', 2W'), denormalized
        var upscaledLatent = (upscaledDenorm - meanC) / stdC  // back to normalized, for VideoDecoder
        MLX.eval(upscaledLatent)

        if let refinePrompt, let refineAudioURL {
            print("[3b/4] refine: low-strength denoise pass (stage-2 sigmas, real 48-block distilled transformer)\(preserveFirstAndLastFrame ? " — preserving first/last FFLF frames" : "")...")
            upscaledLatent = try refine(
                normalizedLatent: upscaledLatent, prompt: refinePrompt, audioURL: refineAudioURL,
                fps: fps, textMaxLength: textMaxLength, seed: seed,
                preserveFirstAndLastFrame: preserveFirstAndLastFrame)
            MLX.eval(upscaledLatent)
        }

        var totalScale = 2.0
        if let secondStage, let refinePrompt, let refineAudioURL {
            print("[3c/4] second-stage cascade: \(secondStage.checkpointFilename) neural upscale (\(secondStage.factor)x) + refine...")
            let secondUpsamplerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/\(secondStage.checkpointFilename)")
            guard fm.fileExists(atPath: secondUpsamplerURL.path) else {
                throw StageError.upsamplerCheckpointNotFound(secondUpsamplerURL)
            }
            let secondUpRaw = try MLX.loadArrays(url: secondUpsamplerURL)
            var secondUpWeights: [String: MLXArray] = [:]
            for (key, value) in secondUpRaw {
                let stripped = key.hasPrefix(secondStage.checkpointPrefix) ? String(key.dropFirst(secondStage.checkpointPrefix.count)) : key
                secondUpWeights[stripped] = value.asType(.float32)
            }
            let secondUpsampler = LatentUpsampler(weights: secondUpWeights, variant: secondStage.latentUpsamplerVariant)

            let secondDenorm = upscaledLatent * stdC + meanC
            let secondUpscaledDenorm = secondUpsampler(secondDenorm)
            upscaledLatent = (secondUpscaledDenorm - meanC) / stdC
            MLX.eval(upscaledLatent)

            print("[3d/4] second-stage refine: low-strength denoise pass\(preserveFirstAndLastFrame ? " — preserving first/last FFLF frames" : "")...")
            upscaledLatent = try refine(
                normalizedLatent: upscaledLatent, prompt: refinePrompt, audioURL: refineAudioURL,
                fps: fps, textMaxLength: textMaxLength, seed: seed &+ 1,
                preserveFirstAndLastFrame: preserveFirstAndLastFrame)
            MLX.eval(upscaledLatent)
            totalScale *= secondStage.factor
        }

        let outWidth = Int((Double(width) * totalScale).rounded())
        let outHeight = Int((Double(height) * totalScale).rounded())
        print("[4/4] VideoDecoder: decoding upscaled latent to \(outWidth)x\(outHeight) frames...")
        let videoDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        guard fm.fileExists(atPath: videoDecoderURL.path) else {
            throw StageError.videoDecoderCheckpointNotFound(videoDecoderURL)
        }
        let videoDecoder = try VideoDecoderLoader.loadReal(checkpointURL: videoDecoderURL)
        let pixels = videoDecoder(upscaledLatent.asType(.float32))  // (1, 3, F, outH, outW), [-1, 1]
        MLX.eval(pixels)

        let frameDir = outputDir.appendingPathComponent("frames")
        let frameCount = try PNGFrameWriter.writeFrames(pixels, to: frameDir)

        return Result(
            frameDirectory: frameDir, frameCount: frameCount,
            inputSize: (width, height), outputSize: (outWidth, outHeight))
    }

    /// `native-upscale --mode hd`: real native IC-LoRA restoration —
    /// fuses the actual `ltx2.3-video-restoration-general` +
    /// `ltx2.3-ic-video-upscale-general` LoRAs (see mlx-models/lora/
    /// ltx-2.3-restore/README.md) into the distilled transformer via
    /// LoRAFusion.swift (the same mechanism `NativeI2VStage`'s `--lora`
    /// already uses), VAE-encodes `inputFrameDirectory` as IC-LoRA
    /// REFERENCE conditioning (appended, always-preserved tokens the
    /// generation attends to — VideoConditionByReferenceLatent.swift, real
    /// parity-tested port of `ltx_core_mlx.conditioning.types
    /// .reference_video_cond.VideoConditionByReferenceLatent`), and runs a
    /// full noise-to-clean denoise (DISTILLED_SIGMAS) at the REFERENCE's
    /// own resolution — a restoration/deartifact pass, not a resolution
    /// increase.
    ///
    /// Deliberately scoped narrower than the vendor `ICLoraPipeline`
    /// (PLAN.md's "Research: native spatial upscaling"): the vendor runs
    /// this as HALF-resolution Stage 1 of a two-stage pipeline (Stage 2
    /// upscales 2x + refines, LoRA removed). This method IS the real
    /// LoRA-fused, reference-conditioned restoration technique — just
    /// single-stage, at the reference's own resolution. `native-upscale
    /// --mode hd`'s CLI command chains this method's output through
    /// `generate()` (the already-verified, already-native 2x
    /// LatentUpsampler) to get the actual resolution increase, instead of
    /// the vendor's bit-exact Stage 2. Not a claim of output-identical
    /// parity with `ltx-video upscale`'s run.py-bridged IC-LoRA path — a
    /// different, real, fully-native composition of the same underlying
    /// LoRA + reference-conditioning mechanism.
    ///
    /// UNVERIFIED against a real checkpoint as of introduction: the two
    /// restoration LoRA `.safetensors` files are user-downloaded, gitignored
    /// external binaries (see mlx-models/lora/ltx-2.3-restore/README.md) not
    /// present in this development environment. `VideoConditionByReferenceLatent`
    /// itself IS real-checkpoint-free numerically parity-tested (bit-exact
    /// vs the vendor Python reference, see VideoConditionByReferenceLatentParityTests
    /// / scripts/dump_reference_conditioning.py) — only the end-to-end
    /// generation quality (LoRA fusion correctness + reference-attention
    /// behavior in a real forward pass) is unverified. A visual-inspection
    /// pass with the real LoRA files is the natural next step, matching
    /// this package's established practice (see NativeUpscaleStage's own
    /// milestone note on the color-fringing bug shape/finite checks alone
    /// didn't catch).
    public func generateHD(
        inputFrameDirectory: URL, outputDir: URL, prompt: String, audioURL: URL,
        fps: Double = 24.0, textMaxLength: Int = 128, seed: UInt64 = 42,
        restorationLoraURL: URL? = nil, upscaleLoraURL: URL? = nil,
        restorationLoraStrength: Float = 1.0, upscaleLoraStrength: Float = 1.0
    ) throws -> Result {
        let fm = FileManager.default
        let frameFiles = (try fm.contentsOfDirectory(atPath: inputFrameDirectory.path))
            .filter { $0.hasPrefix("frame_") && $0.hasSuffix(".png") }
            .sorted()
        guard !frameFiles.isEmpty else {
            throw StageError.noFramesFound(inputFrameDirectory)
        }

        print("[1/5] Loading \(frameFiles.count) reference frames...")
        var frameArrays: [MLXArray] = []
        var width = 0, height = 0
        for file in frameFiles {
            let url = inputFrameDirectory.appendingPathComponent(file)
            guard let cgImage = FrameLoad.loadCGImage(from: url) else { continue }
            let arr = FrameLoad.toArray(cgImage)  // (1, 3, H, W) [0, 1]
            width = arr.dim(3); height = arr.dim(2)
            frameArrays.append(arr)
        }
        guard !frameArrays.isEmpty else {
            throw StageError.noFramesFound(inputFrameDirectory)
        }
        let stacked = MLX.stacked(frameArrays.map { $0[0] }, axis: 1)  // (3, F, H, W)
        let pixelsBCFHW = (stacked.asType(.float32) * 2.0 - 1.0).expandedDimensions(axis: 0)

        print("[2/5] VideoEncoder: encoding reference video to latent (IC-LoRA conditioning)...")
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        guard fm.fileExists(atPath: vaeEncoderURL.path) else {
            throw StageError.videoEncoderCheckpointNotFound(vaeEncoderURL)
        }
        let encRaw = try MLX.loadArrays(url: vaeEncoderURL)
        var encWeights: [String: MLXArray] = [:]
        for (key, value) in encRaw {
            let stripped = key.hasPrefix("vae_encoder.") ? String(key.dropFirst("vae_encoder.".count)) : key
            encWeights[stripped] = value.asType(.float32)
        }
        let videoEncoder = VideoEncoder(weights: encWeights)
        let referenceLatentRaw = videoEncoder(pixelsBCFHW)  // (1, 128, Fr, Hr, Wr), normalized
        MLX.eval(referenceLatentRaw)
        let (referenceTokens, dims) = VideoLatentPatchifier.patchify(referenceLatentRaw)
        let positions = Positions.computeVideoPositions(numFrames: dims.f, height: dims.h, width: dims.w, frameRate: Float(fps))
        let genTokenCount = dims.f * dims.h * dims.w

        print("[3/5] LoRA: loading + fusing restoration + upscale IC-LoRA into distilled transformer...")
        let restorationURL = restorationLoraURL ?? RepoPaths.mlxModelsRoot.appendingPathComponent("lora/ltx-2.3-restore/ltx2.3-video-restoration-general.safetensors")
        let upscaleURL = upscaleLoraURL ?? RepoPaths.mlxModelsRoot.appendingPathComponent("lora/ltx-2.3-restore/ltx2.3-ic-video-upscale-general.safetensors")
        guard fm.fileExists(atPath: restorationURL.path) else {
            throw StageError.restorationLoraNotFound(restorationURL)
        }
        guard fm.fileExists(atPath: upscaleURL.path) else {
            throw StageError.upscaleLoraNotFound(upscaleURL)
        }
        let loraSources: [(weights: LoRAWeights, strength: Float)] = [
            (weights: try LoRAWeights.load(url: restorationURL), strength: restorationLoraStrength),
            (weights: try LoRAWeights.load(url: upscaleURL), strength: upscaleLoraStrength),
        ]

        print("[4/5] denoise: LoRA-fused 48-block distilled transformer, IC-LoRA reference conditioning...")
        let noise = MLXRandom.normal([1, genTokenCount, 128], key: MLXRandom.key(seed))
        let baseVideoState = LatentState(
            latent: noise, cleanLatent: MLXArray.zeros([1, genTokenCount, 128]),
            denoiseMask: MLXArray.ones([1, genTokenCount, 1]), positions: positions)
        let videoState = VideoConditionByReferenceLatent(
            referenceLatent: referenceTokens, referencePositions: positions,
            downscaleFactor: 1, strength: 1.0
        ).apply(to: baseVideoState)

        // Preserve the existing audio track fully (denoiseMask=0 everywhere)
        // — same mechanism `refine()` uses for the same reason (see this
        // file's header): the joint audio-video transformer needs a valid
        // audio branch to attend to.
        let wav = try WAVReader.read(url: audioURL)
        var channels = wav.channels
        if channels.count == 1 { channels = [channels[0], channels[0]] }
        channels = Array(channels.prefix(2))
        let resampled = channels.map { LinearResampler.resample($0, fromRate: wav.sampleRate, toRate: 16000) }
        let minLen = resampled.map(\.count).min() ?? 0
        let waveform = MLX.stacked(resampled.map { MLXArray($0.prefix(minLen)) }, axis: 0)  // (2, T)

        let audioEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        guard fm.fileExists(atPath: audioEncoderURL.path) else {
            throw StageError.audioEncoderCheckpointNotFound(audioEncoderURL)
        }
        let audioEncoder = try AudioVAEEncoderLoader.loadReal(checkpointURL: audioEncoderURL)
        let mel = AudioProcessor().waveformToMel(waveform).expandedDimensions(axis: 0)  // (1, 2, T', 64)
        let audioLatent = audioEncoder(mel)  // (1, 8, T, 16)
        MLX.eval(audioLatent)
        let (audioTokens, audioTokenCount) = AudioPatchifier.patchify(audioLatent)
        let audioState = LatentState(
            latent: audioTokens, cleanLatent: audioTokens,
            denoiseMask: MLXArray.zeros([1, audioTokenCount, 1]),
            positions: Positions.computeAudioPositions(numTokens: audioTokenCount))

        let textStage = NativeTextEncodeStage(maxLength: textMaxLength)
        let textResult = try textStage.encode(prompt)

        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        guard fm.fileExists(atPath: transformerURL.path) else {
            throw StageError.transformerCheckpointNotFound(transformerURL)
        }
        let rawTransformer = try MLX.loadArrays(url: transformerURL)
        var strippedTransformer: [String: MLXArray] = [:]
        for (key, value) in rawTransformer {
            guard key.hasPrefix("transformer.") else { continue }
            strippedTransformer[String(key.dropFirst("transformer.".count))] = value
        }

        let numLayers = 48
        let cfg = distilledConfig(numLayers: numLayers)
        let model = TransformerCheckpointLoader.makeModel(
            TransformerCheckpointLoader.topLevelWeights(raw: strippedTransformer, loraSources: loraSources),
            config: cfg, transformerBlocks: [])

        let denoiseResult = DenoiseLoop.runStreaming(
            model: model, numLayers: numLayers,
            blockProvider: { idx in
                TransformerCheckpointLoader.makeBlock(
                    TransformerCheckpointLoader.blockWeights(raw: strippedTransformer, blockIndex: idx, loraSources: loraSources),
                    config: cfg)
            },
            videoState: videoState, audioState: audioState,
            videoTextEmbeds: textResult.videoEmbeds, audioTextEmbeds: textResult.audioEmbeds,
            sigmas: SigmaSchedule.distilledSigmas)
        MLX.eval(denoiseResult.videoLatent)

        // Extract only the generation tokens (drop the appended reference tokens).
        let genTokens = denoiseResult.videoLatent[0..., 0..<genTokenCount, 0...]
        let restoredLatent = VideoLatentPatchifier.unpatchify(genTokens, dims: dims)

        print("[5/5] VideoDecoder: decoding restored latent to \(width)x\(height) frames...")
        let videoDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        guard fm.fileExists(atPath: videoDecoderURL.path) else {
            throw StageError.videoDecoderCheckpointNotFound(videoDecoderURL)
        }
        let videoDecoder = try VideoDecoderLoader.loadReal(checkpointURL: videoDecoderURL)
        let pixels = videoDecoder(restoredLatent.asType(.float32))  // (1, 3, F, H, W), [-1, 1]
        MLX.eval(pixels)

        let frameDir = outputDir.appendingPathComponent("frames")
        let frameCount = try PNGFrameWriter.writeFrames(pixels, to: frameDir)

        return Result(
            frameDirectory: frameDir, frameCount: frameCount,
            inputSize: (width, height), outputSize: (width, height))
    }

    /// `native-restyle`: V2V restyle — the "easiest, near-zero new
    /// preprocessing" application identified in PLAN.md's "Research: scoping
    /// the general IC-LoRA video-conditioning primitive" pass. Structurally
    /// identical to `generateHD` (VAE-encode the reference clip, fuse an
    /// IC-LoRA into the distilled transformer, denoise with
    /// `VideoConditionByReferenceLatent` reference conditioning, decode) but
    /// with the restoration-specific two-LoRA/two-stage structure removed:
    /// ONE style-transfer IC-LoRA, no upscale pairing, output at the
    /// reference's own resolution (no separate upscale chain — pipe through
    /// `generate()` afterward the same way `native-upscale --mode hd` does,
    /// if resolution increase is also wanted).
    ///
    /// Unlike `generateHD`'s restoration LoRA pair, there is no bundled
    /// default checkpoint under `mlx-models/lora/` for this — `loraURL` is
    /// REQUIRED (a user-supplied V2V-style IC-LoRA `.safetensors`, e.g. a
    /// Lightricks or community style-transfer adapter). UNVERIFIED against a
    /// real checkpoint as of introduction, same caveat as `generateHD`.
    public func generateRestyle(
        inputFrameDirectory: URL, outputDir: URL, prompt: String, audioURL: URL,
        loraURL: URL, fps: Double = 24.0, textMaxLength: Int = 128, seed: UInt64 = 42,
        loraStrength: Float = 1.0
    ) throws -> Result {
        let fm = FileManager.default
        let frameFiles = (try fm.contentsOfDirectory(atPath: inputFrameDirectory.path))
            .filter { $0.hasPrefix("frame_") && $0.hasSuffix(".png") }
            .sorted()
        guard !frameFiles.isEmpty else {
            throw StageError.noFramesFound(inputFrameDirectory)
        }
        guard fm.fileExists(atPath: loraURL.path) else {
            throw StageError.restyleLoraNotFound(loraURL)
        }

        print("[1/5] Loading \(frameFiles.count) reference frames...")
        var frameArrays: [MLXArray] = []
        var width = 0, height = 0
        for file in frameFiles {
            let url = inputFrameDirectory.appendingPathComponent(file)
            guard let cgImage = FrameLoad.loadCGImage(from: url) else { continue }
            let arr = FrameLoad.toArray(cgImage)  // (1, 3, H, W) [0, 1]
            width = arr.dim(3); height = arr.dim(2)
            frameArrays.append(arr)
        }
        guard !frameArrays.isEmpty else {
            throw StageError.noFramesFound(inputFrameDirectory)
        }
        let stacked = MLX.stacked(frameArrays.map { $0[0] }, axis: 1)  // (3, F, H, W)
        let pixelsBCFHW = (stacked.asType(.float32) * 2.0 - 1.0).expandedDimensions(axis: 0)

        print("[2/5] VideoEncoder: encoding reference video to latent (IC-LoRA conditioning)...")
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        guard fm.fileExists(atPath: vaeEncoderURL.path) else {
            throw StageError.videoEncoderCheckpointNotFound(vaeEncoderURL)
        }
        let encRaw = try MLX.loadArrays(url: vaeEncoderURL)
        var encWeights: [String: MLXArray] = [:]
        for (key, value) in encRaw {
            let stripped = key.hasPrefix("vae_encoder.") ? String(key.dropFirst("vae_encoder.".count)) : key
            encWeights[stripped] = value.asType(.float32)
        }
        let videoEncoder = VideoEncoder(weights: encWeights)
        let referenceLatentRaw = videoEncoder(pixelsBCFHW)  // (1, 128, Fr, Hr, Wr), normalized
        MLX.eval(referenceLatentRaw)
        let (referenceTokens, dims) = VideoLatentPatchifier.patchify(referenceLatentRaw)
        let positions = Positions.computeVideoPositions(numFrames: dims.f, height: dims.h, width: dims.w, frameRate: Float(fps))
        let genTokenCount = dims.f * dims.h * dims.w

        print("[3/5] LoRA: loading + fusing restyle IC-LoRA into distilled transformer...")
        let loraSources: [(weights: LoRAWeights, strength: Float)] = [
            (weights: try LoRAWeights.load(url: loraURL), strength: loraStrength),
        ]

        print("[4/5] denoise: LoRA-fused 48-block distilled transformer, IC-LoRA reference conditioning...")
        let noise = MLXRandom.normal([1, genTokenCount, 128], key: MLXRandom.key(seed))
        let baseVideoState = LatentState(
            latent: noise, cleanLatent: MLXArray.zeros([1, genTokenCount, 128]),
            denoiseMask: MLXArray.ones([1, genTokenCount, 1]), positions: positions)
        let videoState = VideoConditionByReferenceLatent(
            referenceLatent: referenceTokens, referencePositions: positions,
            downscaleFactor: 1, strength: 1.0
        ).apply(to: baseVideoState)

        // Preserve the existing audio track fully (denoiseMask=0 everywhere)
        // — same mechanism generateHD/refine() use for the same reason (see
        // this file's header): the joint audio-video transformer needs a
        // valid audio branch to attend to.
        let wav = try WAVReader.read(url: audioURL)
        var channels = wav.channels
        if channels.count == 1 { channels = [channels[0], channels[0]] }
        channels = Array(channels.prefix(2))
        let resampled = channels.map { LinearResampler.resample($0, fromRate: wav.sampleRate, toRate: 16000) }
        let minLen = resampled.map(\.count).min() ?? 0
        let waveform = MLX.stacked(resampled.map { MLXArray($0.prefix(minLen)) }, axis: 0)  // (2, T)

        let audioEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        guard fm.fileExists(atPath: audioEncoderURL.path) else {
            throw StageError.audioEncoderCheckpointNotFound(audioEncoderURL)
        }
        let audioEncoder = try AudioVAEEncoderLoader.loadReal(checkpointURL: audioEncoderURL)
        let mel = AudioProcessor().waveformToMel(waveform).expandedDimensions(axis: 0)  // (1, 2, T', 64)
        let audioLatent = audioEncoder(mel)  // (1, 8, T, 16)
        MLX.eval(audioLatent)
        let (audioTokens, audioTokenCount) = AudioPatchifier.patchify(audioLatent)
        let audioState = LatentState(
            latent: audioTokens, cleanLatent: audioTokens,
            denoiseMask: MLXArray.zeros([1, audioTokenCount, 1]),
            positions: Positions.computeAudioPositions(numTokens: audioTokenCount))

        let textStage = NativeTextEncodeStage(maxLength: textMaxLength)
        let textResult = try textStage.encode(prompt)

        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        guard fm.fileExists(atPath: transformerURL.path) else {
            throw StageError.transformerCheckpointNotFound(transformerURL)
        }
        let rawTransformer = try MLX.loadArrays(url: transformerURL)
        var strippedTransformer: [String: MLXArray] = [:]
        for (key, value) in rawTransformer {
            guard key.hasPrefix("transformer.") else { continue }
            strippedTransformer[String(key.dropFirst("transformer.".count))] = value
        }

        let numLayers = 48
        let cfg = distilledConfig(numLayers: numLayers)
        let model = TransformerCheckpointLoader.makeModel(
            TransformerCheckpointLoader.topLevelWeights(raw: strippedTransformer, loraSources: loraSources),
            config: cfg, transformerBlocks: [])

        let denoiseResult = DenoiseLoop.runStreaming(
            model: model, numLayers: numLayers,
            blockProvider: { idx in
                TransformerCheckpointLoader.makeBlock(
                    TransformerCheckpointLoader.blockWeights(raw: strippedTransformer, blockIndex: idx, loraSources: loraSources),
                    config: cfg)
            },
            videoState: videoState, audioState: audioState,
            videoTextEmbeds: textResult.videoEmbeds, audioTextEmbeds: textResult.audioEmbeds,
            sigmas: SigmaSchedule.distilledSigmas)
        MLX.eval(denoiseResult.videoLatent)

        // Extract only the generation tokens (drop the appended reference tokens).
        let genTokens = denoiseResult.videoLatent[0..., 0..<genTokenCount, 0...]
        let restyledLatent = VideoLatentPatchifier.unpatchify(genTokens, dims: dims)

        print("[5/5] VideoDecoder: decoding restyled latent to \(width)x\(height) frames...")
        let videoDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        guard fm.fileExists(atPath: videoDecoderURL.path) else {
            throw StageError.videoDecoderCheckpointNotFound(videoDecoderURL)
        }
        let videoDecoder = try VideoDecoderLoader.loadReal(checkpointURL: videoDecoderURL)
        let pixels = videoDecoder(restyledLatent.asType(.float32))  // (1, 3, F, H, W), [-1, 1]
        MLX.eval(pixels)

        let frameDir = outputDir.appendingPathComponent("frames")
        let frameCount = try PNGFrameWriter.writeFrames(pixels, to: frameDir)

        return Result(
            frameDirectory: frameDir, frameCount: frameCount,
            inputSize: (width, height), outputSize: (width, height))
    }

    /// `native-ingredients`: one-or-more-reference-image IC-LoRA conditioning
    /// — the sibling "easy tier" item to `generateRestyle` from PLAN.md's
    /// IC-LoRA scoping research. Same reference-conditioning core
    /// (VAE-encode reference(s) -> fuse IC-LoRA -> `VideoConditionByReferenceLatent`
    /// -> denoise -> decode) but each "reference clip" is a SINGLE still
    /// image tiled across the full generation frame count, not a real
    /// multi-frame input clip. Confirmed against the reference ComfyUI
    /// graph's actual node links (docs/reference/comfyui_workflows/
    /// LTX-2.3_ICLoRA_Ingredients_Single_Stage_Distilled.json), not just its
    /// node names: `LoadImage` -> `CreateVideo` -> `GetVideoComponents` ->
    /// `ResizeImageMaskNode` -> `RepeatImageBatch`, where `RepeatImageBatch`'s
    /// `amount` and `EmptyLTXVLatentVideo`'s frame count are driven by the
    /// SAME `PrimitiveInt` node — i.e. each reference image is tiled to
    /// exactly the target generation length, not some fixed short window.
    /// `referenceImageURLs` accepts one or more images: each is
    /// independently tiled/VAE-encoded/patchified to the same (f, h, w)
    /// dims (they all share the same output resolution and frame count),
    /// and the resulting per-image token/position blocks are concatenated
    /// into one combined reference sequence before the single
    /// `VideoConditionByReferenceLatent` call, which APPENDS that combined
    /// sequence to the generation's own tokens (self-attention, not
    /// position-collision) — see docs/superpowers/specs/
    /// 2026-07-26-multi-reference-ingredients-design.md for the full design.
    ///
    /// Two deliberate deviations from a literal 1:1 port, both reusing
    /// existing primitives over adding new preprocessing:
    /// - Output resolution is caller-supplied `width`/`height` (through
    ///   `ResolutionResolver.optimize`, same as `NativeI2VStage`) with the
    ///   reference image fit via `FrameLoad.resizeAspectFillCenterCrop`
    ///   (already used for `--last-frame`), instead of porting
    ///   `ResizeImageMaskNode`'s "scale shorter dimension, lanczos" resize
    ///   algorithm — the reference graph derives its own output resolution
    ///   from the resized reference image's size, but that's a resize-mode
    ///   detail, not a new capability.
    /// - Audio is generated from scratch (denoiseMask=1, noise-to-clean),
    ///   NOT preserved from an existing track: the reference graph's
    ///   `LTXVEmptyLatentAudio` is itself denoised by `SamplerCustomAdvanced`
    ///   (a zero-init starting point, not a pass-through), matching
    ///   `NativeI2VStage`'s own default t2v audio path when no
    ///   `--audio-track` is given — so this reuses that same audio-decode
    ///   pipeline (`AudioVAEDecoder` + `VocoderWithBWE` + `WAVWriter`)
    ///   rather than `generateRestyle`'s preserved-input-track mechanism.
    ///
    /// No bundled default checkpoint under `mlx-models/lora/` — `loraURL` is
    /// REQUIRED (download `Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients` from
    /// HuggingFace, `ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors`).
    /// UNVERIFIED against a real checkpoint as of introduction, same caveat
    /// `generateRestyle` carries.
    public func generateIngredients(
        referenceImageURLs: [URL], outputDir: URL, prompt: String,
        loraURL: URL, width: Int, height: Int, seconds: Double = 5.0,
        fps: Double = 24.0, textMaxLength: Int = 128, seed: UInt64 = 42,
        loraStrength: Float = 1.0
    ) throws -> IngredientsResult {
        let fm = FileManager.default
        guard !referenceImageURLs.isEmpty else {
            throw StageError.noReferenceImages
        }
        // Deliberately a separate pass from the decode/encode loop below —
        // validates every reference path up front so a bad URL anywhere in
        // the list fails fast, before any expensive VAE-encode work starts
        // on the images that DO exist.
        for referenceImageURL in referenceImageURLs {
            guard fm.fileExists(atPath: referenceImageURL.path) else {
                throw StageError.referenceImageNotFound(referenceImageURL)
            }
        }
        guard fm.fileExists(atPath: loraURL.path) else {
            throw StageError.ingredientsLoraNotFound(loraURL)
        }
        guard width > 0, height > 0 else {
            throw StageError.invalidDimensions("width/height must be positive, got \(width)x\(height)")
        }
        let optimized = ResolutionResolver.optimize(width: width, height: height)
        let outW = optimized.width, outH = optimized.height

        // LTX frame counts must be 8k+1 (mirrors NativeI2VStage.Request.frames).
        let raw = seconds * fps
        let kFloor = max(1, Int(floor((raw - 1) / 8.0)))
        let kCeil = kFloor + 1
        let fFloor = 8 * kFloor + 1
        let fCeil = 8 * kCeil + 1
        let frames = abs(Double(fFloor) - raw) <= abs(Double(fCeil) - raw) ? fFloor : fCeil

        print("[1/6] Loading \(referenceImageURLs.count) reference image(s), tiling to \(frames) frames at \(outW)x\(outH)...")
        print("[2/6] VideoEncoder: encoding tiled reference image(s) to latent (IC-LoRA conditioning)...")
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        guard fm.fileExists(atPath: vaeEncoderURL.path) else {
            throw StageError.videoEncoderCheckpointNotFound(vaeEncoderURL)
        }
        let encRaw = try MLX.loadArrays(url: vaeEncoderURL)
        var encWeights: [String: MLXArray] = [:]
        for (key, value) in encRaw {
            let stripped = key.hasPrefix("vae_encoder.") ? String(key.dropFirst("vae_encoder.".count)) : key
            encWeights[stripped] = value.asType(.float32)
        }
        // Loaded once, reused for every reference image below — avoids
        // re-reading the same checkpoint off disk N times.
        let videoEncoder = VideoEncoder(weights: encWeights)

        // Each reference image is independently tiled to `frames` copies and
        // VAE-encoded/patchified; all N share identical (f, h, w) dims since
        // every image is resized to the same outW x outH and tiled to the
        // same frame count. The resulting per-image token blocks are
        // concatenated into one combined reference-token sequence that
        // VideoConditionByReferenceLatent APPENDS to the generation's own
        // tokens (self-attention, not position-collision — see this
        // function's header / docs/superpowers/specs/
        // 2026-07-26-multi-reference-ingredients-design.md).
        var referenceTokenChunks: [MLXArray] = []
        var dims: (f: Int, h: Int, w: Int) = (0, 0, 0)
        for referenceImageURL in referenceImageURLs {
            guard var cgImage = FrameLoad.loadCGImage(from: referenceImageURL) else {
                throw StageError.referenceImageNotFound(referenceImageURL)
            }
            if cgImage.width != outW || cgImage.height != outH {
                cgImage = FrameLoad.resizeAspectFillCenterCrop(cgImage, targetWidth: outW, targetHeight: outH)
            }
            let framePixels01 = FrameLoad.toArray(cgImage)  // (1, 3, H, W) [0, 1]
            let singleFrame = (framePixels01.asType(.float32) * 2.0 - 1.0)[0]  // (3, H, W)
            let stacked = MLX.stacked(Array(repeating: singleFrame, count: frames), axis: 1)  // (3, F, H, W)
            let pixelsBCFHW = stacked.expandedDimensions(axis: 0)  // (1, 3, F, H, W)

            let referenceLatentRaw = videoEncoder(pixelsBCFHW)  // (1, 128, Fr, Hr, Wr), normalized
            MLX.eval(referenceLatentRaw)
            let (tokens, imageDims) = VideoLatentPatchifier.patchify(referenceLatentRaw)
            dims = imageDims
            referenceTokenChunks.append(tokens)
        }
        let referenceTokens = MLX.concatenated(referenceTokenChunks, axis: 1)
        let positions = Positions.computeVideoPositions(numFrames: dims.f, height: dims.h, width: dims.w, frameRate: Float(fps))
        // Every reference's positions are value-identical to `positions`
        // (same formula, same dims) — repeat rather than recompute per image.
        let referencePositions = MLX.concatenated(Array(repeating: positions, count: referenceTokenChunks.count), axis: 1)
        let genTokenCount = dims.f * dims.h * dims.w

        print("[3/6] LoRA: loading + fusing Ingredients IC-LoRA into distilled transformer...")
        let loraSources: [(weights: LoRAWeights, strength: Float)] = [
            (weights: try LoRAWeights.load(url: loraURL), strength: loraStrength),
        ]

        print("[4/6] denoise: LoRA-fused 48-block distilled transformer, IC-LoRA reference conditioning...")
        let noise = MLXRandom.normal([1, genTokenCount, 128], key: MLXRandom.key(seed))
        let baseVideoState = LatentState(
            latent: noise, cleanLatent: MLXArray.zeros([1, genTokenCount, 128]),
            denoiseMask: MLXArray.ones([1, genTokenCount, 1]), positions: positions)
        let videoState = VideoConditionByReferenceLatent(
            referenceLatent: referenceTokens, referencePositions: referencePositions,
            downscaleFactor: 1, strength: 1.0
        ).apply(to: baseVideoState)

        // Audio generated from scratch — see this method's header for why
        // (mirrors NativeI2VStage's default t2v audio path).
        let numAudioTokens = Positions.computeAudioTokenCount(numVideoFrames: frames, frameRate: Float(fps))
        let audioNoise = MLXRandom.normal([1, numAudioTokens, 128], key: MLXRandom.key(seed &+ 1))
        let audioState = LatentState(
            latent: audioNoise, cleanLatent: audioNoise,
            denoiseMask: MLXArray.ones([1, numAudioTokens, 1]),
            positions: Positions.computeAudioPositions(numTokens: numAudioTokens))

        let textStage = NativeTextEncodeStage(maxLength: textMaxLength)
        let textResult = try textStage.encode(prompt)

        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        guard fm.fileExists(atPath: transformerURL.path) else {
            throw StageError.transformerCheckpointNotFound(transformerURL)
        }
        let rawTransformer = try MLX.loadArrays(url: transformerURL)
        var strippedTransformer: [String: MLXArray] = [:]
        for (key, value) in rawTransformer {
            guard key.hasPrefix("transformer.") else { continue }
            strippedTransformer[String(key.dropFirst("transformer.".count))] = value
        }

        let numLayers = 48
        let cfg = distilledConfig(numLayers: numLayers)
        let model = TransformerCheckpointLoader.makeModel(
            TransformerCheckpointLoader.topLevelWeights(raw: strippedTransformer, loraSources: loraSources),
            config: cfg, transformerBlocks: [])

        let denoiseResult = DenoiseLoop.runStreaming(
            model: model, numLayers: numLayers,
            blockProvider: { idx in
                TransformerCheckpointLoader.makeBlock(
                    TransformerCheckpointLoader.blockWeights(raw: strippedTransformer, blockIndex: idx, loraSources: loraSources),
                    config: cfg)
            },
            videoState: videoState, audioState: audioState,
            videoTextEmbeds: textResult.videoEmbeds, audioTextEmbeds: textResult.audioEmbeds,
            sigmas: SigmaSchedule.distilledSigmas)
        MLX.eval(denoiseResult.videoLatent, denoiseResult.audioLatent)

        // Extract only the generation tokens (drop the appended reference tokens).
        let genTokens = denoiseResult.videoLatent[0..., 0..<genTokenCount, 0...]
        let generatedLatent = VideoLatentPatchifier.unpatchify(genTokens, dims: dims)

        print("[5/6] VideoDecoder: decoding generated latent to \(outW)x\(outH) frames...")
        let videoDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        guard fm.fileExists(atPath: videoDecoderURL.path) else {
            throw StageError.videoDecoderCheckpointNotFound(videoDecoderURL)
        }
        let videoDecoder = try VideoDecoderLoader.loadReal(checkpointURL: videoDecoderURL)
        let pixels = videoDecoder(generatedLatent.asType(.float32))  // (1, 3, F, H, W), [-1, 1]
        MLX.eval(pixels)

        let frameDir = outputDir.appendingPathComponent("frames")
        let frameCount = try PNGFrameWriter.writeFrames(pixels, to: frameDir)

        print("[6/6] AudioVAEDecoder + VocoderWithBWE: decoding generated audio...")
        let audioLatentB8T16 = AudioPatchifier.unpatchify(denoiseResult.audioLatent)
        let audioDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        guard fm.fileExists(atPath: audioDecoderURL.path) else {
            throw StageError.audioEncoderCheckpointNotFound(audioDecoderURL)
        }
        let audioDecoder = try AudioVAEDecoderLoader.loadReal(checkpointURL: audioDecoderURL)
        let mel = audioDecoder(audioLatentB8T16.asType(.float32))  // (1, 2, T', 64)
        MLX.eval(mel)

        let vocoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/vocoder.safetensors")
        let vocoder = try VocoderWithBWELoader.loadReal(checkpointURL: vocoderURL)
        let waveform = vocoder(mel)  // (1, 2, T_audio), [-1, 1]
        MLX.eval(waveform)

        let numChannels = waveform.dim(1)
        var channels: [[Float]] = []
        for c in 0..<numChannels {
            channels.append(waveform[0, c, 0...].asArray(Float.self))
        }
        let audioURL = outputDir.appendingPathComponent("audio.wav")
        try WAVWriter.write(channels: channels, sampleRate: 48000, to: audioURL)

        return IngredientsResult(
            frameDirectory: frameDir, frameCount: frameCount,
            outputSize: (outW, outH), audioURL: audioURL)
    }

    /// `native-lipdub`: reference-video lip-dubbing via the LipDub IC-LoRA —
    /// port of Python's `video lipdub` (`app/commands/video-lipdub.py` +
    /// `ltx_pipelines_mlx.lipdub.LipDubPipeline`). The reference video
    /// supplies BOTH the visual structure (IC-LoRA video-reference
    /// conditioning, reapplied at both stages, LoRA fused through both) and
    /// the target speech (its own audio track, reference-conditioned via
    /// `AudioConditionByReferenceLatent`, frozen after stage 1).
    /// See docs/superpowers/specs/2026-07-26-swift-lipdub-port-design.md for
    /// the full architecture discovery — this is NOT a composition of
    /// `generateHD`+`refine()` (neither of those reapplies LoRA/reference
    /// conditioning at their second stage the way LipDub genuinely needs).
    ///
    /// Frame count is derived from the reference video itself (snapped down
    /// to the nearest 8k+1), not user-specified. Width/height are snapped to
    /// the nearest multiple of 64 (not just 32, unlike `ResolutionResolver
    /// .optimize`) so that `width/2`/`height/2` stay valid 32-multiple VAE
    /// resolutions for stage 1.
    public func generateLipdub(
        referenceVideoURL: URL, outputDir: URL, prompt: String,
        loraURL: URL, width: Int = 640, height: Int = 960,
        referenceStrength: Float = 1.0, loraStrength: Float = 1.0,
        textMaxLength: Int = 128, seed: UInt64 = 42
    ) throws -> LipdubResult {
        let fm = FileManager.default
        guard fm.fileExists(atPath: referenceVideoURL.path) else {
            throw StageError.referenceVideoNotFound(referenceVideoURL)
        }
        // Audio-track check BEFORE the LoRA check — matches Python's
        // run_lipdub() order (app/commands/video-lipdub.py): the reference
        // video's own audio is the more fundamental precondition (LipDub's
        // whole premise), so it's validated first regardless of whether a
        // LoRA path was even supplied correctly.
        let referenceInfo = try VideoProbe.info(url: referenceVideoURL)
        guard referenceInfo.hasAudioTrack else {
            throw StageError.referenceVideoNoAudioTrack(referenceVideoURL)
        }
        guard fm.fileExists(atPath: loraURL.path) else {
            throw StageError.lipdubLoraNotFound(loraURL)
        }
        guard width > 0, height > 0 else {
            throw StageError.invalidDimensions("width/height must be positive, got \(width)x\(height)")
        }

        func snapTo64(_ v: Int) -> Int { max(64, Int((Double(v) / 64.0).rounded()) * 64) }
        let outW = snapTo64(width), outH = snapTo64(height)
        let halfW = outW / 2, halfH = outH / 2

        let fps = referenceInfo.fps
        // NOT referenceInfo.frameCount — VideoProbe.info's frameCount is
        // derived from the CONTAINER's overall duration
        // (asset.duration.seconds), which is driven by whichever track
        // (video or audio) runs longer, not specifically the video track.
        // A reference clip whose independently-generated audio track (e.g.
        // TTS speech muxed onto a still/short video) outruns its video
        // track would silently overcount frames here, and
        // loadReferenceVideoFrames would then duplicate the last real video
        // frame into the "extra" slots. videoTrackFrameCount below reads
        // the video TRACK's own timeRange duration instead.
        let rawFrameCount = try videoTrackFrameCount(url: referenceVideoURL, fps: fps)
        let numFrames = max(1, ((rawFrameCount - 1) / 8) * 8 + 1)
        print("[1/8] Reference video: \(rawFrameCount) frames at \(fps) fps -> \(numFrames) frames (8k+1 snap)")

        print("[2/8] VideoAudioReader: extracting reference video's own audio track...")
        let refWav = try VideoAudioReader.read(url: referenceVideoURL)
        var refChannels = refWav.channels
        if refChannels.count == 1 { refChannels = [refChannels[0], refChannels[0]] }
        refChannels = Array(refChannels.prefix(2))
        let refResampled = refChannels.map { LinearResampler.resample($0, fromRate: refWav.sampleRate, toRate: 16000) }
        let refMinLen = refResampled.map(\.count).min() ?? 0
        let refWaveform = MLX.stacked(refResampled.map { MLXArray($0.prefix(refMinLen)) }, axis: 0)  // (2, T)

        let audioEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        guard fm.fileExists(atPath: audioEncoderURL.path) else {
            throw StageError.audioEncoderCheckpointNotFound(audioEncoderURL)
        }
        let audioEncoder = try AudioVAEEncoderLoader.loadReal(checkpointURL: audioEncoderURL)
        let refMel = AudioProcessor().waveformToMel(refWaveform).expandedDimensions(axis: 0)  // (1, 2, T', 64)
        let refAudioLatent = audioEncoder(refMel)  // (1, 8, T, 16)
        MLX.eval(refAudioLatent)
        let (refAudioTokens, refAudioTokenCount) = AudioPatchifier.patchify(refAudioLatent)
        let refAudioPositionsRaw = Positions.computeAudioPositions(numTokens: refAudioTokenCount)
        let audioRefCond = AudioConditionByReferenceLatent(
            referenceLatent: refAudioTokens, referencePositions: refAudioPositionsRaw,
            strength: 1.0, negativePositions: true)

        print("[3/8] VideoEncoder: loading (reused across both stages)...")
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        guard fm.fileExists(atPath: vaeEncoderURL.path) else {
            throw StageError.videoEncoderCheckpointNotFound(vaeEncoderURL)
        }
        let encRaw = try MLX.loadArrays(url: vaeEncoderURL)
        var encWeights: [String: MLXArray] = [:]
        for (key, value) in encRaw {
            let stripped = key.hasPrefix("vae_encoder.") ? String(key.dropFirst("vae_encoder.".count)) : key
            encWeights[stripped] = value.asType(.float32)
        }
        let videoEncoder = VideoEncoder(weights: encWeights)

        print("[4/8] LoRA + transformer: loading LipDub IC-LoRA (fused for both stages)...")
        let loraSources: [(weights: LoRAWeights, strength: Float)] = [
            (weights: try LoRAWeights.load(url: loraURL), strength: loraStrength),
        ]

        let textStage = NativeTextEncodeStage(maxLength: textMaxLength)
        let textResult = try textStage.encode(prompt)

        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        guard fm.fileExists(atPath: transformerURL.path) else {
            throw StageError.transformerCheckpointNotFound(transformerURL)
        }
        let rawTransformer = try MLX.loadArrays(url: transformerURL)
        var strippedTransformer: [String: MLXArray] = [:]
        for (key, value) in rawTransformer {
            guard key.hasPrefix("transformer.") else { continue }
            strippedTransformer[String(key.dropFirst("transformer.".count))] = value
        }
        let numLayers = 48
        let cfg = distilledConfig(numLayers: numLayers)
        let model = TransformerCheckpointLoader.makeModel(
            TransformerCheckpointLoader.topLevelWeights(raw: strippedTransformer, loraSources: loraSources),
            config: cfg, transformerBlocks: [])
        let blockProvider: (Int) -> BasicAVTransformerBlock = { idx in
            TransformerCheckpointLoader.makeBlock(
                TransformerCheckpointLoader.blockWeights(raw: strippedTransformer, blockIndex: idx, loraSources: loraSources),
                config: cfg)
        }

        // ===== Stage 1 (half-res) =====
        print("[5/8] Stage 1: half-res (\(halfW)x\(halfH)) IC-LoRA reference-conditioned denoise...")
        let stage1Pixels = try loadReferenceVideoFrames(url: referenceVideoURL, numFrames: numFrames, width: halfW, height: halfH)
        let stage1RefLatentRaw = videoEncoder(stage1Pixels)
        MLX.eval(stage1RefLatentRaw)
        let (stage1RefTokens, stage1Dims) = VideoLatentPatchifier.patchify(stage1RefLatentRaw)
        let stage1Positions = Positions.computeVideoPositions(numFrames: stage1Dims.f, height: stage1Dims.h, width: stage1Dims.w, frameRate: Float(fps))
        let stage1GenTokenCount = stage1Dims.f * stage1Dims.h * stage1Dims.w

        let stage1Noise = MLXRandom.normal([1, stage1GenTokenCount, 128], key: MLXRandom.key(seed))
        let stage1BaseVideoState = LatentState(
            latent: stage1Noise, cleanLatent: MLXArray.zeros([1, stage1GenTokenCount, 128]),
            denoiseMask: MLXArray.ones([1, stage1GenTokenCount, 1]), positions: stage1Positions)
        let stage1VideoState = VideoConditionByReferenceLatent(
            referenceLatent: stage1RefTokens, referencePositions: stage1Positions,
            downscaleFactor: 1, strength: referenceStrength
        ).apply(to: stage1BaseVideoState)

        let stage1AudioNoise = MLXRandom.normal([1, refAudioTokenCount, 128], key: MLXRandom.key(seed &+ 1))
        let stage1BaseAudioState = LatentState(
            latent: stage1AudioNoise, cleanLatent: MLXArray.zeros([1, refAudioTokenCount, 128]),
            denoiseMask: MLXArray.ones([1, refAudioTokenCount, 1]),
            positions: Positions.computeAudioPositions(numTokens: refAudioTokenCount))
        let stage1AudioState = audioRefCond.apply(to: stage1BaseAudioState)

        let stage1Result = DenoiseLoop.runStreaming(
            model: model, numLayers: numLayers, blockProvider: blockProvider,
            videoState: stage1VideoState, audioState: stage1AudioState,
            videoTextEmbeds: textResult.videoEmbeds, audioTextEmbeds: textResult.audioEmbeds,
            sigmas: SigmaSchedule.distilledSigmas)
        MLX.eval(stage1Result.videoLatent, stage1Result.audioLatent)

        let stage1GenVideoTokens = stage1Result.videoLatent[0..., 0..<stage1GenTokenCount, 0...]
        let stage1AudioOutputTokens = stage1Result.audioLatent[0..., 0..<refAudioTokenCount, 0...]

        // ===== Upscale =====
        print("[6/8] LatentUpsampler: 2x spatial upscale...")
        let upsamplerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors")
        guard fm.fileExists(atPath: upsamplerURL.path) else {
            throw StageError.upsamplerCheckpointNotFound(upsamplerURL)
        }
        let upRaw = try MLX.loadArrays(url: upsamplerURL)
        let upPrefix = "spatial_upscaler_x2_v1_1."
        var upWeights: [String: MLXArray] = [:]
        for (key, value) in upRaw {
            let stripped = key.hasPrefix(upPrefix) ? String(key.dropFirst(upPrefix.count)) : key
            upWeights[stripped] = value.asType(.float32)
        }
        let upsampler = LatentUpsampler(weights: upWeights)

        let stage1VideoLatent = VideoLatentPatchifier.unpatchify(stage1GenVideoTokens, dims: stage1Dims)
        let meanC = videoEncoder.meanOfMeans.reshaped([1, -1, 1, 1, 1])
        let stdC = videoEncoder.stdOfMeans.reshaped([1, -1, 1, 1, 1])
        let denormLatent = stage1VideoLatent * stdC + meanC
        let upscaledDenorm = upsampler(denormLatent)
        let upscaledLatent = (upscaledDenorm - meanC) / stdC
        MLX.eval(upscaledLatent)

        // ===== Stage 2 (full-res) =====
        print("[7/8] Stage 2: full-res (\(outW)x\(outH)) IC-LoRA reference-conditioned refine, audio frozen...")
        let stage2Pixels = try loadReferenceVideoFrames(url: referenceVideoURL, numFrames: numFrames, width: outW, height: outH)
        let stage2RefLatentRaw = videoEncoder(stage2Pixels)
        MLX.eval(stage2RefLatentRaw)
        let (stage2RefTokens, stage2Dims) = VideoLatentPatchifier.patchify(stage2RefLatentRaw)
        let stage2Positions = Positions.computeVideoPositions(numFrames: stage2Dims.f, height: stage2Dims.h, width: stage2Dims.w, frameRate: Float(fps))
        let stage2GenTokenCount = stage2Dims.f * stage2Dims.h * stage2Dims.w

        let (stage2VideoTokensUp, upDims) = VideoLatentPatchifier.patchify(upscaledLatent)
        guard upDims.f == stage2Dims.f, upDims.h == stage2Dims.h, upDims.w == stage2Dims.w else {
            throw StageError.invalidDimensions("upscaled latent dims \(upDims) do not match stage-2 reference dims \(stage2Dims) — width/height must be a multiple of 64")
        }

        let sigmas2 = SigmaSchedule.stage2Sigmas
        let startSigma2 = sigmas2[0]
        let stage2VideoNoise = MLXRandom.normal(stage2VideoTokensUp.shape, key: MLXRandom.key(seed &+ 2))
        let stage2NoisyVideoTokens = (1 - startSigma2) * stage2VideoTokensUp + startSigma2 * stage2VideoNoise
        let stage2BaseVideoState = LatentState(
            latent: stage2NoisyVideoTokens, cleanLatent: stage2NoisyVideoTokens,
            denoiseMask: MLXArray.ones([1, stage2GenTokenCount, 1]), positions: stage2Positions)
        let stage2VideoState = VideoConditionByReferenceLatent(
            referenceLatent: stage2RefTokens, referencePositions: stage2Positions,
            downscaleFactor: 1, strength: referenceStrength
        ).apply(to: stage2BaseVideoState)

        // Audio frozen through stage 2: sigma=0 (no-op Euler steps) starting
        // from stage 1's own audio output — matches Python's frozen=True.
        let stage2BaseAudioState = LatentState(
            latent: stage1AudioOutputTokens, cleanLatent: stage1AudioOutputTokens,
            denoiseMask: MLXArray.zeros([1, refAudioTokenCount, 1]),
            positions: Positions.computeAudioPositions(numTokens: refAudioTokenCount))
        let stage2AudioState = audioRefCond.apply(to: stage2BaseAudioState)

        let stage2Result = DenoiseLoop.runStreaming(
            model: model, numLayers: numLayers, blockProvider: blockProvider,
            videoState: stage2VideoState, audioState: stage2AudioState,
            videoTextEmbeds: textResult.videoEmbeds, audioTextEmbeds: textResult.audioEmbeds,
            sigmas: sigmas2)
        MLX.eval(stage2Result.videoLatent)

        let stage2GenVideoTokens = stage2Result.videoLatent[0..., 0..<stage2GenTokenCount, 0...]
        let finalVideoLatent = VideoLatentPatchifier.unpatchify(stage2GenVideoTokens, dims: stage2Dims)

        print("[8/8] Decoding: video from stage 2, audio from stage 1 (frozen, not re-denoised)...")
        let videoDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        guard fm.fileExists(atPath: videoDecoderURL.path) else {
            throw StageError.videoDecoderCheckpointNotFound(videoDecoderURL)
        }
        let videoDecoder = try VideoDecoderLoader.loadReal(checkpointURL: videoDecoderURL)
        let pixels = videoDecoder(finalVideoLatent.asType(.float32))
        MLX.eval(pixels)

        let frameDir = outputDir.appendingPathComponent("frames")
        let frameCount = try PNGFrameWriter.writeFrames(pixels, to: frameDir)

        let audioLatentB8T16 = AudioPatchifier.unpatchify(stage1AudioOutputTokens)
        let audioDecoder = try AudioVAEDecoderLoader.loadReal(checkpointURL: audioEncoderURL)
        let decodedMel = audioDecoder(audioLatentB8T16.asType(.float32))
        MLX.eval(decodedMel)

        let vocoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/vocoder.safetensors")
        let vocoder = try VocoderWithBWELoader.loadReal(checkpointURL: vocoderURL)
        let outWaveform = vocoder(decodedMel)
        MLX.eval(outWaveform)

        let numOutChannels = outWaveform.dim(1)
        var outChannels: [[Float]] = []
        for c in 0..<numOutChannels {
            outChannels.append(outWaveform[0, c, 0...].asArray(Float.self))
        }
        let audioOutURL = outputDir.appendingPathComponent("audio.wav")
        try WAVWriter.write(channels: outChannels, sampleRate: 48000, to: audioOutURL)

        return LipdubResult(frameDirectory: frameDir, frameCount: frameCount, outputSize: (outW, outH), audioURL: audioOutURL, fps: fps)
    }

    /// The video TRACK's own frame count, derived from its `timeRange
    /// .duration` — deliberately NOT `VideoProbe.info(url:).frameCount`
    /// (that field is derived from the CONTAINER's overall
    /// `asset.duration.seconds`, which reflects whichever track, video or
    /// audio, runs longer). Kept local to this file rather than changed on
    /// `VideoProbe` itself, since `VideoProbe`'s existing `frameCount`
    /// semantics are relied on by other callers (e.g. `VideoGate`/scene
    /// detection) that this fix must not affect.
    private func videoTrackFrameCount(url: URL, fps: Double) throws -> Int {
        let asset = AVURLAsset(url: url)
        guard let videoTrack = asset.tracks(withMediaType: .video).first else {
            throw StageError.referenceVideoNotFound(url)
        }
        let videoDuration = videoTrack.timeRange.duration.seconds
        return max(1, Int((videoDuration * fps).rounded()))
    }

    /// Extracts exactly `numFrames` frames from `url` (spaced by `1/fps`,
    /// the video's own frame rate), resized to `(width, height)` — the
    /// reference-video counterpart to `generateRestyle`'s PNG-directory
    /// loading loop, sourcing frames directly from an mp4 instead.
    private func loadReferenceVideoFrames(url: URL, numFrames: Int, width: Int, height: Int) throws -> MLXArray {
        let info = try VideoProbe.info(url: url)
        var frameArrays: [MLXArray] = []
        frameArrays.reserveCapacity(numFrames)
        for i in 0..<numFrames {
            let t = info.fps > 0 ? Double(i) / info.fps : 0
            let clampedT = min(t, max(0, info.duration - 0.001))
            let cgImage = try VideoProbe.frame(url: url, at: clampedT)
            let resized = (cgImage.width != width || cgImage.height != height)
                ? FrameLoad.resizeAspectFillCenterCrop(cgImage, targetWidth: width, targetHeight: height)
                : cgImage
            frameArrays.append(FrameLoad.toArray(resized))  // (1, 3, H, W) [0, 1]
        }
        let stacked = MLX.stacked(frameArrays.map { $0[0] }, axis: 1)  // (3, F, H, W)
        return (stacked.asType(.float32) * 2.0 - 1.0).expandedDimensions(axis: 0)  // (1, 3, F, H, W) [-1, 1]
    }

    // Mirrors NativeI2VStage.distilledConfig — kept as its own private copy
    // rather than shared, matching this file's existing convention of
    // duplicating the small VAE-loading blocks instead of extracting a
    // cross-stage helper.
    private func distilledConfig(numLayers: Int) -> LTXModelConfig {
        var cfg = LTXModelConfig()
        cfg.numLayers = numLayers
        cfg.videoDim = 4096; cfg.audioDim = 2048
        cfg.videoNumHeads = 32; cfg.audioNumHeads = 32
        cfg.videoHeadDim = 128; cfg.audioHeadDim = 64
        cfg.avCrossNumHeads = 32; cfg.avCrossHeadDim = 64
        cfg.videoPatchChannels = 128; cfg.audioPatchChannels = 128
        cfg.timestepEmbeddingDim = 256
        cfg.timestepScaleMultiplier = 1000.0
        cfg.avCaTimestepScaleMultiplier = 1000.0
        cfg.ropeTheta = 10000.0
        cfg.positionalEmbeddingMaxPos = [20, 2048, 2048]
        cfg.audioPositionalEmbeddingMaxPos = [20]
        return cfg
    }

    /// Low-strength refinement: forward-noises `normalizedLatent` (the
    /// upscaled, still-normalized video latent) to `SigmaSchedule
    /// .stage2Sigmas[0]` and runs it through the real 48-block distilled
    /// transformer over that short schedule — a genuine partial
    /// re-denoise, not a fresh generation (mirrors the reference two-stage
    /// pipeline's Stage #2/#3, see docs/reference/comfyui_workflows). The
    /// video mask is uniform (mask=1 everywhere) EXCEPT any frames named in
    /// `preserveFrameIndices`: unlike I2V conditioning, nothing else here is
    /// "preserved" — the whole upscaled frame set is lightly re-denoised to
    /// remove the neural upscaler's over-sharpening. The audio track from
    /// `audioURL` IS preserved (denoiseMask=0 everywhere) purely so the
    /// joint transformer has a valid audio branch — see this file's header.
    ///
    /// `preserveFrameIndices`: re-pins FFLF-conditioned frames (typically
    /// [0, F-1]) so refine's re-denoise doesn't let them drift from their
    /// originally-pinned content — the reference pipeline does the exact
    /// same thing by re-applying its `LTXSequencer`/keyframe-guide nodes at
    /// Stage #2/#3, not by re-loading the original images: this reads
    /// ltx_sequencer.py's actual node source (append_keyframe/LTXVAddGuide)
    /// rather than the ComfyUI JSON's widget values alone, which don't
    /// disambiguate "per-frame refine schedule" from "keyframe re-insertion"
    /// (see docs/reference/comfyui_workflows/README.md's fourth-pass note).
    /// Uses the ALREADY-UPSCALED clean tokens at each index (not the
    /// original pre-upscale images) since they already represent the pinned
    /// content at the new resolution — this only needs to stop refine's
    /// denoise from letting that content drift, not re-derive it.
    private func refine(
        normalizedLatent: MLXArray, prompt: String, audioURL: URL,
        fps: Double, textMaxLength: Int, seed: UInt64,
        preserveFirstAndLastFrame: Bool = false
    ) throws -> MLXArray {
        let (videoTokens, dims) = VideoLatentPatchifier.patchify(normalizedLatent)  // (1, F*H*W, 128)

        let sigmas = SigmaSchedule.stage2Sigmas
        let startSigma = sigmas[0]
        let noise = MLXRandom.normal(videoTokens.shape, key: MLXRandom.key(seed &+ 9001))
        let noisyTokens = (1 - startSigma) * videoTokens + startSigma * noise

        let videoPositions = Positions.computeVideoPositions(numFrames: dims.f, height: dims.h, width: dims.w, frameRate: Float(fps))
        var videoState = LatentState(
            latent: noisyTokens, cleanLatent: noisyTokens,
            denoiseMask: MLXArray.ones([1, dims.f * dims.h * dims.w, 1]), positions: videoPositions)

        let preserveFrameIndices: [Int] = (preserveFirstAndLastFrame && dims.f >= 2) ? [0, dims.f - 1] : []
        for frameIdx in preserveFrameIndices where frameIdx >= 0 && frameIdx < dims.f {
            let tokensPerFrame = dims.h * dims.w
            let start = frameIdx * tokensPerFrame
            let cleanFrameTokens = videoTokens[0..., start..<(start + tokensPerFrame), 0...]
            let conditioner = VideoConditionByLatentIndex(frameIndices: [frameIdx], cleanLatent: cleanFrameTokens, strength: 1.0)
            videoState = conditioner.apply(to: videoState, spatialDims: (dims.f, dims.h, dims.w))
        }

        // Preserve the existing audio track fully (not refined) — same
        // resample-then-encode path --audio-track uses, just pinned over
        // its FULL length instead of a prefix.
        let wav = try WAVReader.read(url: audioURL)
        var channels = wav.channels
        if channels.count == 1 { channels = [channels[0], channels[0]] }
        channels = Array(channels.prefix(2))
        let resampled = channels.map { LinearResampler.resample($0, fromRate: wav.sampleRate, toRate: 16000) }
        let minLen = resampled.map(\.count).min() ?? 0
        let waveform = MLX.stacked(resampled.map { MLXArray($0.prefix(minLen)) }, axis: 0)  // (2, T)

        let audioEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        guard FileManager.default.fileExists(atPath: audioEncoderURL.path) else {
            throw StageError.audioEncoderCheckpointNotFound(audioEncoderURL)
        }
        let audioEncoder = try AudioVAEEncoderLoader.loadReal(checkpointURL: audioEncoderURL)
        let mel = AudioProcessor().waveformToMel(waveform).expandedDimensions(axis: 0)  // (1, 2, T', 64)
        let audioLatent = audioEncoder(mel)  // (1, 8, T, 16)
        MLX.eval(audioLatent)
        let (audioTokens, audioTokenCount) = AudioPatchifier.patchify(audioLatent)
        let audioState = LatentState(
            latent: audioTokens, cleanLatent: audioTokens,
            denoiseMask: MLXArray.zeros([1, audioTokenCount, 1]),
            positions: Positions.computeAudioPositions(numTokens: audioTokenCount))

        let textStage = NativeTextEncodeStage(maxLength: textMaxLength)
        let textResult = try textStage.encode(prompt)

        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        guard FileManager.default.fileExists(atPath: transformerURL.path) else {
            throw StageError.transformerCheckpointNotFound(transformerURL)
        }
        let rawTransformer = try MLX.loadArrays(url: transformerURL)
        var strippedTransformer: [String: MLXArray] = [:]
        for (key, value) in rawTransformer {
            guard key.hasPrefix("transformer.") else { continue }
            strippedTransformer[String(key.dropFirst("transformer.".count))] = value
        }

        let numLayers = 48
        let cfg = distilledConfig(numLayers: numLayers)
        let model = TransformerCheckpointLoader.makeModel(
            TransformerCheckpointLoader.topLevelWeights(raw: strippedTransformer, loraSources: []),
            config: cfg, transformerBlocks: [])

        let denoiseResult = DenoiseLoop.runStreaming(
            model: model, numLayers: numLayers,
            blockProvider: { idx in
                TransformerCheckpointLoader.makeBlock(
                    TransformerCheckpointLoader.blockWeights(raw: strippedTransformer, blockIndex: idx, loraSources: []),
                    config: cfg)
            },
            videoState: videoState, audioState: audioState,
            videoTextEmbeds: textResult.videoEmbeds, audioTextEmbeds: textResult.audioEmbeds,
            sigmas: sigmas)
        MLX.eval(denoiseResult.videoLatent)

        return VideoLatentPatchifier.unpatchify(denoiseResult.videoLatent, dims: dims)
    }
}
