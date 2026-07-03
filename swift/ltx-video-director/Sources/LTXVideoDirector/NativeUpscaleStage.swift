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

        public var description: String {
            switch self {
            case .noFramesFound(let url): return "NativeUpscaleStage: no frame_*.png files found in \(url.path)"
            case .videoEncoderCheckpointNotFound(let url): return "NativeUpscaleStage: video VAE encoder checkpoint not found at \(url.path)"
            case .videoDecoderCheckpointNotFound(let url): return "NativeUpscaleStage: video VAE decoder checkpoint not found at \(url.path)"
            case .upsamplerCheckpointNotFound(let url): return "NativeUpscaleStage: spatial upscaler checkpoint not found at \(url.path)"
            case .transformerCheckpointNotFound(let url): return "NativeUpscaleStage: LTX-2.3 distilled transformer checkpoint not found at \(url.path)"
            case .audioEncoderCheckpointNotFound(let url): return "NativeUpscaleStage: LTX-2.3 audio VAE checkpoint not found at \(url.path)"
            case .refineNeedsAudioTrack: return "NativeUpscaleStage: --refine-prompt requires --refine-audio (the joint audio-video transformer needs a preserved audio track to attend to during refinement, even though audio itself isn't refined)"
            }
        }
    }

    public struct Result {
        public let frameDirectory: URL
        public let frameCount: Int
        public let inputSize: (width: Int, height: Int)
        public let outputSize: (width: Int, height: Int)
    }

    public init() {}

    /// Reads `frame_%04d.png` files from `inputFrameDirectory` (sorted by
    /// filename), 2x-spatially-upscales them natively, and writes the
    /// result to `outputDir`. When `refinePrompt` is supplied (together
    /// with `refineAudioURL`), follows the neural upscale with a
    /// low-strength transformer denoise refinement pass — see this file's
    /// header for why both are needed together.
    public func generate(
        inputFrameDirectory: URL, outputDir: URL,
        refinePrompt: String? = nil, refineAudioURL: URL? = nil,
        fps: Double = 24.0, textMaxLength: Int = 128, seed: UInt64 = 42
    ) throws -> Result {
        if refinePrompt != nil, refineAudioURL == nil {
            throw StageError.refineNeedsAudioTrack
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
            print("[3b/4] refine: low-strength denoise pass (stage-2 sigmas, real 48-block distilled transformer)...")
            upscaledLatent = try refine(
                normalizedLatent: upscaledLatent, prompt: refinePrompt, audioURL: refineAudioURL,
                fps: fps, textMaxLength: textMaxLength, seed: seed)
            MLX.eval(upscaledLatent)
        }

        print("[4/4] VideoDecoder: decoding upscaled latent to \(width * 2)x\(height * 2) frames...")
        let videoDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        guard fm.fileExists(atPath: videoDecoderURL.path) else {
            throw StageError.videoDecoderCheckpointNotFound(videoDecoderURL)
        }
        let videoDecoder = try VideoDecoderLoader.loadReal(checkpointURL: videoDecoderURL)
        let pixels = videoDecoder(upscaledLatent.asType(.float32))  // (1, 3, F, 2H, 2W), [-1, 1]
        MLX.eval(pixels)

        let frameDir = outputDir.appendingPathComponent("frames")
        let frameCount = try PNGFrameWriter.writeFrames(pixels, to: frameDir)

        return Result(
            frameDirectory: frameDir, frameCount: frameCount,
            inputSize: (width, height), outputSize: (width * 2, height * 2))
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
    /// video mask is uniform (mask=1 everywhere): unlike I2V conditioning,
    /// nothing here is "preserved" — the whole upscaled frame set is
    /// lightly re-denoised to remove the neural upscaler's over-sharpening.
    /// The audio track from `audioURL` IS preserved (denoiseMask=0
    /// everywhere) purely so the joint transformer has a valid audio
    /// branch — see this file's header.
    private func refine(
        normalizedLatent: MLXArray, prompt: String, audioURL: URL,
        fps: Double, textMaxLength: Int, seed: UInt64
    ) throws -> MLXArray {
        let (videoTokens, dims) = VideoLatentPatchifier.patchify(normalizedLatent)  // (1, F*H*W, 128)

        let sigmas = SigmaSchedule.stage2Sigmas
        let startSigma = sigmas[0]
        let noise = MLXRandom.normal(videoTokens.shape, key: MLXRandom.key(seed &+ 9001))
        let noisyTokens = (1 - startSigma) * videoTokens + startSigma * noise

        let videoPositions = Positions.computeVideoPositions(numFrames: dims.f, height: dims.h, width: dims.w, frameRate: Float(fps))
        let videoState = LatentState(
            latent: noisyTokens, cleanLatent: noisyTokens,
            denoiseMask: MLXArray.ones([1, dims.f * dims.h * dims.w, 1]), positions: videoPositions)

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
