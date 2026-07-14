//
//  KontextTransformer.swift
//  Flux2Director
//
//  Part of the `kontext` (FLUX.1-Kontext-dev) native-port epic — see
//  output/next-goal-20260714_063909.md, phase 2 (the epic's main engineering
//  volume). Ported directly from mflux's base-FLUX.1 transformer:
//  `../mflux/src/mflux/models/flux/model/flux_transformer/{transformer,
//  joint_transformer_block, single_transformer_block, joint_attention,
//  single_block_attention, ada_layer_norm_zero, ada_layer_norm_zero_single,
//  ada_layer_norm_continuous, embed_nd, time_text_embed, timestep_embedder,
//  guidance_embedder, text_embedder, feed_forward,
//  common.attention_utils}.py`.
//
//  Architecture (per HF config.json, confirmed phase 1 of the epic):
//    - 19 joint (double) blocks + 38 single blocks
//    - inner_dim = 24 heads * 128 head_dim = 3072
//    - in_channels=64 (x_embedder input, standard FLUX.1 packing — see
//      KontextConditioning.swift), context dim=4096 (T5), pooled dim=768 (CLIP)
//    - axes_dims_rope=[16,56,56] (3-tuple, sums to 128=head_dim), rope_theta=10000
//    - guidance_embeds=true (CFG-distilled guidance embedding IS used, unlike
//      Klein-9B's guidance_embeds=false)
//    - mlp_ratio=4.0 (proj_mlp: 3072→12288, vs Klein-9B's mlp_ratio=3.0)
//
//  DISTINCT from `Flux2Transformer.swift` (Klein-9B): different block counts,
//  different channel dims, a genuinely different RoPE formulation (base FLUX.1
//  applies RoPE via a stacked 2x2 rotation-matrix multiply — see `applyRope`
//  below — not the cos/sin-split form `Flux2PosEmbed`/`applyRopeCosSin` use
//  for Klein-9B; the two are mathematically related but the code paths do not
//  share implementation, ported independently and separately from
//  mflux's two distinct `attention_utils.py` functions
//  `apply_rope`/`apply_rope_bshd`), and Linear/RMSNorm here are UNQUANTIZED
//  (base FLUX.1-dev weights, unlike Klein-9B's 8-bit `F2QLinear`) — swap in
//  quantized variants once real Kontext weights are converted and their
//  quantization scheme (if any) is known.
//
//  NOT YET VERIFIED against real weights/mflux numeric output (no converted
//  Kontext-dev checkpoint exists yet — that's phase 1's still-open VAE/
//  transformer conversion action item). This file is structurally verified
//  only: it builds, and a forward pass with random weights at small
//  dimensions produces the expected output shape (see
//  `KontextTransformerShapeTests` — run manually via a throwaway driver,
//  since this package has no XCTest target configured).
//

import Foundation
import MLX
import MLXNN
import MLXFast
import MLXRandom

// MARK: - Norms (unquantized, plain FLUX.1 weights)

/// RMSNorm, weight-only (matches mflux's `nn.RMSNorm(128)` — norm_q/norm_k
/// on each attention head's 128-dim slice).
struct KTxRMSNorm {
    let weight: MLXArray
    let eps: Float = 1e-5

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        MLXFast.rmsNorm(x, weight: weight, eps: eps)
    }
}

/// LayerNorm with affine=False, eps=1e-6 (matches `nn.LayerNorm(dims, eps=1e-6, affine=False)`).
struct KTxLayerNormNoAffine {
    let eps: Float = 1e-6
    func callAsFunction(_ x: MLXArray) -> MLXArray {
        MLXFast.layerNorm(x, weight: nil, bias: nil, eps: eps)
    }
}

// MARK: - RoPE (EmbedND — stacked 2x2 rotation-matrix form)

/// Port of mflux's `EmbedND`: builds a per-token rotation-matrix tensor from
/// 3-tuple position ids (matches `axes_dims_rope=[16,56,56]`).
enum KontextRoPE {
    static let axesDim = [16, 56, 56]
    static let theta: Float = 10000

    /// `ids`: (B, S, 3) int/float position ids (concat of text ids + image ids).
    /// Returns freqs_cis: (B, 1, S, headDim/2, 2, 2).
    static func embed(ids: MLXArray) -> MLXArray {
        var parts: [MLXArray] = []
        for i in 0..<3 {
            parts.append(rope(pos: ids[0..., 0..., i], dim: axesDim[i], theta: theta))
        }
        // Concatenate along the dim/2 axis (axis -3 of each (B,S,dim/2,2,2) piece).
        let emb = MLX.concatenated(parts, axis: 2)   // (B, S, sum(dim/2), 2, 2)
        return emb.expandedDimensions(axis: 1)        // (B, 1, S, headDim/2, 2, 2)
    }

