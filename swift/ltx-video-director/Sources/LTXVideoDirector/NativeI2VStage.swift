//
//  NativeI2VStage.swift
//  LTXVideoDirector
//
//  First end-to-end assembly of the native (no run.py, no Python) I2V
//  path: NativeT2IStage -> VideoEncoder (source frame as I2V conditioning
//  latent) -> NativeTextEncodeStage -> DenoiseLoop.runStreaming (real
//  48-block LTX-2.3 distilled transformer) -> VideoDecoder +
//  AudioVAEDecoder + VocoderWithBWE -> PNG frame sequence + WAV. Every
//  piece here already had its own parity or real-checkpoint test before
//  this file existed (see PLAN.md's milestones); this only composes them.
//
//  Scope, deliberately narrow for this first assembly:
//    - distilled transformer ONLY (mlx-models/transformer/ltx-2.3-distilled-q8),
//      using SigmaSchedule.distilledSigmas (8 steps) — the config this
//      package's real-checkpoint tests have actually verified. dev/dasiwa
//      would need their own configs confirmed against their
//      embedded_config.json first.
//    - no VLM prompt expansion (NativeVLMPromptStage) wired in yet — the
//      `prompt` is used verbatim for both the T2I and video stages.
//    - video decode is temporally tiled when needed (VideoDecodeTiling,
//      auto-budgeted via LTX2_VAE_DECODE_BUDGET_GB) — long clips no
//      longer exhaust memory in the decode graph. VideoEncoder still
//      encodes a single conditioning frame, which never needs tiling.
//    - Output is a PNG frame sequence + a separate WAV file (same
//      convention VideoDecodeCommand/AudioDecodeCommand already use).
//      `native-i2v`'s CLI command optionally muxes these into a real
//      `.mp4` via MP4Writer.swift (AVAssetWriter) — on by default,
//      `--no-mp4` to skip.
//    - `DenoiseLoop.runStreaming` rebuilds all 48 blocks from the raw
//      checkpoint on every sigma step (no persistent block cache), so
//      wall-clock is expected to be meaningfully slower than run.py's
//      load-once approach — unmeasured at real resolution/step-count as
//      of this file's introduction.
//

import Foundation
import MLX

public struct NativeI2VStage {
    public enum StageError: Error, CustomStringConvertible {
        case transformerCheckpointNotFound(URL)
        case videoEncoderCheckpointNotFound(URL)
        case invalidDimensions(String)
        case loraNotFound(URL)
        case lastFrameImageNotFound(URL)
        case lastFrameImageWrongSize(expected: (width: Int, height: Int), actual: (width: Int, height: Int))
        case audioTrackNotFound(URL)
        case audioEncoderCheckpointNotFound(URL)

        public var description: String {
            switch self {
            case .transformerCheckpointNotFound(let url): return "LTX-2.3 distilled transformer checkpoint not found at \(url.path)"
            case .videoEncoderCheckpointNotFound(let url): return "LTX-2.3 video VAE encoder checkpoint not found at \(url.path)"
            case .invalidDimensions(let msg): return "NativeI2VStage: \(msg)"
            case .loraNotFound(let url): return "LoRA safetensors not found at \(url.path)"
            case .lastFrameImageNotFound(let url): return "--last-frame image not found at \(url.path)"
            case .lastFrameImageWrongSize(let expected, let actual):
                return "--last-frame image is \(actual.width)x\(actual.height), expected \(expected.width)x\(expected.height) "
                    + "(same resolution as the generated clip — resize it first, e.g. with sips)"
            case .audioTrackNotFound(let url): return "--audio-track file not found at \(url.path)"
            case .audioEncoderCheckpointNotFound(let url): return "LTX-2.3 audio VAE checkpoint not found at \(url.path)"
            }
        }
    }

