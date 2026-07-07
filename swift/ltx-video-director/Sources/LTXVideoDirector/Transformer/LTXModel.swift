//
//  LTXModel.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.transformer.model.LTXModel — the
//  top-level 48-layer joint audio+video DiT. Wires patchify projections,
//  8 top-level AdaLayerNormSingle modules (producing every
//  BasicAVTransformerBlock's modulation params from ONE shared timestep
//  embedding), RoPE frequency computation (4 tables: video/audio self +
//  video/audio cross), the block stack, and the output projection
//  (parameter-free LayerNorm + AdaLN scale/shift + Linear).
//
//  NOT YET PORTED (all explicitly out of scope for this first assembly,
//  matching BasicAVTransformerBlock's documented scope):
//    - STG perturbations (BatchedPerturbationConfig).
//    - block_provider (weight-streaming) / block_stack_override (TeaCache)
//      / tap (calibration callback).
//    - The LTX2_DIT_EVAL_EVERY Metal-watchdog mx.eval flushing — MLX Swift's
//      eager-ish evaluation model doesn't build the same multi-second lazy
//      graphs the Python 48-block loop does; revisit if it turns out needed.
//

import Foundation
import MLX

public struct LTXModelConfig {
    public var numLayers: Int = 48
    public var videoDim: Int = 4096
    public var audioDim: Int = 2048
    public var videoNumHeads: Int = 32
    public var audioNumHeads: Int = 32
    public var videoHeadDim: Int = 128
    public var audioHeadDim: Int = 64
    public var avCrossNumHeads: Int = 32
    public var avCrossHeadDim: Int = 64
    public var videoPatchChannels: Int = 128
    public var audioPatchChannels: Int = 128
    public var ffMult: Float = 4.0
    public var timestepEmbeddingDim: Int = 256
    public var timestepScaleMultiplier: Float = 1000.0
    public var avCaTimestepScaleMultiplier: Float = 1.0
    public var ropeTheta: Double = 10000.0
    public var positionalEmbeddingMaxPos: [Int] = [20, 2048, 2048]
    public var audioPositionalEmbeddingMaxPos: [Int] = [20]
    public var normEps: Float = 1e-6

    public init() {}
}

public struct LTXModel {
    public let config: LTXModelConfig

    public let patchifyProjWeight: MLXArray, patchifyProjBias: MLXArray
    public let audioPatchifyProjWeight: MLXArray, audioPatchifyProjBias: MLXArray
    public let projOutWeight: MLXArray, projOutBias: MLXArray
    public let audioProjOutWeight: MLXArray, audioProjOutBias: MLXArray
    public let scaleShiftTable: MLXArray, audioScaleShiftTable: MLXArray

    public let adalnSingle: AdaLayerNormSingle
    public let audioAdalnSingle: AdaLayerNormSingle
    public let promptAdalnSingle: AdaLayerNormSingle
    public let audioPromptAdalnSingle: AdaLayerNormSingle
    public let avCaVideoScaleShiftAdalnSingle: AdaLayerNormSingle
    public let avCaAudioScaleShiftAdalnSingle: AdaLayerNormSingle
    public let avCaA2VGateAdalnSingle: AdaLayerNormSingle
    public let avCaV2AGateAdalnSingle: AdaLayerNormSingle

    public let transformerBlocks: [BasicAVTransformerBlock]