    private static func rope(pos: MLXArray, dim: Int, theta: Float) -> MLXArray {
        let scale = MLX.arange(0, dim, step: 2, dtype: .float32) / Float(dim)
        let omega = 1.0 / MLX.pow(MLXArray(theta), scale)   // (dim/2,)
        let posF = pos.asType(.float32)                      // (B, S)
        let posExpanded = posF.expandedDimensions(axis: -1)   // (B, S, 1)
        let omegaExpanded = omega.expandedDimensions(axis: 0) // (1, dim/2) -> broadcasts
        let out = posExpanded * omegaExpanded                 // (B, S, dim/2)
        let cosOut = MLX.cos(out)
        let sinOut = MLX.sin(out)
        // stack([cos, -sin, sin, cos], axis=-1) -> (B, S, dim/2, 4) -> reshape (B, S, dim/2, 2, 2)
        let stacked = MLX.stacked([cosOut, -sinOut, sinOut, cosOut], axis: -1)
        let (b, s, half) = (stacked.dim(0), stacked.dim(1), stacked.dim(2))
        return stacked.reshaped([b, s, half, 2, 2])
    }

    /// Apply rotary embedding to Q/K: matches mflux's `AttentionUtils.apply_rope`.
    /// `xq`/`xk`: (B, H, S, headDim). `freqsCis`: (B, 1, S, headDim/2, 2, 2).
    /// Returns rotated (xq, xk) in float32 — Python's `apply_rope` does NOT
    /// cast back to the pre-rope dtype (verified 2026-07-14: an earlier
    /// downcast-before-SDPA here was the actual bug behind a cos=0.977 parity
    /// failure — `compute_attention` really is called with fp32 q/k against a
    /// bf16 value, MLX's SDPA handles the mixed precision; do not "fix" that
    /// by casting q/k down, it silently diverges from the real model).
    static func apply(xq: MLXArray, xk: MLXArray, freqsCis: MLXArray) -> (MLXArray, MLXArray) {
        func mix(_ x: MLXArray) -> MLXArray {
            let xf = x.asType(.float32)
            let shape = xf.shape
            let x2 = xf.reshaped(Array(shape.dropLast()) + [-1, 1, 2])  // (...,-1,1,2)
            let c0 = freqsCis[.ellipsis, 0]   // (B,1,S,half,2)
            let c1 = freqsCis[.ellipsis, 1]   // (B,1,S,half,2)
            let x0 = x2[.ellipsis, 0]         // (B,H,S,half,1)
            let x1 = x2[.ellipsis, 1]         // (B,H,S,half,1)
            let out = c0 * x0 + c1 * x1        // (B,H,S,half,2) via broadcast
            return out.reshaped(shape)
        }
        return (mix(xq), mix(xk))
    }
}

// MARK: - Text/time/guidance embedders

struct KTxTimestepEmbedder {
    let linear1: MLXNN.Linear
    let linear2: MLXNN.Linear
    func callAsFunction(_ x: MLXArray) -> MLXArray { linear2(silu(linear1(x))) }
}

struct KTxTextEmbedder {
    let linear1: MLXNN.Linear
    let linear2: MLXNN.Linear
    func callAsFunction(_ x: MLXArray) -> MLXArray { linear2(silu(linear1(x))) }
}

/// Sinusoidal timestep projection (matches `TimeTextEmbed._time_proj`).
func timeProj(_ timeSteps: MLXArray, halfDim: Int = 128, maxPeriod: Float = 10000) -> MLXArray {
    let exponent = (-Foundation.log(maxPeriod)) * MLX.arange(0, halfDim, dtype: .float32) / Float(halfDim)
    let embBase = MLX.exp(exponent)                              // (halfDim,)
    let emb = timeSteps.expandedDimensions(axis: 1).asType(.float32) * embBase.expandedDimensions(axis: 0)
    let sinPart = MLX.sin(emb)
    let cosPart = MLX.cos(emb)
    let full = MLX.concatenated([sinPart, cosPart], axis: -1)     // (B, 2*halfDim)
    // Python: concat([emb[:, half:], emb[:, :half]]) — swap halves.
    return MLX.concatenated([full[0..., halfDim...], full[0..., 0..<halfDim]], axis: -1)
}

struct KTxTimeTextEmbed {
    let textEmbedder: KTxTextEmbedder
    let timestepEmbedder: KTxTimestepEmbedder
    let guidanceEmbedder: KTxTimestepEmbedder?   // same shape as timestep embedder
    /// Matches Python's `ModelConfig.precision` (bf16 in production). Exposed
    /// so `verify-kontext-transformer` can run the whole model in float32 —
    /// isolates algorithm correctness from bf16 rounding, which turned out to
    /// matter a lot at t=0 (sigma=1.0, the most extreme conditioning
    /// magnitude): see the 2026-07-14 KTxFeedForward note below.
    var precision: DType = .bfloat16

    func callAsFunction(timeStep: MLXArray, pooledProjection: MLXArray, guidance: MLXArray) -> MLXArray {
        var timeStepsEmb = timestepEmbedder(timeProj(timeStep))
        if let guidanceEmbedder {
            timeStepsEmb = timeStepsEmb + guidanceEmbedder(timeProj(guidance))
        }
        let pooled = textEmbedder(pooledProjection)
        return (timeStepsEmb + pooled).asType(precision)
    }
}

