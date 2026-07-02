//
//  Attention.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.transformer.attention.Attention —
//  multi-head (self- or cross-) attention with QK RMSNorm, RoPE (SPLIT
//  layout only — see RoPE.swift), STG perturbation blending, and per-head
//  sigmoid gating. This is where RoPE actually gets applied and is the
//  attention primitive both the video self-attention and video<->audio
//  cross-attention in the 48-layer DiT reuse.
//

import Foundation
import MLX
import MLXNN

public struct Attention {
    public let numHeads: Int
    public let headDim: Int
    public let scale: Float
    public let useRope: Bool

    public let toQWeight: MLXArray, toQBias: MLXArray?
    public let toKWeight: MLXArray, toKBias: MLXArray?
    public let toVWeight: MLXArray, toVBias: MLXArray?
    public let toOutWeight: MLXArray, toOutBias: MLXArray
    public let toGateLogitsWeight: MLXArray?, toGateLogitsBias: MLXArray?
    public let qNormWeight: MLXArray, kNormWeight: MLXArray
    public let normEps: Float

    public init(
        numHeads: Int, headDim: Int, useRope: Bool = true, normEps: Float = 1e-6,
        toQWeight: MLXArray, toQBias: MLXArray?,
        toKWeight: MLXArray, toKBias: MLXArray?,
        toVWeight: MLXArray, toVBias: MLXArray?,
        toOutWeight: MLXArray, toOutBias: MLXArray,
        toGateLogitsWeight: MLXArray?, toGateLogitsBias: MLXArray?,
        qNormWeight: MLXArray, kNormWeight: MLXArray
    ) {
        self.numHeads = numHeads
        self.headDim = headDim
        self.scale = Float(Foundation.pow(Double(headDim), -0.5))
        self.useRope = useRope
        self.normEps = normEps
        self.toQWeight = toQWeight; self.toQBias = toQBias
        self.toKWeight = toKWeight; self.toKBias = toKBias
        self.toVWeight = toVWeight; self.toVBias = toVBias
        self.toOutWeight = toOutWeight; self.toOutBias = toOutBias
        self.toGateLogitsWeight = toGateLogitsWeight; self.toGateLogitsBias = toGateLogitsBias
        self.qNormWeight = qNormWeight; self.kNormWeight = kNormWeight
    }

    private func linear(_ x: MLXArray, weight: MLXArray, bias: MLXArray?) -> MLXArray {
        let y = MLX.matmul(x, weight.transposed(1, 0))
        return bias.map { y + $0 } ?? y
    }

    /// - Parameters:
    ///   - x: (B, N, queryDim)
    ///   - encoderHiddenStates: cross-attention keys/values if not nil (else self-attention on x)
    ///   - ropeFreqs: (cos, sin) for Q (and K if ropeFreqsK is nil) — SPLIT layout only
    ///   - ropeFreqsK: separate RoPE frequencies for K (cross-attention)
    ///   - attentionMask: optional mask broadcastable to (B, 1, Nq, Nk)
    ///   - perturbationMask: STG perturbation mask (B,1,1,1); blends attn output with V
    public func callAsFunction(
        _ x: MLXArray, encoderHiddenStates: MLXArray? = nil,
        ropeFreqs: RoPE.Freqs? = nil, ropeFreqsK: RoPE.Freqs? = nil,
        attentionMask: MLXArray? = nil, perturbationMask: MLXArray? = nil
    ) -> MLXArray {
        let b = x.dim(0)
        let kvInput = encoderHiddenStates ?? x

        var q = linear(x, weight: toQWeight, bias: toQBias)
        var k = linear(kvInput, weight: toKWeight, bias: toKBias)
        var v = linear(kvInput, weight: toVWeight, bias: toVBias)

        q = MLX.rmsNorm(q, weight: qNormWeight, eps: normEps)
        k = MLX.rmsNorm(k, weight: kNormWeight, eps: normEps)

        q = q.reshaped([b, -1, numHeads, headDim]).transposed(0, 2, 1, 3)
        k = k.reshaped([b, -1, numHeads, headDim]).transposed(0, 2, 1, 3)
        v = v.reshaped([b, -1, numHeads, headDim]).transposed(0, 2, 1, 3)

        if useRope, let ropeFreqs {
            q = RoPE.applySplit(q, cos: ropeFreqs.cos, sin: ropeFreqs.sin)
            let freqsK = ropeFreqsK ?? ropeFreqs
            k = RoPE.applySplit(k, cos: freqsK.cos, sin: freqsK.sin)
        }

        var out = MLX.scaledDotProductAttention(queries: q, keys: k, values: v, scale: scale, mask: attentionMask)

        if let perturbationMask {
            out = out * perturbationMask + v * (1.0 - perturbationMask)
        }

        if let toGateLogitsWeight, let toGateLogitsBias {
            let gateLogits = linear(x, weight: toGateLogitsWeight, bias: toGateLogitsBias)  // (B, N, numHeads)
            let gate = 2.0 * MLX.sigmoid(gateLogits)
            let gateT = gate.transposed(0, 2, 1).expandedDimensions(axis: -1)  // (B, heads, N, 1)
            out = out * gateT
        }

        out = out.transposed(0, 2, 1, 3).reshaped([b, -1, numHeads * headDim])
        return linear(out, weight: toOutWeight, bias: toOutBias)
    }
}