    public init(
        config: LTXModelConfig,
        patchifyProjWeight: MLXArray, patchifyProjBias: MLXArray,
        audioPatchifyProjWeight: MLXArray, audioPatchifyProjBias: MLXArray,
        projOutWeight: MLXArray, projOutBias: MLXArray,
        audioProjOutWeight: MLXArray, audioProjOutBias: MLXArray,
        scaleShiftTable: MLXArray, audioScaleShiftTable: MLXArray,
        adalnSingle: AdaLayerNormSingle, audioAdalnSingle: AdaLayerNormSingle,
        promptAdalnSingle: AdaLayerNormSingle, audioPromptAdalnSingle: AdaLayerNormSingle,
        avCaVideoScaleShiftAdalnSingle: AdaLayerNormSingle, avCaAudioScaleShiftAdalnSingle: AdaLayerNormSingle,
        avCaA2VGateAdalnSingle: AdaLayerNormSingle, avCaV2AGateAdalnSingle: AdaLayerNormSingle,
        transformerBlocks: [BasicAVTransformerBlock]
    ) {
        self.config = config
        self.patchifyProjWeight = patchifyProjWeight; self.patchifyProjBias = patchifyProjBias
        self.audioPatchifyProjWeight = audioPatchifyProjWeight; self.audioPatchifyProjBias = audioPatchifyProjBias
        self.projOutWeight = projOutWeight; self.projOutBias = projOutBias
        self.audioProjOutWeight = audioProjOutWeight; self.audioProjOutBias = audioProjOutBias
        self.scaleShiftTable = scaleShiftTable; self.audioScaleShiftTable = audioScaleShiftTable
        self.adalnSingle = adalnSingle; self.audioAdalnSingle = audioAdalnSingle
        self.promptAdalnSingle = promptAdalnSingle; self.audioPromptAdalnSingle = audioPromptAdalnSingle
        self.avCaVideoScaleShiftAdalnSingle = avCaVideoScaleShiftAdalnSingle
        self.avCaAudioScaleShiftAdalnSingle = avCaAudioScaleShiftAdalnSingle
        self.avCaA2VGateAdalnSingle = avCaA2VGateAdalnSingle
        self.avCaV2AGateAdalnSingle = avCaV2AGateAdalnSingle
        self.transformerBlocks = transformerBlocks
    }

    private func linear(_ x: MLXArray, weight: MLXArray, bias: MLXArray) -> MLXArray {
        MLX.matmul(x, weight.transposed(1, 0)) + bias
    }

    private func embedTimestepScalar(_ timestep: MLXArray) -> MLXArray {
        TimestepEmbedding.sinusoidal(timesteps: timestep * config.timestepScaleMultiplier, embeddingDim: config.timestepEmbeddingDim)
    }

    /// Per-token timestep embedding: (B, N) -> (B, N, timestepEmbeddingDim).
    /// Flattens to (B*N,), embeds, reshapes back — matches the reference's
    /// `_embed_timestep_per_token` exactly.
    private func embedTimestepPerToken(_ perTokenTimesteps: MLXArray) -> MLXArray {
        let b = perTokenTimesteps.dim(0), n = perTokenTimesteps.dim(1)
        let flat = (perTokenTimesteps * config.timestepScaleMultiplier).reshaped([b * n])
        let emb = TimestepEmbedding.sinusoidal(timesteps: flat, embeddingDim: config.timestepEmbeddingDim)
        return emb.reshaped([b, n, -1])
    }

    /// Apply AdaLN with per-token timestep embeddings: (B, N, D) -> params
    /// (B, N, numParams*dim), embedded (B, N, dim). Matches the reference's
    /// `_adaln_per_token` (flatten to (B*N, D), call the module, reshape back).
    private func adalnPerToken(_ adalnModule: AdaLayerNormSingle, tEmbPerToken: MLXArray) -> (params: MLXArray, embedded: MLXArray) {
        let b = tEmbPerToken.dim(0), n = tEmbPerToken.dim(1), d = tEmbPerToken.dim(2)
        let flat = tEmbPerToken.reshaped([b * n, d])
        let (params, embedded) = adalnModule(flat)
        return (params.reshaped([b, n, -1]), embedded.reshaped([b, n, -1]))
    }

    private func computeRopeFreqs(positions: MLXArray, numHeads: Int, headDim: Int, maxPosOverride: [Int]? = nil) -> RoPE.Freqs {
        let innerDim = numHeads * headDim
        let maxPos = maxPosOverride ?? Array(config.positionalEmbeddingMaxPos.prefix(positions.dim(-1)))
        return RoPE.precomputeSplit(positions: positions, innerDim: innerDim, numHeads: numHeads, theta: config.ropeTheta, maxPos: maxPos)
    }