// MARK: - AdaLN

struct KTxAdaLayerNormZero {
    let linear: MLXNN.Linear    // 3072 -> 18432
    let dim: Int = 3072

    /// Returns (normedHidden, gateMSA, shiftMLP, scaleMLP, gateMLP).
    func callAsFunction(_ hidden: MLXArray, textEmbeddings: MLXArray) -> (MLXArray, MLXArray, MLXArray, MLXArray, MLXArray) {
        let te = linear(silu(textEmbeddings))     // (B, 18432)
        let chunk = 18432 / 6
        let shiftMsa = te[0..., (0 * chunk)..<(1 * chunk)]
        let scaleMsa = te[0..., (1 * chunk)..<(2 * chunk)]
        let gateMsa = te[0..., (2 * chunk)..<(3 * chunk)]
        let shiftMlp = te[0..., (3 * chunk)..<(4 * chunk)]
        let scaleMlp = te[0..., (4 * chunk)..<(5 * chunk)]
        let gateMlp = te[0..., (5 * chunk)..<(6 * chunk)]
        let normed = KTxLayerNormNoAffine()(hidden)
        let out = normed * (1 + scaleMsa.expandedDimensions(axis: 1)) + shiftMsa.expandedDimensions(axis: 1)
        return (out, gateMsa, shiftMlp, scaleMlp, gateMlp)
    }
}

struct KTxAdaLayerNormZeroSingle {
    let linear: MLXNN.Linear    // 3072 -> 9216

    /// Returns (normedHidden, gate).
    func callAsFunction(_ hidden: MLXArray, textEmbeddings: MLXArray) -> (MLXArray, MLXArray) {
        let te = linear(silu(textEmbeddings))
        let chunk = 9216 / 3
        let shiftMsa = te[0..., (0 * chunk)..<(1 * chunk)]
        let scaleMsa = te[0..., (1 * chunk)..<(2 * chunk)]
        let gateMsa = te[0..., (2 * chunk)..<(3 * chunk)]
        let normed = KTxLayerNormNoAffine()(hidden)
        let out = normed * (1 + scaleMsa.expandedDimensions(axis: 1)) + shiftMsa.expandedDimensions(axis: 1)
        return (out, gateMsa)
    }
}

struct KTxAdaLayerNormContinuous {
    let linear: MLXNN.Linear    // conditioningDim -> embeddingDim*2, bias=false
    let embeddingDim: Int
    var precision: DType = .bfloat16   // see KTxTimeTextEmbed.precision

    func callAsFunction(_ x: MLXArray, textEmbeddings: MLXArray) -> MLXArray {
        let te = linear(silu(textEmbeddings).asType(precision))
        let scale = te[0..., 0..<embeddingDim]
        let shift = te[0..., embeddingDim..<(2 * embeddingDim)]
        let normed = KTxLayerNormNoAffine()(x)
        return normed * (1 + scale.expandedDimensions(axis: 1)) + shift.expandedDimensions(axis: 1)
    }
}

// MARK: - Feed-forward

struct KTxFeedForward {
    let linear1: MLXNN.Linear   // 3072 -> 12288
    let linear2: MLXNN.Linear   // 12288 -> 3072
    let approximate: Bool       // true -> gelu_approx (tanh), false -> exact gelu

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let h = linear1(x)
        let act = approximate ? MLXNN.geluApproximate(h) : MLXNN.gelu(h)
        return linear2(act)
    }
}

// MARK: - Attention

private func headSplit(_ x: MLXArray, batch: Int, heads: Int, headDim: Int) -> MLXArray {
    // (B, S, H*D) -> (B, H, S, D)
    let seq = x.dim(1)
    return x.reshaped([batch, seq, heads, headDim]).transposed(0, 2, 1, 3)
}

private func headMerge(_ x: MLXArray, batch: Int, heads: Int, headDim: Int) -> MLXArray {
    // (B, H, S, D) -> (B, S, H*D)
    let merged = x.transposed(0, 2, 1, 3)
    return merged.reshaped([batch, merged.dim(1), heads * headDim])
}

private func processQKV(_ x: MLXArray, toQ: MLXNN.Linear, toK: MLXNN.Linear, toV: MLXNN.Linear,
                        normQ: KTxRMSNorm, normK: KTxRMSNorm, heads: Int, headDim: Int) -> (MLXArray, MLXArray, MLXArray) {
    let batch = x.dim(0)
    var q = headSplit(toQ(x), batch: batch, heads: heads, headDim: headDim)
    var k = headSplit(toK(x), batch: batch, heads: heads, headDim: headDim)
    let v = headSplit(toV(x), batch: batch, heads: heads, headDim: headDim)
    q = normQ(q.asType(.float32)).asType(x.dtype)
    k = normK(k.asType(.float32)).asType(x.dtype)
    return (q, k, v)
}

