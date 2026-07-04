//
//  NativeT2AStage.swift
//  LTXVideoDirector
//
//  Native (no run.py, no Python) text-to-audio-ONLY path: NativeTextEncodeStage
//  -> DenoiseLoop.runStreaming (real 48-block distilled transformer, audio-only
//  mode) -> AudioVAEDecoder + VocoderWithBWE -> WAV. No video is generated,
//  T2I'd, or decoded at all.
//
//  Ported from the official Lightricks reference workflow
//  `docs/reference/comfyui_workflows/LTX-2.3_T2A_Single_Stage_Distilled.json`
//  (`LTXVAudioOnlyModel` + `LTXVAudioOnlyEmptyVideoLatent`). Per the model
//  author's own `audio_only.py` (fetched directly, not guessed from widget
//  values — see that file's docstring): the LTX-2 transformer's block
//  positionally expects `[video, audio]` even in audio-only mode, so a fixed
//  minimal dummy video latent (batch 1, single frame, 64x64 pre-VAE pixels ->
//  a single (1,1,1) spatial token post-patchify... actually a (1,128,1,2,2)
//  BCFHW latent, matching the reference's fixed shape exactly) is still
//  threaded through, but `BasicAVTransformerBlock`'s `runVideoStream`/
//  `a2vCrossAttn`/`v2aCrossAttn` flags (this package's port of the reference's
//  `run_vx`/`a2v_cross_attn`/`v2a_cross_attn`) make sure it's never attended
//  to and never influences the generated audio. The dummy video's own output
//  is therefore meaningless and intentionally discarded (never decoded).
//
//  Confirmed against the reference JSON: `ManualSigmas` there is byte-for-byte
//  identical to this package's existing `SigmaSchedule.distilledSigmas` — no
//  new sigma schedule needed, same 8-step distilled schedule as `native-i2v`.
//

import Foundation
import MLX

public struct NativeT2AStage {
    public enum StageError: Error, CustomStringConvertible {
        case transformerCheckpointNotFound(URL)
        case audioEncoderCheckpointNotFound(URL)
        case loraNotFound(URL)
        case invalidDimensions(String)

        public var description: String {
            switch self {
            case .transformerCheckpointNotFound(let url): return "LTX-2.3 distilled transformer checkpoint not found at \(url.path)"
            case .audioEncoderCheckpointNotFound(let url): return "LTX-2.3 audio VAE checkpoint not found at \(url.path)"
            case .loraNotFound(let url): return "LoRA safetensors not found at \(url.path)"
            case .invalidDimensions(let msg): return "NativeT2AStage: \(msg)"
            }
        }
    }

    public struct Request {
        public var prompt: String
        /// Duration is expressed the same way as `native-i2v` (a virtual
        /// video frame count @ frameRate) because LTX-2's audio-token count
        /// formula (`Positions.computeAudioTokenCount`) is derived from that
        /// pair even when no video is ever generated — matching the
        /// reference workflow's own `LTXVEmptyLatentAudio` widget values
        /// `[97, 25, 1]` (97 virtual frames @ 25fps).
        public var seconds: Double
        public var frameRate: Double
        public var seed: UInt64
        public var textMaxLength: Int
        public var loraPaths: [(path: URL, strength: Float)]

        public init(
            prompt: String, seconds: Double = 3.84, frameRate: Double = 25.0,
            seed: UInt64 = 42, textMaxLength: Int = 128,
            loraPaths: [(path: URL, strength: Float)] = []
        ) {
            self.prompt = prompt
            self.seconds = seconds
            self.frameRate = frameRate
            self.seed = seed
            self.textMaxLength = textMaxLength
            self.loraPaths = loraPaths
        }

