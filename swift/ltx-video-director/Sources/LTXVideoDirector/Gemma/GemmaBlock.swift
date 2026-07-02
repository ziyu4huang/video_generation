//
//  GemmaBlock.swift
//  LTXVideoDirector
//
//  Native port of mlx-lm gemma3_text.TransformerBlock:
//    r = self_attn(input_layernorm(x), mask)
//    h = x + post_attention_layernorm(r)        # clip_residual in fp16
//    r = mlp(pre_feedforward_layernorm(h))
//    out = h + post_feedforward_layernorm(r)
//
//  clip_residual clamps fp16 residuals to avoid overflow; in float32 (this
//  port upcasts dequantized weights) it's a plain add. We keep the clip for
//  fidelity if the input arrives as float16.
//

import MLX

public struct GemmaBlock {
    public let attention: GemmaAttention
    public let mlp: GemmaMLP
    public let inputLayernorm: GemmaRMSNorm
    public let postAttentionLayernorm: GemmaRMSNorm
    public let preFeedforwardLayernorm: GemmaRMSNorm
    public let postFeedforwardLayernorm: GemmaRMSNorm

    public init(attention: GemmaAttention, mlp: GemmaMLP,
                inputLayernorm: GemmaRMSNorm, postAttentionLayernorm: GemmaRMSNorm,
                preFeedforwardLayernorm: GemmaRMSNorm, postFeedforwardLayernorm: GemmaRMSNorm) {
        self.attention = attention
        self.mlp = mlp
        self.inputLayernorm = inputLayernorm
        self.postAttentionLayernorm = postAttentionLayernorm
        self.preFeedforwardLayernorm = preFeedforwardLayernorm
        self.postFeedforwardLayernorm = postFeedforwardLayernorm
    }

    public func callAsFunction(_ x: MLXArray, mask: MLXArray?) -> MLXArray {
        let r = attention(inputLayernorm(x), mask: mask)
        let h = clipResidual(x, postAttentionLayernorm(r))
        let r2 = mlp(preFeedforwardLayernorm(h))
        return clipResidual(h, postFeedforwardLayernorm(r2))
    }

    /// Reference clip_residual: fp16 inputs are clipped to fp16 max to prevent
    /// overflow accumulation across 48 layers; other dtypes add directly.
    private func clipResidual(_ x: MLXArray, _ y: MLXArray) -> MLXArray {
        if x.dtype == .float16 {
            let bound = Float(65504.0)  // fp16 max
            return MLX.clip(x.asType(.float32) + y.asType(.float32), min: -bound, max: bound).asType(.float16)
        }
        return x + y
    }
}