struct KTxJointAttention {
    let toQ, toK, toV, toOut, addQProj, addKProj, addVProj, toAddOut: MLXNN.Linear
    let normQ, normK, normAddedQ, normAddedK: KTxRMSNorm
    let heads: Int = 24
    let headDim: Int = 128

    func callAsFunction(hidden: MLXArray, encoderHidden: MLXArray, freqsCis: MLXArray) -> (MLXArray, MLXArray) {
        let batch = hidden.dim(0)
        let (q, k, v) = processQKV(hidden, toQ: toQ, toK: toK, toV: toV, normQ: normQ, normK: normK, heads: heads, headDim: headDim)
        let (eq, ek, ev) = processQKV(encoderHidden, toQ: addQProj, toK: addKProj, toV: addVProj, normQ: normAddedQ, normK: normAddedK, heads: heads, headDim: headDim)

        var query = MLX.concatenated([eq, q], axis: 2)
        var key = MLX.concatenated([ek, k], axis: 2)
        let value = MLX.concatenated([ev, v], axis: 2)

        (query, key) = KontextRoPE.apply(xq: query, xk: key, freqsCis: freqsCis)

        let scale: Float = 1.0 / Float(headDim).squareRoot()
        let attnOut = MLXFast.scaledDotProductAttention(queries: query, keys: key, values: value, scale: scale, mask: nil)
        let merged = headMerge(attnOut, batch: batch, heads: heads, headDim: headDim)

        let encLen = encoderHidden.dim(1)
        let encoderOut = merged[0..., 0..<encLen, 0...]
        let hiddenOut = merged[0..., encLen..., 0...]
        return (toOut(hiddenOut), toAddOut(encoderOut))
    }
}

struct KTxSingleBlockAttention {
    let toQ, toK, toV: MLXNN.Linear
    let normQ, normK: KTxRMSNorm
    let heads: Int = 24
    let headDim: Int = 128

    func callAsFunction(hidden: MLXArray, freqsCis: MLXArray) -> MLXArray {
        let batch = hidden.dim(0)
        var (q, k, v) = processQKV(hidden, toQ: toQ, toK: toK, toV: toV, normQ: normQ, normK: normK, heads: heads, headDim: headDim)
        (q, k) = KontextRoPE.apply(xq: q, xk: k, freqsCis: freqsCis)
        let scale: Float = 1.0 / Float(headDim).squareRoot()
        let attnOut = MLXFast.scaledDotProductAttention(queries: q, keys: k, values: v, scale: scale, mask: nil)
        return headMerge(attnOut, batch: batch, heads: heads, headDim: headDim)
    }
}

// MARK: - Transformer blocks

struct KTxJointTransformerBlock {
    let norm1, norm1Context: KTxAdaLayerNormZero
    let attn: KTxJointAttention
    let ff, ffContext: KTxFeedForward

    func callAsFunction(hidden: MLXArray, encoderHidden: MLXArray, textEmbeddings: MLXArray, freqsCis: MLXArray) -> (MLXArray, MLXArray) {
        let (normHidden, gateMsa, shiftMlp, scaleMlp, gateMlp) = norm1(hidden, textEmbeddings: textEmbeddings)
        let (normEncHidden, cGateMsa, cShiftMlp, cScaleMlp, cGateMlp) = norm1Context(encoderHidden, textEmbeddings: textEmbeddings)

        let (attnOut, contextAttnOut) = attn(hidden: normHidden, encoderHidden: normEncHidden, freqsCis: freqsCis)

        let newHidden = KTxJointTransformerBlock.applyNormAndFF(
            hidden: hidden, attnOutput: attnOut, gateMsa: gateMsa, shiftMlp: shiftMlp, scaleMlp: scaleMlp, gateMlp: gateMlp, ff: ff)
        let newEncHidden = KTxJointTransformerBlock.applyNormAndFF(
            hidden: encoderHidden, attnOutput: contextAttnOut, gateMsa: cGateMsa, shiftMlp: cShiftMlp, scaleMlp: cScaleMlp, gateMlp: cGateMlp, ff: ffContext)
        return (newEncHidden, newHidden)
    }

    private static func applyNormAndFF(hidden: MLXArray, attnOutput: MLXArray, gateMsa: MLXArray,
                                       shiftMlp: MLXArray, scaleMlp: MLXArray, gateMlp: MLXArray,
                                       ff: KTxFeedForward) -> MLXArray {
        var h = hidden + gateMsa.expandedDimensions(axis: 1) * attnOutput
        var normH = KTxLayerNormNoAffine()(h)
        normH = normH * (1 + scaleMlp.expandedDimensions(axis: 1)) + shiftMlp.expandedDimensions(axis: 1)
        let ffOut = ff(normH)
        h = h + gateMlp.expandedDimensions(axis: 1) * ffOut
        return h
    }
}