    /// Parameter-free LayerNorm (reference: mx.fast.layer_norm(x, weight=None, bias=None, eps)).
    private func layerNormNoAffine(_ x: MLXArray) -> MLXArray {
        let xf = x.asType(.float32)
        let mean = xf.mean(axis: -1, keepDims: true)
        let variance = ((xf - mean) * (xf - mean)).mean(axis: -1, keepDims: true)
        return (xf - mean) / MLX.sqrt(variance + config.normEps)
    }

    private func outputBlock(_ x: MLXArray, embeddedTimestep: MLXArray, scaleShiftTable: MLXArray, projWeight: MLXArray, projBias: MLXArray) -> MLXArray {
        var et = embeddedTimestep
        if et.ndim == 2 {
            et = et.expandedDimensions(axis: 1)  // (B, 1, dim)
        }
        // scaleShiftTable: (2, dim) -> (1, 1, 2, dim); et -> (B, N, 1, dim)
        let scaleShiftValues = scaleShiftTable.expandedDimensions(axis: 0).expandedDimensions(axis: 0)
            + et.expandedDimensions(axis: 2)
        let shift = scaleShiftValues[0..., 0..., 0, 0...]
        let scale = scaleShiftValues[0..., 0..., 1, 0...]
        var h = layerNormNoAffine(x)
        h = h * (1.0 + scale) + shift
        return linear(h, weight: projWeight, bias: projBias)
    }