    public struct Request {
        public var prompt: String
        public var seconds: Double
        public var fps: Double
        /// Auto-snapped to the nearest multiple of 32 (VAE spatial
        /// compression factor — see ResolutionResolver / Positions /
        /// Patchifiers' VideoLatentShape) at the start of `generate` if not
        /// already aligned; arbitrary user input is never rejected outright.
        public var width: Int
        public var height: Int
        public var seed: UInt64
        public var t2iTransformer: String
        public var textMaxLength: Int
        /// Additional LoRA(s) to fuse into the distilled transformer at
        /// block-dequantize time, on top of the checkpoint's own baked-in
        /// distilled behavior (see LoRAFusion.swift / LoRAWeights.swift).
        /// Multiple entries are summed (matches the vendor's
        /// `apply_loras`/`_prepare_deltas`) — supports stacking more than
        /// one LoRA at independent strengths.
        public var loraPaths: [(path: URL, strength: Float)]
        /// First-Last-Frame (FFLF) conditioning: an optional user-supplied
        /// image pinned as the CLIP's LAST frame (frame 0 is always the
        /// T2I-generated `prompt` image, unchanged). Must already be exactly
        /// `width`x`height` — the pipeline doesn't resize it (see
        /// StageError.lastFrameImageWrongSize). Ported from the reference
        /// ComfyUI FFLF workflows' `MultiImageLoader` conditioning — see
        /// docs/reference/comfyui_workflows/README.md. When nil, behaves
        /// exactly as before (frame-0-only I2V conditioning).
        public var lastFrameImagePath: URL?
        /// Custom audio injection: an optional user-supplied WAV whose
        /// content is preserved through generation instead of the audio
        /// modality being generated from scratch — mirrors the reference
        /// ComfyUI workflows' "Custom Audio" subgraph (LTXVAudioVAEEncode +
        /// SetLatentNoiseMask, see docs/reference/comfyui_workflows/README.md
        /// finding 5). Resampled to 16kHz (AudioProcessor's expected rate)
        /// via LinearResampler, encoded with AudioVAEEncoder, then pinned
        /// as preserved (denoiseMask=0) tokens covering the overlap between
        /// the track's duration and the generated clip's audio-token count
        /// — reuses VideoConditionByLatentIndex with spatialDims=(N,1,1)
        /// since audio tokens have no spatial extent to group by frame.
        /// When nil, audio is generated fresh (unchanged behavior).
        public var audioTrackPath: URL?

        public init(
            prompt: String, seconds: Double = 0.5, fps: Double = 24.0,
            width: Int = 640, height: Int = 960, seed: UInt64 = 42,
            t2iTransformer: String = "moody-pro-mix", textMaxLength: Int = 128,
            loraPaths: [(path: URL, strength: Float)] = [],
            lastFrameImagePath: URL? = nil,
            audioTrackPath: URL? = nil
        ) {
            self.prompt = prompt
            self.seconds = seconds
            self.fps = fps
            self.width = width
            self.height = height
            self.seed = seed
            self.t2iTransformer = t2iTransformer
            self.textMaxLength = textMaxLength
            self.loraPaths = loraPaths
            self.lastFrameImagePath = lastFrameImagePath
            self.audioTrackPath = audioTrackPath
        }

        /// LTX frame counts must be 8k+1 (mirrors I2VRequest.frames).
        public var frames: Int {
            let raw = seconds * fps
            let kFloor = max(1, Int(floor((raw - 1) / 8.0)))
            let kCeil = kFloor + 1
            let fFloor = 8 * kFloor + 1
            let fCeil = 8 * kCeil + 1
            return abs(Double(fFloor) - raw) <= abs(Double(fCeil) - raw) ? fFloor : fCeil
        }
    }

    public struct Result {
        public let sourceImageURL: URL
        public let frameDirectory: URL
        public let frameCount: Int
        public let audioURL: URL
    }

    public init() {}