struct KTxSingleTransformerBlock {
    let norm: KTxAdaLayerNormZeroSingle
    let attn: KTxSingleBlockAttention
    let projMlp: MLXNN.Linear     // 3072 -> 12288
    let projOut: MLXNN.Linear     // 15360 -> 3072

    func callAsFunction(hidden: MLXArray, textEmbeddings: MLXArray, freqsCis: MLXArray) -> MLXArray {
        let residual = hidden
        let (normHidden, gate) = norm(hidden, textEmbeddings: textEmbeddings)
        let attnOut = attn(hidden: normHidden, freqsCis: freqsCis)

        let mlpHidden = MLXNN.geluApproximate(projMlp(normHidden))
        let concatenated = MLX.concatenated([attnOut, mlpHidden], axis: 2)
        let out = gate.expandedDimensions(axis: 1) * projOut(concatenated)
        return residual + out
    }
}

// MARK: - Full transformer

public final class KontextTransformer {
    let posEmbed = KontextRoPE.self
    let xEmbedder: MLXNN.Linear         // 64 -> 3072
    let contextEmbedder: MLXNN.Linear   // 4096 -> 3072
    let timeTextEmbed: KTxTimeTextEmbed
    let jointBlocks: [KTxJointTransformerBlock]
    let singleBlocks: [KTxSingleTransformerBlock]
    let normOut: KTxAdaLayerNormContinuous
    let projOut: MLXNN.Linear           // 3072 -> 64

    init(xEmbedder: MLXNN.Linear, contextEmbedder: MLXNN.Linear,
               timeTextEmbed: KTxTimeTextEmbed, jointBlocks: [KTxJointTransformerBlock],
               singleBlocks: [KTxSingleTransformerBlock], normOut: KTxAdaLayerNormContinuous,
               projOut: MLXNN.Linear) {
        self.xEmbedder = xEmbedder
        self.contextEmbedder = contextEmbedder
        self.timeTextEmbed = timeTextEmbed
        self.jointBlocks = jointBlocks
        self.singleBlocks = singleBlocks
        self.normOut = normOut
        self.projOut = projOut
    }

    /// `hiddenStates`: (B, imgSeq, 64) packed noisy latents (+ optional Kontext
    /// reference tokens already concatenated by the caller, per
    /// `flux_kontext.py`'s `mx.concatenate([latents, static_image_latents], axis=1)`).
    /// `promptEmbeds`: (B, txtSeq, 4096) T5 embeddings. `pooledPromptEmbeds`: (B, 768) CLIP pooled.
    /// `imageIds`: (B, imgSeq, 3) — caller supplies (generation ids, optionally
    /// concatenated with Kontext reference ids, per `Transformer.compute_rotary_embeddings`).
    public func callAsFunction(timeStep: MLXArray, guidance: MLXArray, hiddenStates: MLXArray,
                               promptEmbeds: MLXArray, pooledPromptEmbeds: MLXArray,
                               imageIds: MLXArray) -> MLXArray {
        var hidden = xEmbedder(hiddenStates)
        var encoderHidden = contextEmbedder(promptEmbeds)
        let textEmbeddings = timeTextEmbed(timeStep: timeStep, pooledProjection: pooledPromptEmbeds, guidance: guidance)

        let txtIds = MLX.zeros([1, promptEmbeds.dim(1), 3], dtype: .float32)
        let ids = MLX.concatenated([txtIds, imageIds.asType(.float32)], axis: 1)
        let freqsCis = KontextRoPE.embed(ids: ids)

        for block in jointBlocks {
            (encoderHidden, hidden) = block(hidden: hidden, encoderHidden: encoderHidden, textEmbeddings: textEmbeddings, freqsCis: freqsCis)
        }

        var combined = MLX.concatenated([encoderHidden, hidden], axis: 1)
        for block in singleBlocks {
            combined = block(hidden: combined, textEmbeddings: textEmbeddings, freqsCis: freqsCis)
        }

        let encLen = encoderHidden.dim(1)
        var out = combined[0..., encLen..., 0...]
        out = normOut(out, textEmbeddings: textEmbeddings)
        out = projOut(out)
        return out
    }