    /// Forward pass. `videoTimesteps`/`audioTimesteps` (B, N), when provided,
    /// switch that modality's self-attn/ff/AV-cross AdaLN to per-token mode
    /// (preserved tokens at timestep=0 get no modulation) — used for I2V
    /// partial conditioning. The AV-cross GATE always uses the scalar
    /// `timestep` at `av_ca` scale regardless (matches the reference: gate
    /// modulation isn't per-token even in per-token mode), and prompt AdaLN
    /// (text cross-attn) is always scalar too (text tokens don't correspond
    /// to individual latent tokens). Returns (videoVelocity, audioVelocity).
    public func callAsFunction(
        videoLatent: MLXArray, audioLatent: MLXArray, timestep: MLXArray,
        videoTextEmbeds: MLXArray? = nil, audioTextEmbeds: MLXArray? = nil,
        videoPositions: MLXArray? = nil, audioPositions: MLXArray? = nil,
        videoAttentionMask: MLXArray? = nil, audioAttentionMask: MLXArray? = nil,
        videoTimesteps: MLXArray? = nil, audioTimesteps: MLXArray? = nil,
        audioOnly: Bool = false, stgBlocks: Set<Int> = []
    ) -> (video: MLXArray, audio: MLXArray) {
        var videoHidden = linear(videoLatent, weight: patchifyProjWeight, bias: patchifyProjBias)
        var audioHidden = linear(audioLatent, weight: audioPatchifyProjWeight, bias: audioPatchifyProjBias)

        let tEmb = embedTimestepScalar(timestep)
        let avCaFactor = config.avCaTimestepScaleMultiplier / config.timestepScaleMultiplier
        let tEmbAVGate = TimestepEmbedding.sinusoidal(
            timesteps: timestep * config.timestepScaleMultiplier * avCaFactor, embeddingDim: config.timestepEmbeddingDim)

        let videoAdalnEmb: MLXArray, videoEmbeddedTS: MLXArray, avCaVideoEmb: MLXArray
        if let videoTimesteps {
            let vtEmb = embedTimestepPerToken(videoTimesteps)
            (videoAdalnEmb, videoEmbeddedTS) = adalnPerToken(adalnSingle, tEmbPerToken: vtEmb)
            (avCaVideoEmb, _) = adalnPerToken(avCaVideoScaleShiftAdalnSingle, tEmbPerToken: vtEmb)
        } else {
            (videoAdalnEmb, videoEmbeddedTS) = adalnSingle(tEmb)
            (avCaVideoEmb, _) = avCaVideoScaleShiftAdalnSingle(tEmb)
        }
        let (avCaA2VGateEmb, _) = avCaA2VGateAdalnSingle(tEmbAVGate)
        let (videoPromptEmb, _) = promptAdalnSingle(tEmb)

        let audioAdalnEmb: MLXArray, audioEmbeddedTS: MLXArray, avCaAudioEmb: MLXArray
        if let audioTimesteps {
            let atEmb = embedTimestepPerToken(audioTimesteps)
            (audioAdalnEmb, audioEmbeddedTS) = adalnPerToken(audioAdalnSingle, tEmbPerToken: atEmb)
            (avCaAudioEmb, _) = adalnPerToken(avCaAudioScaleShiftAdalnSingle, tEmbPerToken: atEmb)
        } else {
            (audioAdalnEmb, audioEmbeddedTS) = audioAdalnSingle(tEmb)
            (avCaAudioEmb, _) = avCaAudioScaleShiftAdalnSingle(tEmb)
        }
        let (avCaV2AGateEmb, _) = avCaV2AGateAdalnSingle(tEmbAVGate)
        let (audioPromptEmb, _) = audioPromptAdalnSingle(tEmb)

        let videoRopeFreqs = videoPositions.map { computeRopeFreqs(positions: $0, numHeads: config.videoNumHeads, headDim: config.videoHeadDim) }
        let audioRopeFreqs = audioPositions.map {
            computeRopeFreqs(positions: $0, numHeads: config.audioNumHeads, headDim: config.audioHeadDim, maxPosOverride: config.audioPositionalEmbeddingMaxPos)
        }

        let crossPEMaxPos = max(config.positionalEmbeddingMaxPos[0], config.audioPositionalEmbeddingMaxPos[0])
        let videoCrossRopeFreqs = videoPositions.map {
            computeRopeFreqs(positions: $0[0..., 0..., 0..<1], numHeads: config.avCrossNumHeads, headDim: config.avCrossHeadDim, maxPosOverride: [crossPEMaxPos])
        }
        let audioCrossRopeFreqs = audioPositions.map {
            computeRopeFreqs(positions: $0[0..., 0..., 0..<1], numHeads: config.avCrossNumHeads, headDim: config.avCrossHeadDim, maxPosOverride: [crossPEMaxPos])
        }

        // STG (Milestone 2b) — see the matching comment in `streamingForward`.
        let stgMask: MLXArray? = stgBlocks.isEmpty ? nil : MLXArray(Float(0.0))

        for (blockIdx, block) in transformerBlocks.enumerated() {
            let (v, a) = block(
                videoHidden: videoHidden, audioHidden: audioHidden,
                videoAdaLNParams: videoAdalnEmb, audioAdaLNParams: audioAdalnEmb,
                videoPromptAdaLNParams: videoPromptEmb, audioPromptAdaLNParams: audioPromptEmb,
                avCAVideoParams: avCaVideoEmb, avCAAudioParams: avCaAudioEmb,
                avCAA2VGateParams: avCaA2VGateEmb, avCAV2AGateParams: avCaV2AGateEmb,
                videoTextEmbeds: videoTextEmbeds, audioTextEmbeds: audioTextEmbeds,
                videoRopeFreqs: videoRopeFreqs, audioRopeFreqs: audioRopeFreqs,
                videoCrossRopeFreqs: videoCrossRopeFreqs, audioCrossRopeFreqs: audioCrossRopeFreqs,
                videoAttentionMask: videoAttentionMask, audioAttentionMask: audioAttentionMask,
                runVideoStream: !audioOnly, a2vCrossAttn: !audioOnly, v2aCrossAttn: !audioOnly,
                videoPerturbationMask: stgBlocks.contains(blockIdx) ? stgMask : nil
            )
            videoHidden = v
            audioHidden = a
        }

        let videoOut = outputBlock(videoHidden, embeddedTimestep: videoEmbeddedTS, scaleShiftTable: scaleShiftTable, projWeight: projOutWeight, projBias: projOutBias)
        let audioOut = outputBlock(audioHidden, embeddedTimestep: audioEmbeddedTS, scaleShiftTable: audioScaleShiftTable, projWeight: audioProjOutWeight, projBias: audioProjOutBias)
        return (videoOut, audioOut)
    }