        /// Mirrors `NativeI2VStage.Request.frames` (LTX virtual frame counts
        /// must be 8k+1) — same formula, reused because the audio-token
        /// count formula expects it.
        public var virtualVideoFrames: Int {
            let raw = seconds * frameRate
            let kFloor = max(1, Int(floor((raw - 1) / 8.0)))
            let kCeil = kFloor + 1
            let fFloor = 8 * kFloor + 1
            let fCeil = 8 * kCeil + 1
            return abs(Double(fFloor) - raw) <= abs(Double(fCeil) - raw) ? fFloor : fCeil
        }
    }

    public struct Result {
        public let audioURL: URL
    }

    public init() {}

    private func distilledConfig(numLayers: Int) -> LTXModelConfig {
        // Same config as NativeI2VStage.distilledConfig — confirmed against
        // mlx-models/ltx-mlx/distilled/embedded_config.json.
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

    public func generate(_ request: Request, outputDir: URL) throws -> Result {
        try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

        // 1. Text encode: native Gemma-3-12b -> connector (no run.py).
        // videoEmbeds are computed but never used below (runVideoStream=false
        // in the denoise loop skips the video text cross-attn entirely).
        print("[1/3] NativeTextEncodeStage: encoding prompt...")
        let textStage = NativeTextEncodeStage(maxLength: request.textMaxLength)
        let textResult = try textStage.encode(request.prompt)

        // 2. Build the fixed dummy video latent (reference:
        // LTXVAudioOnlyEmptyVideoLatent — a hidden, fixed (1,128,1,2,2)
        // BCFHW placeholder, never attended to) + real audio noise.
        print("[2/3] DenoiseLoop.runStreaming: real 48-block distilled transformer (audio-only)...")
        let dummyVideoLatentBCFHW = MLXArray.zeros([1, 128, 1, 2, 2])
        let (dummyVideoTokens, dummyDims) = VideoLatentPatchifier.patchify(dummyVideoLatentBCFHW)
        let dummyVideoPositions = Positions.computeVideoPositions(
            numFrames: dummyDims.f, height: dummyDims.h, width: dummyDims.w, frameRate: Float(request.frameRate))
        let videoState = LatentState(
            latent: dummyVideoTokens, cleanLatent: dummyVideoTokens,
            denoiseMask: MLXArray.ones([1, dummyVideoTokens.dim(1), 1]), positions: dummyVideoPositions)

        let numAudioTokens = Positions.computeAudioTokenCount(numVideoFrames: request.virtualVideoFrames, frameRate: Float(request.frameRate))
        guard numAudioTokens > 0 else {
            throw StageError.invalidDimensions("computed 0 audio tokens for seconds=\(request.seconds) frameRate=\(request.frameRate)")
        }
        let audioNoise = MLXRandom.normal([1, numAudioTokens, 128], key: MLXRandom.key(request.seed))
        let audioPositions = Positions.computeAudioPositions(numTokens: numAudioTokens)
        let audioState = LatentState(
            latent: audioNoise, cleanLatent: audioNoise,
            denoiseMask: MLXArray.ones([1, numAudioTokens, 1]), positions: audioPositions)

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
            sigmas: SigmaSchedule.distilledSigmas,
            audioOnly: true)
        MLX.eval(denoiseResult.audioLatent)

        // 3. Decode audio only — the dummy video latent's own denoised
        // output is discarded (never decoded, matching the reference's
        // "hidden and fixed" dummy latent — it was never meant to be seen).
        print("[3/3] AudioVAEDecoder + VocoderWithBWE: decoding audio...")
        let audioLatentB8T16 = AudioPatchifier.unpatchify(denoiseResult.audioLatent)
        let audioDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        guard FileManager.default.fileExists(atPath: audioDecoderURL.path) else {
            throw StageError.audioEncoderCheckpointNotFound(audioDecoderURL)
        }
        let audioDecoder = try AudioVAEDecoderLoader.loadReal(checkpointURL: audioDecoderURL)
        let mel = audioDecoder(audioLatentB8T16.asType(.float32))
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

        return Result(audioURL: audioURL)
    }
}