    /// Diagnostic variant of `callAsFunction` that also returns intermediate
    /// tensors — for bisecting a numeric-parity mismatch against
    /// `gen_kontext_transformer_ref.py`'s matching capture points. Not used
    /// by the real forward path; exists purely for `verify-kontext-transformer`.
    public func debugForward(timeStep: MLXArray, guidance: MLXArray, hiddenStates: MLXArray,
                             promptEmbeds: MLXArray, pooledPromptEmbeds: MLXArray,
                             imageIds: MLXArray) -> [String: MLXArray] {
        var out: [String: MLXArray] = [:]
        var hidden = xEmbedder(hiddenStates)
        var encoderHidden = contextEmbedder(promptEmbeds)
        out["hidden_post_embed"] = hidden
        out["enc_post_embed"] = encoderHidden
        let textEmbeddings = timeTextEmbed(timeStep: timeStep, pooledProjection: pooledPromptEmbeds, guidance: guidance)
        out["temb"] = textEmbeddings

        let txtIds = MLX.zeros([1, promptEmbeds.dim(1), 3], dtype: .float32)
        let ids = MLX.concatenated([txtIds, imageIds.asType(.float32)], axis: 1)
        let freqsCis = KontextRoPE.embed(ids: ids)
        out["rope_c0"] = freqsCis[.ellipsis, 0]

        if let b0 = jointBlocks.first {
            let (normHidden, gateMsa, shiftMlp, scaleMlp, gateMlp) = b0.norm1(hidden, textEmbeddings: textEmbeddings)
            let (normEncHidden, _, _, _, _) = b0.norm1Context(encoderHidden, textEmbeddings: textEmbeddings)
            out["jb0_norm_hidden"] = normHidden
            out["jb0_norm_enc_hidden"] = normEncHidden
            let (attnOut, ctxAttnOut) = b0.attn(hidden: normHidden, encoderHidden: normEncHidden, freqsCis: freqsCis)
            out["jb0_attn_out"] = attnOut
            out["jb0_ctx_attn_out"] = ctxAttnOut
            out["jb0_gate_msa"] = gateMsa
            out["jb0_shift_mlp"] = shiftMlp
            out["jb0_scale_mlp"] = scaleMlp
            out["jb0_gate_mlp"] = gateMlp
            let hPostRes = hidden + gateMsa.expandedDimensions(axis: 1) * attnOut
            out["jb0_h_post_res"] = hPostRes
            var normH2 = KTxLayerNormNoAffine()(hPostRes)
            normH2 = normH2 * (1 + scaleMlp.expandedDimensions(axis: 1)) + shiftMlp.expandedDimensions(axis: 1)
            out["jb0_normh2mod"] = normH2
            out["jb0_ff_out"] = b0.ff(normH2)
        }

        for (i, block) in jointBlocks.enumerated() {
            (encoderHidden, hidden) = block(hidden: hidden, encoderHidden: encoderHidden, textEmbeddings: textEmbeddings, freqsCis: freqsCis)
            if i == 0 {
                out["enc_after_jb0"] = encoderHidden
                out["hidden_after_jb0"] = hidden
            }
        }
        out["enc_after_all_joint"] = encoderHidden
        out["hidden_after_all_joint"] = hidden

        var combined = MLX.concatenated([encoderHidden, hidden], axis: 1)
        for (i, block) in singleBlocks.enumerated() {
            combined = block(hidden: combined, textEmbeddings: textEmbeddings, freqsCis: freqsCis)
            if i == 0 {
                out["combined_after_sb0"] = combined
            }
        }
        out["combined_after_all_single"] = combined
        return out
    }

    // MARK: - Structural shape self-test (random weights, no real checkpoint)

    /// Build a `KontextTransformer` with randomly-initialized weights at the
    /// real architectural dims (24 heads * 128 head_dim = 3072 inner, 4096
    /// context dim, 768 pooled dim), but a caller-controlled block count —
    /// full 19+38 depth by default, override smaller for a fast smoke test.
    static func randomForTesting(numJointBlocks: Int = 19, numSingleBlocks: Int = 38) -> KontextTransformer {
        func lin(_ inDim: Int, _ outDim: Int, bias: Bool = true) -> MLXNN.Linear {
            MLXNN.Linear(inDim, outDim, bias: bias)
        }
        func rms(_ dim: Int) -> KTxRMSNorm { KTxRMSNorm(weight: MLX.ones([dim])) }

        func jointAttn() -> KTxJointAttention {
            KTxJointAttention(toQ: lin(3072, 3072), toK: lin(3072, 3072), toV: lin(3072, 3072),
                              toOut: lin(3072, 3072), addQProj: lin(3072, 3072), addKProj: lin(3072, 3072),
                              addVProj: lin(3072, 3072), toAddOut: lin(3072, 3072),
                              normQ: rms(128), normK: rms(128), normAddedQ: rms(128), normAddedK: rms(128))
        }
        func singleAttn() -> KTxSingleBlockAttention {
            KTxSingleBlockAttention(toQ: lin(3072, 3072), toK: lin(3072, 3072), toV: lin(3072, 3072),
                                    normQ: rms(128), normK: rms(128))
        }
        func ff(approximate: Bool) -> KTxFeedForward {
            KTxFeedForward(linear1: lin(3072, 12288), linear2: lin(12288, 3072), approximate: approximate)
        }

        let jointBlocks = (0..<numJointBlocks).map { _ in
            KTxJointTransformerBlock(
                norm1: KTxAdaLayerNormZero(linear: lin(3072, 18432)),
                norm1Context: KTxAdaLayerNormZero(linear: lin(3072, 18432)),
                attn: jointAttn(), ff: ff(approximate: false), ffContext: ff(approximate: true))
        }
        let singleBlocks = (0..<numSingleBlocks).map { _ in
            KTxSingleTransformerBlock(
                norm: KTxAdaLayerNormZeroSingle(linear: lin(3072, 9216)),
                attn: singleAttn(), projMlp: lin(3072, 12288), projOut: lin(3072 + 12288, 3072))
        }
        let timeTextEmbed = KTxTimeTextEmbed(
            textEmbedder: KTxTextEmbedder(linear1: lin(768, 3072), linear2: lin(3072, 3072)),
            timestepEmbedder: KTxTimestepEmbedder(linear1: lin(256, 3072), linear2: lin(3072, 3072)),
            guidanceEmbedder: KTxTimestepEmbedder(linear1: lin(256, 3072), linear2: lin(3072, 3072)))

        return KontextTransformer(
            xEmbedder: lin(64, 3072), contextEmbedder: lin(4096, 3072),
            timeTextEmbed: timeTextEmbed, jointBlocks: jointBlocks, singleBlocks: singleBlocks,
            normOut: KTxAdaLayerNormContinuous(linear: lin(3072, 3072 * 2, bias: false), embeddingDim: 3072),
            projOut: lin(3072, 64))
    }

