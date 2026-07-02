//
//  GemmaAttention.swift
//  LTXVideoDirector
//
//  Native port of mlx-lm gemma3_text.Attention — multi-head attention with:
//    - GQA (n_kv_heads=8 < n_heads=16, repeats=2; MLX sdpa handles natively)
//    - QK RMSNorm applied AFTER reshape to (B, n_heads, L, head_dim), over head_dim
//    - Two RoPE configs: sliding layers (base=1e4, scale=1), global layers
//      (base=1e6, scale=1/8 linear). SPLIT layout (traditional=False).
//    - scale = query_pre_attn_scalar ** -0.5  (NOT head_dim**-0.5)
//    - All projections bias-free.
//

import Foundation
import MLX

public struct GemmaAttention {
    public let config: GemmaConfig
    public let layerIdx: Int
    public let qProjWeight: MLXArray   // (n_heads*head_dim, hidden) = (4096, 3840)
    public let kProjWeight: MLXArray   // (n_kv_heads*head_dim, hidden) = (2048, 3840)
    public let vProjWeight: MLXArray   // (n_kv_heads*head_dim, hidden) = (2048, 3840)
    public let oProjWeight: MLXArray   // (hidden, n_heads*head_dim) = (3840, 4096)
    public let qNorm: GemmaRMSNorm     // over head_dim (256)
    public let kNorm: GemmaRMSNorm
    public let scale: Float
    public let ropeBase: Float
    public let ropeScale: Float

    public init(config: GemmaConfig, layerIdx: Int,
                qProjWeight: MLXArray, kProjWeight: MLXArray, vProjWeight: MLXArray, oProjWeight: MLXArray,
                qNormWeight: MLXArray, kNormWeight: MLXArray) {
        self.config = config
        self.layerIdx = layerIdx
        self.qProjWeight = qProjWeight
        self.kProjWeight = kProjWeight
        self.vProjWeight = vProjWeight
        self.oProjWeight = oProjWeight
        self.qNorm = GemmaRMSNorm(weight: qNormWeight, eps: config.rmsNormEps)
        self.kNorm = GemmaRMSNorm(weight: kNormWeight, eps: config.rmsNormEps)
        self.scale = Float(Foundation.pow(Double(config.queryPreAttnScalar), -0.5))
        let sliding = config.isSliding(layerIdx: layerIdx)
        self.ropeBase = sliding ? config.ropeLocalBaseFreq : config.ropeTheta
        self.ropeScale = sliding ? 1.0 : 1.0 / config.ropeScalingFactor
    }

    /// mask: (B, 1, T, T) combined causal+padding, or nil.
    public func callAsFunction(_ x: MLXArray, mask: MLXArray?) -> MLXArray {
        let B = x.dim(0), L = x.dim(1)
        let nH = config.numAttentionHeads, nKv = config.numKeyValueHeads, hd = config.headDim

        var q = MLX.matmul(x, qProjWeight.transposed(-1, -2)).reshaped([B, L, nH, hd]).transposed(0, 2, 1, 3)
        var k = MLX.matmul(x, kProjWeight.transposed(-1, -2)).reshaped([B, L, nKv, hd]).transposed(0, 2, 1, 3)
        let v = MLX.matmul(x, vProjWeight.transposed(-1, -2)).reshaped([B, L, nKv, hd]).transposed(0, 2, 1, 3)

        q = qNorm(q)
        k = kNorm(k)

        q = MLXFast.RoPE(q, dimensions: hd, traditional: false, base: ropeBase, scale: ropeScale, offset: 0)
        k = MLXFast.RoPE(k, dimensions: hd, traditional: false, base: ropeBase, scale: ropeScale, offset: 0)

        let out = MLXFast.scaledDotProductAttention(queries: q, keys: k, values: v, scale: scale, mask: mask)
        let outR = out.transposed(0, 2, 1, 3).reshaped([B, L, nH * hd])
        return MLX.matmul(outR, oProjWeight.transposed(-1, -2))
    }
}
