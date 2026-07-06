//
//  TransformerBlock.swift
//  ZImageDirector
//
//  Port of app/transformer.py:ZImageTransformerBlock + FinalLayer.
//

import Foundation
import MLX
import MLXNN

/// Opt-in attention-vs-MLP breakdown of one block's forward pass, produced
/// only when `callAsFunction`'s `onAttnMlpTimings` handler is non-nil.
public struct AttnMlpTimings {
    public var attnMs: Double = 0
    public var mlpMs: Double = 0
}

/// One DiT block. `modulation=true` → has adaLN_modulation (noise refiners,
/// main layers); `false` → plain residual (context refiners).
public final class ZImageTransformerBlock: Module {

    public let modulation: Bool
    public let attention: Attention
    public let feedForward: FeedForward
    public let attentionNorm1: ZRMSNorm
    public let ffnNorm1: ZRMSNorm
    public let attentionNorm2: ZRMSNorm
    public let ffnNorm2: ZRMSNorm
    public let adaLNModulation: QuantizedLinear?  // 256 → 4*dim (only if modulation)

    public init(
        config: TransformerConfig, modulation: Bool,
        attention: Attention, feedForward: FeedForward,
        attentionNorm1: ZRMSNorm, ffnNorm1: ZRMSNorm,
        attentionNorm2: ZRMSNorm, ffnNorm2: ZRMSNorm,
        adaLNModulation: QuantizedLinear?
    ) {
        self.modulation = modulation
        self.attention = attention
        self.feedForward = feedForward
        self.attentionNorm1 = attentionNorm1
        self.ffnNorm1 = ffnNorm1
        self.attentionNorm2 = attentionNorm2
        self.ffnNorm2 = ffnNorm2
        self.adaLNModulation = adaLNModulation
        super.init()
    }

    public func callAsFunction(
        _ x: MLXArray, mask: MLXArray?, positions: MLXArray?,
        adalnInput: MLXArray? = nil, cos: MLXArray? = nil, sin: MLXArray? = nil,
        // Opt-in attention-vs-MLP sub-stage timing (the next granularity down
        // from ZImageTransformer's per-stage BlockTimings, now that the
        // noiseRefiner/contextRefiner/layers split has shown `layers`
        // dominates at ~90%+ of forward time — see PR #315). Forces an extra
        // MLX.eval sync point after each half; nil by default, so the forward
        // pass is byte-identical to before this parameter existed.
        onAttnMlpTimings: ((AttnMlpTimings) -> Void)? = nil
    ) -> MLXArray {
        let profiling = onAttnMlpTimings != nil
        var x = x
        var timings = AttnMlpTimings()
        if modulation, let adalnInput = adalnInput, let ada = adaLNModulation {
            // chunks = adaLN_modulation(adaln_input); split into 4 along last axis
            let chunks = ada(adalnInput)
            let parts = chunks.split(parts: 4, axis: -1)
            var scaleMsa = parts[0]; var gateMsa = parts[1]
            var scaleMlp = parts[2]; var gateMlp = parts[3]
            // add a seq axis: [..., None, :]
            scaleMsa = scaleMsa.expandedDimensions(axis: -2)
            gateMsa = gateMsa.expandedDimensions(axis: -2)
            scaleMlp = scaleMlp.expandedDimensions(axis: -2)
            gateMlp = gateMlp.expandedDimensions(axis: -2)

            let attnStart = profiling ? Date() : nil
            let normX = attentionNorm1(x) * (1 + scaleMsa)
            let attnOut = attention(normX, mask: mask, positions: positions, cos: cos, sin: sin)
            if profiling {
                MLX.eval(attnOut)
                timings.attnMs = attnStart!.distance(to: Date()) * 1000
            }
            x = x + MLX.tanh(gateMsa) * attentionNorm2(attnOut)

            let mlpStart = profiling ? Date() : nil
            let normFfn = ffnNorm1(x) * (1 + scaleMlp)
            let ffnOut = feedForward(normFfn)
            if profiling {
                MLX.eval(ffnOut)
                timings.mlpMs = mlpStart!.distance(to: Date()) * 1000
            }
            x = x + MLX.tanh(gateMlp) * ffnNorm2(ffnOut)
        } else {
            let attnStart = profiling ? Date() : nil
            let attnOut = attention(attentionNorm1(x), mask: mask, positions: positions, cos: cos, sin: sin)
            if profiling {
                MLX.eval(attnOut)
                timings.attnMs = attnStart!.distance(to: Date()) * 1000
            }
            x = x + attentionNorm2(attnOut)

            let mlpStart = profiling ? Date() : nil
            let ffnOut = feedForward(ffnNorm1(x))
            if profiling {
                MLX.eval(ffnOut)
                timings.mlpMs = mlpStart!.distance(to: Date()) * 1000
            }
            x = x + ffnNorm2(ffnOut)
        }
        onAttnMlpTimings?(timings)
        return x
    }
}

/// Port of FinalLayer: LayerNorm(affine=False) * (1 + scale) → Linear(dim→out).
/// scale = adaLN(SiLU(t)) where adaLN is a quantized Linear(256→dim).
public final class FinalLayer: Module {

    public let normFinal: LayerNorm       // affine=False
    public let linear: QuantizedLinear    // dim → out_channels*4
    public let adaLNSiLU: SiLU
    public let adaLNLinear: QuantizedLinear  // 256 → dim

    public init(
        dim: Int, outChannels: Int,
        linear: QuantizedLinear, adaLNLinear: QuantizedLinear
    ) {
        // affine=False → no weight/bias on the LayerNorm.
        self.normFinal = LayerNorm(dimensions: dim, eps: 1e-6, affine: false)
        self.linear = linear
        self.adaLNSiLU = SiLU()
        self.adaLNLinear = adaLNLinear
        super.init()
    }

    public func callAsFunction(_ x: MLXArray, _ c: MLXArray) -> MLXArray {
        let scale = adaLNLinear(adaLNSiLU(c))
        return linear(normFinal(x) * (1 + scale.expandedDimensions(axis: -2)))
    }
}