    /// Runs a full-depth (19+38 block) forward pass at small sequence
    /// lengths with random weights/inputs — verifies every reshape/concat/
    /// broadcast in the block loop is dimensionally consistent end to end
    /// (the thing most likely to silently break in a 700-line 1:1 port).
    /// Not a numeric-parity check (no real weights exist yet) — returns a
    /// human-readable pass/fail summary for a CLI command to print.
    public static func shapeSelfTest() -> String {
        let transformer = KontextTransformer.randomForTesting()
        let batch = 1
        let imgSeq = 16   // e.g. a tiny 64x64 image: (64/16)*(64/16)=16 tokens
        let txtSeq = 8

        let hiddenStates = MLXRandom.normal([batch, imgSeq, 64])
        let promptEmbeds = MLXRandom.normal([batch, txtSeq, 4096])
        let pooledPromptEmbeds = MLXRandom.normal([batch, 768])
        let imageIds = KontextUtil.createGenerationImageIds(height: 64, width: 64)   // (1, 16, 3), leading id=0
        let timeStep = MLXArray([Float(0.5)])
        let guidance = MLXArray([Float(2.5)])

        let out = transformer(timeStep: timeStep, guidance: guidance, hiddenStates: hiddenStates,
                              promptEmbeds: promptEmbeds, pooledPromptEmbeds: pooledPromptEmbeds, imageIds: imageIds)
        MLX.eval(out)

        let expected = [batch, imgSeq, 64]
        let ok = out.shape == expected
        return ok
            ? "PASS: KontextTransformer 19+38-block forward pass shape OK — output \(out.shape) == expected \(expected)"
            : "FAIL: output shape \(out.shape) != expected \(expected)"
    }
}

// MARK: - Real-weight loader (kontext epic phase 2, item (a)+(b))
//
// `FluxWeightMapping.get_transformer_mapping()`
// (`../mflux/src/mflux/models/flux/weights/flux_weight_mapping.py`) maps
// most transformer keys to themselves — but NOT all: the feed-forward layers
// are renamed (`ff.net.0.proj`→`ff.linear1`, `ff.net.2`→`ff.linear2`, same
// for `ff_context`), confirmed the hard way (a force-unwrap crash) before
// being read carefully. Every other key (attention, norms, embedders) is a
// true identity mapping. No Conv2d transposes needed here (unlike the VAE) —
// this is pure Linear/Norm, so no tensor-value transform, just renames.
// Kontext-dev ships unquantized bf16, matching this file's unquantized
// `MLXNN.Linear`/`KTxRMSNorm`.

public struct KontextTransformerWeights {
    public let arrays: [String: MLXArray]
    public let numJointBlocks: Int
    public let numSingleBlocks: Int

    /// `dir` — a directory containing the raw HF `diffusion_pytorch_model-*-of-*.safetensors`
    /// shards (e.g. the `transformer/` subdir of a downloaded
    /// `black-forest-labs/FLUX.1-Kontext-dev` snapshot).
    public static func load(dir: URL) throws -> KontextTransformerWeights {
        var weights: [String: MLXArray] = [:]
        let files = (try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))
            .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for f in files {
            let shard = try loadArrays(url: f)
            weights.merge(shard) { _, new in new }
        }
        var joint = 0
        while weights["transformer_blocks.\(joint).norm1.linear.weight"] != nil { joint += 1 }
        var single = 0
        while weights["single_transformer_blocks.\(single).norm.linear.weight"] != nil { single += 1 }
        return KontextTransformerWeights(arrays: weights, numJointBlocks: joint, numSingleBlocks: single)
    }
}