    /// Same forward pass as `callAsFunction`, but blocks are constructed
    /// on-demand by `blockProvider(index)` instead of read from
    /// `self.transformerBlocks` (which is expected empty for this path) —
    /// mirrors the Python reference's `block_provider` streaming mechanism.
    /// Supports `videoTimesteps`/`audioTimesteps` per-token timesteps, same
    /// semantics as `callAsFunction` (see its header).
    /// After each block, `MLX.eval` forces materialization of the hidden
    /// states so the just-used block's dequantized weights (built fresh
    /// each iteration by the caller's closure) become eligible for release
    /// before the next block is constructed. This is what makes running
    /// all 48 blocks against a real checkpoint feasible without holding
    /// 48 blocks' worth of dequantized float32 weights resident at once —
    /// see `TransformerCheckpointLoader.blockWeights` (dequantizes one
    /// block's slice at a time) and PLAN.md Phase 2's streaming milestone.
    public func streamingForward(
        videoLatent: MLXArray, audioLatent: MLXArray, timestep: MLXArray,
        numLayers: Int, blockProvider: (Int) -> BasicAVTransformerBlock,
        videoTextEmbeds: MLXArray? = nil, audioTextEmbeds: MLXArray? = nil,
        videoPositions: MLXArray? = nil, audioPositions: MLXArray? = nil,
        videoAttentionMask: MLXArray? = nil, audioAttentionMask: MLXArray? = nil,
        videoTimesteps: MLXArray? = nil, audioTimesteps: MLXArray? = nil,
        audioOnly: Bool = false, stgBlocks: Set<Int> = []
    ) -> (video: MLXArray, audio: MLXArray) {
        var videoHidden = linear(videoLatent, weight: patchifyProjWeight, bias: patchifyProjBias)
        var audioHidden = linear(audioLatent, weight: audioPatchifyProjWeight, bias: audioPatchifyProjBias)

        let tEmb = embedTimestepScalar(timestep)
        let avCaFactor = config.avCaTimestepScaleMultiplier / config.timestepScaleMultiplier
        let tEmbAVGate = TimestepEmbedding.sinusoidal(
            timesteps: timestep * config.timestepScaleMultiplier * avCaFactor, embeddingDim: config.timestepEmbeddingDim)

        let videoAdalnEmb: MLXArray, videoEmbeddedTS: MLXArray, avCaVideoEmb: MLXArray
        if let videoTimesteps {
            let vtEmb = embedTimestepPerToken(videoTimesteps)
            (videoAdalnEmb, videoEmbeddedTS) = adalnPerToken(adalnSingle, tEmbPerToken: vtEmb)
            (avCaVideoEmb, _) = adalnPerToken(avCaVideoScaleShiftAdalnSingle, tEmbPerToken: vtEmb)
        } else {
            (videoAdalnEmb, videoEmbeddedTS) = adalnSingle(tEmb)
            (avCaVideoEmb, _) = avCaVideoScaleShiftAdalnSingle(tEmb)
        }
        let (avCaA2VGateEmb, _) = avCaA2VGateAdalnSingle(tEmbAVGate)
        let (videoPromptEmb, _) = promptAdalnSingle(tEmb)

        let audioAdalnEmb: MLXArray, audioEmbeddedTS: MLXArray, avCaAudioEmb: MLXArray
        if let audioTimesteps {
            let atEmb = embedTimestepPerToken(audioTimesteps)
            (audioAdalnEmb, audioEmbeddedTS) = adalnPerToken(audioAdalnSingle, tEmbPerToken: atEmb)
            (avCaAudioEmb, _) = adalnPerToken(avCaAudioScaleShiftAdalnSingle, tEmbPerToken: atEmb)
        } else {
            (audioAdalnEmb, audioEmbeddedTS) = audioAdalnSingle(tEmb)
            (avCaAudioEmb, _) = avCaAudioScaleShiftAdalnSingle(tEmb)
        }
        let (avCaV2AGateEmb, _) = avCaV2AGateAdalnSingle(tEmbAVGate)
        let (audioPromptEmb, _) = audioPromptAdalnSingle(tEmb)

        let videoRopeFreqs = videoPositions.map { computeRopeFreqs(positions: $0, numHeads: config.videoNumHeads, headDim: config.videoHeadDim) }
        let audioRopeFreqs = audioPositions.map {
            computeRopeFreqs(positions: $0, numHeads: config.audioNumHeads, headDim: config.audioHeadDim, maxPosOverride: config.audioPositionalEmbeddingMaxPos)
        }
        let crossPEMaxPos = max(config.positionalEmbeddingMaxPos[0], config.audioPositionalEmbeddingMaxPos[0])
        let videoCrossRopeFreqs = videoPositions.map {
            computeRopeFreqs(positions: $0[0..., 0..., 0..<1], numHeads: config.avCrossNumHeads, headDim: config.avCrossHeadDim, maxPosOverride: [crossPEMaxPos])
        }
        let audioCrossRopeFreqs = audioPositions.map {
            computeRopeFreqs(positions: $0[0..., 0..., 0..<1], numHeads: config.avCrossNumHeads, headDim: config.avCrossHeadDim, maxPosOverride: [crossPEMaxPos])
        }

        // STG (Milestone 2b): a scalar 0.0 mask for blocks in `stgBlocks`
        // makes Attention.callAsFunction's `out*mask + v*(1-mask)` blend
        // resolve to `out = v` exactly — the whole batch is uniformly
        // perturbed in this single-pass (non-batched-uncond) design, so a
        // per-sample mask array isn't needed (reference: `Perturbation
        // .is_perturbed` keyed only on `block_idx` here).
        let stgMask: MLXArray? = stgBlocks.isEmpty ? nil : MLXArray(Float(0.0))

        for blockIdx in 0..<numLayers {
            let block = blockProvider(blockIdx)
            let (v, a) = block(
                videoHidden: videoHidden, audioHidden: audioHidden,
                videoAdaLNParams: videoAdalnEmb, audioAdaLNParams: audioAdalnEmb,
                videoPromptAdaLNParams: videoPromptEmb, audioPromptAdaLNParams: audioPromptEmb,
                avCAVideoParams: avCaVideoEmb, avCAAudioParams: avCaAudioEmb,
                avCAA2VGateParams: avCaA2VGateEmb, avCAV2AGateParams: avCaV2AGateEmb,
                videoTextEmbeds: videoTextEmbeds, audioTextEmbeds: audioTextEmbeds,
                videoRopeFreqs: videoRopeFreqs, audioRopeFreqs: audioRopeFreqs,
                videoCrossRopeFreqs: videoCrossRopeFreqs, audioCrossRopeFreqs: audioCrossRopeFreqs,
                videoAttentionMask: videoAttentionMask, audioAttentionMask: audioAttentionMask,
                runVideoStream: !audioOnly, a2vCrossAttn: !audioOnly, v2aCrossAttn: !audioOnly,
                videoPerturbationMask: stgBlocks.contains(blockIdx) ? stgMask : nil
            )
            MLX.eval(v, a)
            videoHidden = v
            audioHidden = a
        }

        let videoOut = outputBlock(videoHidden, embeddedTimestep: videoEmbeddedTS, scaleShiftTable: scaleShiftTable, projWeight: projOutWeight, projBias: projOutBias)
        let audioOut = outputBlock(audioHidden, embeddedTimestep: audioEmbeddedTS, scaleShiftTable: audioScaleShiftTable, projWeight: audioProjOutWeight, projBias: audioProjOutBias)
        return (videoOut, audioOut)
    }
}
