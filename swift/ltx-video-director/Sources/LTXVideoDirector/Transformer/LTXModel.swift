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
//    - Per-token timesteps (video_timesteps/audio_timesteps) — only the
//      scalar-timestep path is implemented.
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

    /// Scalar-timestep-only forward pass. Returns (videoVelocity, audioVelocity).
    public func callAsFunction(
        videoLatent: MLXArray, audioLatent: MLXArray, timestep: MLXArray,
        videoTextEmbeds: MLXArray? = nil, audioTextEmbeds: MLXArray? = nil,
        videoPositions: MLXArray? = nil, audioPositions: MLXArray? = nil,
        videoAttentionMask: MLXArray? = nil, audioAttentionMask: MLXArray? = nil
    ) -> (video: MLXArray, audio: MLXArray) {
        var videoHidden = linear(videoLatent, weight: patchifyProjWeight, bias: patchifyProjBias)
        var audioHidden = linear(audioLatent, weight: audioPatchifyProjWeight, bias: audioPatchifyProjBias)

        let tEmb = embedTimestepScalar(timestep)
        let avCaFactor = config.avCaTimestepScaleMultiplier / config.timestepScaleMultiplier
        let tEmbAVGate = TimestepEmbedding.sinusoidal(
            timesteps: timestep * config.timestepScaleMultiplier * avCaFactor, embeddingDim: config.timestepEmbeddingDim)

        let (videoAdalnEmb, videoEmbeddedTS) = adalnSingle(tEmb)
        let (avCaVideoEmb, _) = avCaVideoScaleShiftAdalnSingle(tEmb)
        let (avCaA2VGateEmb, _) = avCaA2VGateAdalnSingle(tEmbAVGate)
        let (videoPromptEmb, _) = promptAdalnSingle(tEmb)

        let (audioAdalnEmb, audioEmbeddedTS) = audioAdalnSingle(tEmb)
        let (avCaAudioEmb, _) = avCaAudioScaleShiftAdalnSingle(tEmb)
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

        for block in transformerBlocks {
            let (v, a) = block(
                videoHidden: videoHidden, audioHidden: audioHidden,
                videoAdaLNParams: videoAdalnEmb, audioAdaLNParams: audioAdalnEmb,
                videoPromptAdaLNParams: videoPromptEmb, audioPromptAdaLNParams: audioPromptEmb,
                avCAVideoParams: avCaVideoEmb, avCAAudioParams: avCaAudioEmb,
                avCAA2VGateParams: avCaA2VGateEmb, avCAV2AGateParams: avCaV2AGateEmb,
                videoTextEmbeds: videoTextEmbeds, audioTextEmbeds: audioTextEmbeds,
                videoRopeFreqs: videoRopeFreqs, audioRopeFreqs: audioRopeFreqs,
                videoCrossRopeFreqs: videoCrossRopeFreqs, audioCrossRopeFreqs: audioCrossRopeFreqs,
                videoAttentionMask: videoAttentionMask, audioAttentionMask: audioAttentionMask
            )
            videoHidden = v
            audioHidden = a
        }

        let videoOut = outputBlock(videoHidden, embeddedTimestep: videoEmbeddedTS, scaleShiftTable: scaleShiftTable, projWeight: projOutWeight, projBias: projOutBias)
        let audioOut = outputBlock(audioHidden, embeddedTimestep: audioEmbeddedTS, scaleShiftTable: audioScaleShiftTable, projWeight: audioProjOutWeight, projBias: audioProjOutBias)
        return (videoOut, audioOut)
    }
}