public extension KontextTransformer {
    /// `precision` — production default is `.bfloat16` (matches Python's
    /// `ModelConfig.precision`). `verify-kontext-transformer` overrides to
    /// `.float32` to isolate algorithm correctness from bf16 rounding: at
    /// t=0 (sigma=1.0, the FIRST denoising step) conditioning magnitudes are
    /// large enough that bf16 rounding differences between two independent
    /// implementations diverge catastrophically through the FF block's
    /// nonlinear GELU (found 2026-07-14 by bisecting per-block cosine
    /// similarity down to a single `KTxFeedForward` call — cos=1.0 in, then
    /// abrupt cos≈0 out, even though the FF input matched to a raw max abs
    /// diff of only ~75 — a small ABSOLUTE bf16 rounding gap that a
    /// nonlinearity does not treat as small). Whether this bf16 instability
    /// also matters in real production inference at t=0 is a separate,
    /// deliberately NOT investigated question — flagged, not solved, here.
    static func build(weights: KontextTransformerWeights, precision: DType = .bfloat16) -> KontextTransformer {
        let w = weights.arrays
        func lin(_ key: String) -> MLXNN.Linear {
            Linear(weight: w["\(key).weight"]!.asType(precision), bias: w["\(key).bias"].map { $0.asType(precision) })
        }
        func linNoBias(_ key: String) -> MLXNN.Linear {
            Linear(weight: w["\(key).weight"]!.asType(precision), bias: nil)
        }
        func rms(_ key: String) -> KTxRMSNorm {
            KTxRMSNorm(weight: w["\(key).weight"]!.asType(.float32))
        }

        func jointAttn(_ p: String) -> KTxJointAttention {
            KTxJointAttention(
                toQ: lin("\(p).attn.to_q"), toK: lin("\(p).attn.to_k"), toV: lin("\(p).attn.to_v"),
                toOut: lin("\(p).attn.to_out.0"),
                addQProj: lin("\(p).attn.add_q_proj"), addKProj: lin("\(p).attn.add_k_proj"),
                addVProj: lin("\(p).attn.add_v_proj"), toAddOut: lin("\(p).attn.to_add_out"),
                normQ: rms("\(p).attn.norm_q"), normK: rms("\(p).attn.norm_k"),
                normAddedQ: rms("\(p).attn.norm_added_q"), normAddedK: rms("\(p).attn.norm_added_k"))
        }
        func singleAttn(_ p: String) -> KTxSingleBlockAttention {
            KTxSingleBlockAttention(toQ: lin("\(p).attn.to_q"), toK: lin("\(p).attn.to_k"), toV: lin("\(p).attn.to_v"),
                                    normQ: rms("\(p).attn.norm_q"), normK: rms("\(p).attn.norm_k"))
        }

        let jointBlocks = (0..<weights.numJointBlocks).map { i -> KTxJointTransformerBlock in
            let p = "transformer_blocks.\(i)"
            return KTxJointTransformerBlock(
                norm1: KTxAdaLayerNormZero(linear: lin("\(p).norm1.linear")),
                norm1Context: KTxAdaLayerNormZero(linear: lin("\(p).norm1_context.linear")),
                attn: jointAttn(p),
                ff: KTxFeedForward(linear1: lin("\(p).ff.net.0.proj"), linear2: lin("\(p).ff.net.2"), approximate: false),
                ffContext: KTxFeedForward(linear1: lin("\(p).ff_context.net.0.proj"), linear2: lin("\(p).ff_context.net.2"), approximate: true))
        }
        let singleBlocks = (0..<weights.numSingleBlocks).map { i -> KTxSingleTransformerBlock in
            let p = "single_transformer_blocks.\(i)"
            return KTxSingleTransformerBlock(
                norm: KTxAdaLayerNormZeroSingle(linear: lin("\(p).norm.linear")),
                attn: singleAttn(p),
                projMlp: lin("\(p).proj_mlp"), projOut: lin("\(p).proj_out"))
        }

        let hasGuidance = w["time_text_embed.guidance_embedder.linear_1.weight"] != nil
        let timeTextEmbed = KTxTimeTextEmbed(
            textEmbedder: KTxTextEmbedder(linear1: lin("time_text_embed.text_embedder.linear_1"),
                                          linear2: lin("time_text_embed.text_embedder.linear_2")),
            timestepEmbedder: KTxTimestepEmbedder(linear1: lin("time_text_embed.timestep_embedder.linear_1"),
                                                  linear2: lin("time_text_embed.timestep_embedder.linear_2")),
            guidanceEmbedder: hasGuidance
                ? KTxTimestepEmbedder(linear1: lin("time_text_embed.guidance_embedder.linear_1"),
                                      linear2: lin("time_text_embed.guidance_embedder.linear_2"))
                : nil,
            precision: precision)

        return KontextTransformer(
            xEmbedder: lin("x_embedder"), contextEmbedder: lin("context_embedder"),
            timeTextEmbed: timeTextEmbed, jointBlocks: jointBlocks, singleBlocks: singleBlocks,
            normOut: KTxAdaLayerNormContinuous(linear: linNoBias("norm_out.linear"), embeddingDim: 3072, precision: precision),
            projOut: lin("proj_out"))
    }
}