    private func distilledConfig(numLayers: Int) -> LTXModelConfig {
        // Confirmed against mlx-models/ltx-mlx/distilled/embedded_config.json
        // (see LTXModelRealCheckpointTests.realConfig — same values).
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

    public func generate(_ requestIn: Request, outputDir: URL) throws -> Result {
        var request = requestIn
        guard request.width > 0, request.height > 0 else {
            throw StageError.invalidDimensions("width/height must be positive, got \(request.width)x\(request.height)")
        }
        let optimized = ResolutionResolver.optimize(width: request.width, height: request.height)
        if optimized.width != request.width || optimized.height != request.height {
            print("[resolution] auto-adjusted \(request.width)x\(request.height) -> \(optimized.width)x\(optimized.height) "
                + "(nearest multiple of \(ResolutionResolver.spatialScale) — LTX-2.3 VAE spatial compression)")
            request.width = optimized.width
            request.height = optimized.height
        }
        // Fail fast on a bad --last-frame BEFORE any expensive generation
        // work (T2I/text-encode/denoise) — cheap dimension check only, the
        // actual VAE-encode happens later in step 4 once fLat is known.
        if let lastFrameImagePath = request.lastFrameImagePath {
            guard let cgImage = FrameLoad.loadCGImage(from: lastFrameImagePath) else {
                throw StageError.lastFrameImageNotFound(lastFrameImagePath)
            }
            guard cgImage.width == request.width, cgImage.height == request.height else {
                throw StageError.lastFrameImageWrongSize(
                    expected: (request.width, request.height), actual: (cgImage.width, cgImage.height))
            }
        }
        if let audioTrackPath = request.audioTrackPath {
            guard FileManager.default.fileExists(atPath: audioTrackPath.path) else {
                throw StageError.audioTrackNotFound(audioTrackPath)
            }
        }

        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        // 1. T2I: native ZImage pipeline (no run.py).
        print("[1/5] NativeT2IStage: generating source frame...")
        let t2i = NativeT2IStage(transformer: request.t2iTransformer, width: request.width, height: request.height, seed: request.seed)
        let sourceImageURL = outputDir.appendingPathComponent("source.png")
        let imagePixels01 = try t2i.generate(prompt: request.prompt, outputURL: sourceImageURL)  // (1, 3, H, W) in [0, 1]

        // 2. Text encode: native Gemma-3-12b -> connector (no run.py).
        print("[2/5] NativeTextEncodeStage: encoding prompt...")
        let textStage = NativeTextEncodeStage(maxLength: request.textMaxLength)
        let textResult = try textStage.encode(request.prompt)

        // 3. VAE-encode the source frame as the I2V conditioning latent.
        print("[3/5] VideoEncoder: encoding source frame as I2V conditioning...")
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        guard FileManager.default.fileExists(atPath: vaeEncoderURL.path) else {
            throw StageError.videoEncoderCheckpointNotFound(vaeEncoderURL)
        }
        let encRaw = try MLX.loadArrays(url: vaeEncoderURL)
        var encWeights: [String: MLXArray] = [:]
        for (key, value) in encRaw {
            let stripped = key.hasPrefix("vae_encoder.") ? String(key.dropFirst("vae_encoder.".count)) : key
            encWeights[stripped] = value.asType(.float32)
        }
        let videoEncoder = VideoEncoder(weights: encWeights)
        let pixelsNeg1to1 = imagePixels01.asType(.float32) * 2.0 - 1.0
        let pixelsBCFHW = pixelsNeg1to1.reshaped([1, 3, 1, request.height, request.width])
        let conditionLatentBCFHW = videoEncoder(pixelsBCFHW)  // (1, 128, 1, H', W')
        MLX.eval(conditionLatentBCFHW)
        let (conditionTokens, _) = VideoLatentPatchifier.patchify(conditionLatentBCFHW)

        // 4. Build noise + positions, splice in the conditioning frame, denoise.
        print("[4/5] DenoiseLoop.runStreaming: real 48-block distilled transformer...")
        let (fLat, hLat, wLat) = VideoLatentShape.compute(numFrames: request.frames, height: request.height, width: request.width)
        let numAudioTokens = Positions.computeAudioTokenCount(numVideoFrames: request.frames, frameRate: Float(request.fps))

        let key = MLXRandom.key(request.seed)
        let videoNoise = MLXRandom.normal([1, fLat * hLat * wLat, 128], key: key)
        let audioNoise = MLXRandom.normal([1, numAudioTokens, 128], key: MLXRandom.key(request.seed &+ 1))

        let videoPositions = Positions.computeVideoPositions(numFrames: fLat, height: hLat, width: wLat, frameRate: Float(request.fps))
        let audioPositions = Positions.computeAudioPositions(numTokens: numAudioTokens)

        // FFLF: pin an optional user-supplied image as the last latent frame,
        // on top of the always-present frame-0 conditioning above (see
        // Request.lastFrameImagePath's header and docs/reference/comfyui_workflows).
        var conditionFrameIndices = [0]
        var conditionCleanTokens = conditionTokens
        if let lastFrameImagePath = request.lastFrameImagePath {
            guard fLat >= 2 else {
                throw StageError.invalidDimensions("--last-frame needs at least 2 latent frames (increase --seconds) — got \(fLat)")
            }
            // Existence + exact-size already validated up-front, before any
            // expensive generation work — see the fail-fast check above.
            let cgImage = FrameLoad.loadCGImage(from: lastFrameImagePath)!
            print("[fflf] pinning last frame from \(lastFrameImagePath.lastPathComponent)")
            let lastPixels01 = FrameLoad.toArray(cgImage)  // (1, 3, H, W) [0, 1]
            let lastPixelsNeg1to1 = lastPixels01.asType(.float32) * 2.0 - 1.0
            let lastPixelsBCFHW = lastPixelsNeg1to1.reshaped([1, 3, 1, request.height, request.width])
            let lastLatentBCFHW = videoEncoder(lastPixelsBCFHW)
            MLX.eval(lastLatentBCFHW)
            let (lastTokens, _) = VideoLatentPatchifier.patchify(lastLatentBCFHW)
            conditionFrameIndices = [0, fLat - 1]
            conditionCleanTokens = MLX.concatenated([conditionTokens, lastTokens], axis: 1)
        }

        let videoState0 = LatentState(latent: videoNoise, cleanLatent: videoNoise, denoiseMask: MLXArray.ones([1, fLat * hLat * wLat, 1]), positions: videoPositions)
        let conditioner = VideoConditionByLatentIndex(frameIndices: conditionFrameIndices, cleanLatent: conditionCleanTokens, strength: 1.0)
        let videoState = conditioner.apply(to: videoState0, spatialDims: (fLat, hLat, wLat))
        var audioState = LatentState(latent: audioNoise, cleanLatent: audioNoise, denoiseMask: MLXArray.ones([1, numAudioTokens, 1]), positions: audioPositions)

        // Custom audio injection: pin a user-supplied WAV as preserved audio
        // tokens instead of generating audio from scratch (see
        // Request.audioTrackPath's header and docs/reference/comfyui_workflows).
        if let audioTrackPath = request.audioTrackPath {
            let wav = try WAVReader.read(url: audioTrackPath)
            var channels = wav.channels
            if channels.count == 1 { channels = [channels[0], channels[0]] }
            channels = Array(channels.prefix(2))
            let resampled = channels.map { LinearResampler.resample($0, fromRate: wav.sampleRate, toRate: 16000) }
            let minLen = resampled.map(\.count).min() ?? 0
            guard minLen > 0 else {
                throw StageError.invalidDimensions("--audio-track \(audioTrackPath.lastPathComponent) has zero samples after resampling")
            }
            let waveform = MLX.stacked(resampled.map { MLXArray($0.prefix(minLen)) }, axis: 0)  // (2, T)

            let audioEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
            guard FileManager.default.fileExists(atPath: audioEncoderURL.path) else {
                throw StageError.audioEncoderCheckpointNotFound(audioEncoderURL)
            }
            let audioEncoder = try AudioVAEEncoderLoader.loadReal(checkpointURL: audioEncoderURL)
            let mel = AudioProcessor().waveformToMel(waveform).expandedDimensions(axis: 0)  // (1, 2, T', 64)
            let trackLatent = audioEncoder(mel)  // (1, 8, T, 16)
            MLX.eval(trackLatent)
            let (trackTokens, trackTokenCount) = AudioPatchifier.patchify(trackLatent)

            let preserveCount = min(trackTokenCount, numAudioTokens)
            print("[audio-track] pinning \(preserveCount)/\(numAudioTokens) audio tokens from \(audioTrackPath.lastPathComponent) (preserved, not generated)")
            let preservedTokens = trackTokens[0..., 0..<preserveCount, 0...]
            // spatialDims=(N,1,1): audio tokens have no spatial extent to
            // group by frame (unlike video's H*W-per-frame), so
            // tokensPerFrame=1 and frameIndices addresses individual
            // time-token positions directly — same generic mechanism,
            // reused rather than duplicated.
            let audioConditioner = VideoConditionByLatentIndex(frameIndices: Array(0..<preserveCount), cleanLatent: preservedTokens, strength: 1.0)
            audioState = audioConditioner.apply(to: audioState, spatialDims: (numAudioTokens, 1, 1))
        }

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

        var loraSources: [(weights: LoRAWeights, strength: Float)] = []
        for (path, strength) in request.loraPaths {
            guard FileManager.default.fileExists(atPath: path.path) else {
                throw StageError.loraNotFound(path)
            }
            print("   [lora] fusing \(path.lastPathComponent) at strength \(strength)")
            loraSources.append((weights: try LoRAWeights.load(url: path), strength: strength))
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

        // 5. Decode both modalities natively and write to disk.
        print("[5/5] VideoDecoder + AudioVAEDecoder + VocoderWithBWE: decoding output...")
        let videoLatentBCFHW = VideoLatentPatchifier.unpatchify(denoiseResult.videoLatent, dims: (fLat, hLat, wLat))
        let videoDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        let videoDecoder = try VideoDecoderLoader.loadReal(checkpointURL: videoDecoderURL)
        let tiling = VideoDecodeTiling.computeAuto(latentShape: videoLatentBCFHW.shape, frameRate: request.fps)
        if let tiling {
            print("   [vae-decode] tiled: tile_frames=\(tiling.tileSizeInFrames) overlap=\(tiling.tileOverlapInFrames)")
        }
        let pixels = VideoDecodeTiling.decode(
            decoder: videoDecoder, latentBCFHW: videoLatentBCFHW.asType(.float32), config: tiling)  // (1, 3, T, H, W), [-1, 1]
        MLX.eval(pixels)
        let frameDir = outputDir.appendingPathComponent("frames")
        let frameCount = try PNGFrameWriter.writeFrames(pixels, to: frameDir)

        let audioLatentB8T16 = AudioPatchifier.unpatchify(denoiseResult.audioLatent)
        let audioDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
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

        return Result(sourceImageURL: sourceImageURL, frameDirectory: frameDir, frameCount: frameCount, audioURL: audioURL)
    }
}
