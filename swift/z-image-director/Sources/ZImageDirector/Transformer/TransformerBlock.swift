//
//  TransformerBlock.swift
//  ZImageDirector
//
//  Port of app/transformer.py:ZImageTransformerBlock + FinalLayer.
//

import Foundation
import MLX
import MLXNN

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
        adalnInput: MLXArray? = nil, cos: MLXArray? = nil, sin: MLXArray? = nil
    ) -> MLXArray {
        var x = x
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

            let normX = attentionNorm1(x) * (1 + scaleMsa)
            let attnOut = attention(normX, mask: mask, positions: positions, cos: cos, sin: sin)
            x = x + MLX.tanh(gateMsa) * attentionNorm2(attnOut)

            let normFfn = ffnNorm1(x) * (1 + scaleMlp)
            x = x + MLX.tanh(gateMlp) * ffnNorm2(feedForward(normFfn))
        } else {
            x = x + attentionNorm2(attention(attentionNorm1(x), mask: mask, positions: positions, cos: cos, sin: sin))
            x = x + ffnNorm2(feedForward(ffnNorm1(x)))
        }
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
