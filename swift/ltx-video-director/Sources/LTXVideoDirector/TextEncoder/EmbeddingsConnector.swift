//
//  EmbeddingsConnector.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.text_encoders.gemma.embeddings_connector —
//  the LTX-specific "connector" that refines Gemma's projected text hidden
//  states into the video/audio conditioning embeddings the DiT consumes.
//  This is NOT the Gemma LLM itself (that stays bridged via RunPyBridge /
//  mlx-lm — hand-porting a 12B+ decoder LLM is out of scope for this port);
//  it's the small transformer stack downstream of it.
//
//  ConnectorAttention/ConnectorFeedForward are architecturally identical to
//  Attention.swift/FeedForward.swift (same self-attention-with-RoPE-and-
//  gating math, same Linear->GELU-approx->Linear FFN) — reused directly,
//  just with different checkpoint key names (`to_out.0.*` list-wrapped,
//  `ff.net.0.proj.*`/`ff.net.2.*`), handled by the loader in
//  TransformerCheckpointLoader-style call sites, not by new components.
//
//  Scope: the "no attention_mask" path (registers appended at the end,
//  `mx.concatenate([hidden_states, registers], axis=1)`) — the simpler of
//  the reference's two register-injection branches. NOT YET PORTED: the
//  left-padding replacement branch (`_replace_padding_with_registers`,
//  used when Gemma's tokenizer left-pads and a real attention_mask is
//  passed) — needed once the actual Gemma tokenizer/encoder is wired in.
//

import MLX
import MLXNN

public struct ConnectorTransformerBlock {
    public let attn: Attention
    public let ff: FeedForward
    public let normEps: Float

    public init(attn: Attention, ff: FeedForward, normEps: Float = 1e-6) {
        self.attn = attn
        self.ff = ff
        self.normEps = normEps
    }

    private func rmsNormNoAffine(_ x: MLXArray) -> MLXArray {
        let xf = x.asType(.float32)
        let meanSquare = (xf * xf).mean(axis: -1, keepDims: true)
        return xf / MLX.sqrt(meanSquare + normEps)
    }

    /// Pre-norm (affine-free) + attention + residual, then pre-norm + ff + residual.
    public func callAsFunction(_ x: MLXArray, ropeFreqs: RoPE.Freqs?, attentionMask: MLXArray? = nil) -> MLXArray {
        var h = x
        var normed = rmsNormNoAffine(h)
        h = h + attn(normed, ropeFreqs: ropeFreqs, attentionMask: attentionMask)
        normed = rmsNormNoAffine(h)
        h = h + ff(normed)
        return h
    }
}

public struct Embeddings1DConnector {
    public let learnableRegisters: MLXArray  // (numRegisters, dim)
    public let blocks: [ConnectorTransformerBlock]
    public let dim: Int
    public let headDim: Int
    public let maxPos: Int
    public let normOutput: Bool
    public let ropeTheta: Double

    public init(learnableRegisters: MLXArray, blocks: [ConnectorTransformerBlock], dim: Int, headDim: Int, maxPos: Int = 4096, normOutput: Bool = true, ropeTheta: Double = 10000.0) {
        self.learnableRegisters = learnableRegisters
        self.blocks = blocks
        self.dim = dim
        self.headDim = headDim
        self.maxPos = maxPos
        self.normOutput = normOutput
        self.ropeTheta = ropeTheta
    }

    private func rmsNormNoAffine(_ x: MLXArray, eps: Float = 1e-6) -> MLXArray {
        let xf = x.asType(.float32)
        let meanSquare = (xf * xf).mean(axis: -1, keepDims: true)
        return xf / MLX.sqrt(meanSquare + eps)
    }

    /// Refine `hiddenStates` (B, seqLen, dim) through the transformer stack.
    /// `attentionMask` nil (the only path ported so far): appends register
    /// tokens at the end rather than replacing left-padding positions.
    public func callAsFunction(_ hiddenStates: MLXArray, attentionMask: MLXArray? = nil) -> MLXArray {
        precondition(attentionMask == nil, "left-padding register-replacement not yet ported — see file header")

        var h = hiddenStates
        let numRegisters = learnableRegisters.dim(0)
        if numRegisters > 0 {
            let b = h.dim(0)
            let registers = MLX.broadcast(learnableRegisters.expandedDimensions(axis: 0), to: [b, numRegisters, dim])
            h = MLX.concatenated([h, registers], axis: 1)
        }

        let seqLen = h.dim(1)
        let numHeads = dim / headDim
        let positions = MLX.arange(seqLen).asType(.float32).reshaped([1, seqLen, 1])
        let ropeFreqs = RoPE.precomputeSplit(positions: positions.asType(.int32), innerDim: dim, numHeads: numHeads, theta: ropeTheta, maxPos: [maxPos])

        for block in blocks {
            h = block(h, ropeFreqs: ropeFreqs)
            MLX.eval(h)
        }

        if normOutput {
            h = rmsNormNoAffine(h)
        }
        return h
    }
}
