//
//  Flux2Transformer.swift
//  Flux2Director
//
//  Phase 2.3: Flux2 Klein 9B MMDiT transformer. Ported directly from mflux's
//  flux2_transformer.{transformer, transformer_block, single_transformer_block,
//  attention, parallel_self_attention, feed_forward, modulation, pos_embed,
//  timestep_guidance_embeddings} + flux.flux_transformer.{ada_layer_norm_continuous,
//  common.attention_utils}.
//
//  Architecture (klein-9b config):
//    - in_channels=128 (packed latent), out_channels=128
//    - inner_dim = num_attention_heads(32) * attention_head_dim(128) = 4096
//    - num_layers(double blocks)=8, num_single_layers=24
//    - joint_attention_dim=12288 (= 3 * 4096, prompt_embeds dim)
//    - axes_dims_rope=(32,32,32,32) → 128 = head_dim, rope_theta=2000
//    - timestep_guidance_channels=256, mlp_ratio=3.0, guidance_embeds=false
//
//  All nn.Linear are 8-bit quantized (group_size=64). Weights stored as
//  U32 + scales + biases (mflux nn.quantize format). RMSNorms are weight-only.
//

import Foundation
import MLX
import MLXFast

// MARK: - SiLU

@inline(__always)
func silu(_ x: MLXArray) -> MLXArray { x * MLX.sigmoid(x) }

// MARK: - RMSNorm (weight-only, eps configurable)

struct F2RMSNormW {
    let weight: MLXArray
    let eps: Float

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        MLXFast.rmsNorm(x, weight: weight, eps: eps)
    }
}

// MARK: - LayerNorm (affine=False, eps=1e-6)

struct F2LayerNorm {
    let eps: Float

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        MLXFast.layerNorm(x, weight: nil, bias: nil, eps: eps)
    }
}

// MARK: - Positional embeddings (Flux2PosEmbed)

struct Flux2PosEmbed {
    let theta: Float         // 2000
    let axesDim: [Int]       // [32,32,32,32]

    /// Compute (cos, sin) rope embeddings from ids (B, S, 4).
    /// Returns two arrays of shape (S, total_dim).
    func callAsFunction(_ ids: MLXArray) -> (MLXArray, MLXArray) {
        var cosOut: [MLXArray] = []
        var sinOut: [MLXArray] = []
        let pos = ids.asType(.float32)
        for (i, dim) in axesDim.enumerated() {
            let (c, s) = get1dRope(dim: dim, pos: pos[0..., i])
            cosOut.append(c)
            sinOut.append(s)
        }
        return (MLX.concatenated(cosOut, axis: -1),
                MLX.concatenated(sinOut, axis: -1))
    }

    private func get1dRope(dim: Int, pos: MLXArray) -> (MLXArray, MLXArray) {
        // scale = arange(0, dim, 2) / dim; omega = 1 / theta^scale = exp(-log(theta)*scale)
        let scale = MLX.arange(0, dim, step: 2, dtype: .float32) / Float(dim)
        let omega = (MLX.exp((-log(theta)) * scale))
        let posExp = pos.expandedDimensions(axis: -1)          // (S, 1)
        let omegaExp = omega.expandedDimensions(axis: 0)       // (1, dim/2)
        let out = posExp * omegaExp                            // (S, dim/2)
        return (MLX.cos(out), MLX.sin(out))
    }
}

// MARK: - Timestep / guidance embeddings

struct Flux2TimestepGuidanceEmbeddings {
    let linear1: F2QLinear   // (256 -> inner_dim)
    let linear2: F2QLinear   // (inner_dim -> inner_dim)
    let inChannels: Int      // 256
    // guidance_embeds=false for klein → no guidance linears.

    func callAsFunction(_ timestep: MLXArray) -> MLXArray {
        let te = Self.timestepEmbedding(timestep.asType(.float32), dim: inChannels)
        let l1 = linear1(te)
        return linear2(l1 * MLX.sigmoid(l1))
    }

    /// Sinusoidal timestep embedding (flip_sin_to_cos=True).
    static func timestepEmbedding(_ timesteps: MLXArray, dim: Int,
                                  flipSinToCos: Bool = true) -> MLXArray {
        let half = dim / 2
        let exponent = -log(10000.0) * (MLX.arange(0, half, dtype: .float32)) / Float(half)
        let freqs = MLX.exp(exponent)                         // (half,)
        let args = timesteps.expandedDimensions(axis: -1) * freqs.expandedDimensions(axis: 0)
        var emb = MLX.concatenated([MLX.sin(args), MLX.cos(args)], axis: -1)
        if flipSinToCos {
            emb = MLX.concatenated([emb[0..., half..<dim], emb[0..., 0..<half]], axis: -1)
        }
        return emb
    }
}

// MARK: - Modulation (temb → list of (shift, scale, gate) tuples)

struct Flux2Modulation {
    let linear: F2QLinear
    let modParamSets: Int    // 2 for double, 1 for single

    /// Returns [[shift, scale, gate], ...] for each param set.
    func callAsFunction(_ temb: MLXArray) -> [[MLXArray]] {
        var mod = linear(silu(temb))
        if mod.ndim == 2 { mod = mod.expandedDimensions(axis: 1) }
        let parts = MLX.split(mod, parts: 3 * modParamSets, axis: -1)
        var out: [[MLXArray]] = []
        for i in 0..<modParamSets {
            out.append([parts[3 * i], parts[3 * i + 1], parts[3 * i + 2]])
        }
        return out
    }
}

// MARK: - AdaLayerNormContinuous (for norm_out)

struct F2AdaLayerNormContinuous {
    let linear: F2QLinear   // (inner_dim -> 2*inner_dim)
    let norm: F2LayerNorm
    let embeddingDim: Int

    func callAsFunction(_ x: MLXArray, _ textEmbeddings: MLXArray) -> MLXArray {
        var te = linear(silu(textEmbeddings))
        let cs = embeddingDim
        let scale = te[0..., 0..<cs]
        let shift = te[0..., cs..<2 * cs]
        // (1, D) → (1, 1, D) broadcast
        return norm(x) * (1 + scale.expandedDimensions(axis: 1)) + shift.expandedDimensions(axis: 1)
    }
}

// MARK: - RoPE application (apply_rope_bshd)

/// Apply rotary embedding to (B, H, S, D) tensors.
/// cos/sin shape (S, D). Reshape last dim into (D/2, 2) real/imag pairs.
enum F2Rope {
    static func apply(_ xq: MLXArray, _ xk: MLXArray, cos: MLXArray, sin: MLXArray)
        -> (MLXArray, MLXArray)
    {
        let outDtype = xq.dtype
        let xqf = xq.asType(.float32)
        let xkf = xk.asType(.float32)
        let cosB = cos.reshaped([1, 1, cos.dim(0), cos.dim(1)])
        let sinB = sin.reshaped([1, 1, sin.dim(0), sin.dim(1)])

        func mix(_ x: MLXArray) -> MLXArray {
            // x: (B, H, S, D) → (B, H, S, D/2, 2)
            let x2 = x.reshaped(x.shape[0..<(x.ndim - 1)] + [x.dim(x.ndim - 1) / 2, 2])
            let real = x2[0..., 0..., 0..., 0..., 0]
            let imag = x2[0..., 0..., 0..., 0..., 1]
            let out0 = real * cosB + (-imag) * sinB
            let out1 = imag * cosB + real * sinB
            let stacked = MLX.stacked([out0, out1], axis: -1)
            return stacked.reshaped(x.shape)
        }
        return (mix(xqf).asType(outDtype), mix(xkf).asType(outDtype))
    }
}

// MARK: - Attention helpers

enum F2AttentionOps {
    /// process_qkv: project + reshape + rmsnorm (q,k) → (B, H, S, D).
    static func processQKV(_ x: MLXArray, toq: F2QLinear, tok: F2QLinear, tov: F2QLinear,
                           normQ: F2RMSNormW, normK: F2RMSNormW,
                           numHeads: Int, headDim: Int)
        -> (MLXArray, MLXArray, MLXArray)
    {
        let (b, l, _) = (x.dim(0), x.dim(1), x.dim(2))
        var q = toq(x).reshaped([b, l, numHeads, headDim]).transposed(0, 2, 1, 3)
        var k = tok(x).reshaped([b, l, numHeads, headDim]).transposed(0, 2, 1, 3)
        let v = tov(x).reshaped([b, l, numHeads, headDim]).transposed(0, 2, 1, 3)
        let qdt = q.dtype, kdt = k.dtype
        q = normQ(q.asType(.float32)).asType(qdt)
        k = normK(k.asType(.float32)).asType(kdt)
        return (q, k, v)
    }

    /// SDPA + transpose/reshape back to (B, S, H*D).
    static func compute(_ q: MLXArray, _ k: MLXArray, _ v: MLXArray,
                        batchSize: Int, numHeads: Int, headDim: Int) -> MLXArray {
        let scale = 1.0 / Float(headDim).squareRoot()
        let attn = MLXFast.scaledDotProductAttention(queries: q, keys: k, values: v,
                                                      scale: scale, mask: nil)
        return attn.transposed(0, 2, 1, 3).reshaped([batchSize, -1, numHeads * headDim])
    }
}

// MARK: - Feed-forward (SwiGLU)

struct Flux2SwiGLU {
    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let parts = MLX.split(x, parts: 2, axis: -1)
        let x1 = parts[0], x2 = parts[1]
        return x1 * MLX.sigmoid(x1) * x2
    }
}

struct Flux2FeedForward {
    let linearIn: F2QLinear   // (dim -> 2*inner)
    let linearOut: F2QLinear  // (inner -> dim)
    let act = Flux2SwiGLU()

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        linearOut(act(linearIn(x)))
    }
}

// MARK: - Double-block attention (Flux2Attention with added kv)

struct Flux2Attention {
    let toq: F2QLinear, tok: F2QLinear, tov: F2QLinear
    let normQ: F2RMSNormW, normK: F2RMSNormW
    let toOut: F2QLinear
    // added kv (context) projections
    let addQProj: F2QLinear, addKProj: F2QLinear, addVProj: F2QLinear
    let normAddedQ: F2RMSNormW, normAddedK: F2RMSNormW
    let toAddOut: F2QLinear
    let heads: Int, headDim: Int

    /// Returns (img_attn_out, txt_attn_out), both (B, S_img/txt, dim).
    func callAsFunction(hiddenStates: MLXArray, encoderHiddenStates: MLXArray,
                        imageRotaryEmb: (MLXArray, MLXArray))
        -> (MLXArray, MLXArray)
    {
        let batchSize = hiddenStates.dim(0)
        var (q, k, v) = F2AttentionOps.processQKV(
            hiddenStates, toq: toq, tok: tok, tov: tov,
            normQ: normQ, normK: normK, numHeads: heads, headDim: headDim)

        let (eq, ek, ev) = F2AttentionOps.processQKV(
            encoderHiddenStates, toq: addQProj, tok: addKProj, tov: addVProj,
            normQ: normAddedQ, normK: normAddedK, numHeads: heads, headDim: headDim)

        // Concat text tokens FIRST, then image tokens (along seq axis, axis=2).
        q = MLX.concatenated([eq, q], axis: 2)
        k = MLX.concatenated([ek, k], axis: 2)
        v = MLX.concatenated([ev, v], axis: 2)

        let (cos, sin) = imageRotaryEmb
        (q, k) = F2Rope.apply(q, k, cos: cos, sin: sin)

        let hidden = F2AttentionOps.compute(q, k, v, batchSize: batchSize,
                                            numHeads: heads, headDim: headDim)
        // Split back: text is the prefix.
        let txtLen = encoderHiddenStates.dim(1)
        let encOut = hidden[0..., 0..<txtLen, 0...]
        let imgOut = hidden[0..., txtLen..<hidden.dim(1), 0...]
        return (toOut(imgOut), toAddOut(encOut))
    }
}

// MARK: - Single-block parallel self-attention (Flux2ParallelSelfAttention)

struct Flux2ParallelSelfAttention {
    let toQkvMlpProj: F2QLinear  // (dim -> 3*inner + 2*mlpHidden)
    let normQ: F2RMSNormW, normK: F2RMSNormW
    let mlpAct = Flux2SwiGLU()
    let toOut: F2QLinear          // (inner + mlpHidden -> dim)
    let heads: Int, headDim: Int
    let innerDim: Int             // heads * headDim
    let mlpHiddenDim: Int         // int(dim * mlpRatio)

    func callAsFunction(_ hiddenStates: MLXArray,
                        imageRotaryEmb: (MLXArray, MLXArray)) -> MLXArray
    {
        let batchSize = hiddenStates.dim(0)
        let proj = toQkvMlpProj(hiddenStates)
        // Split into qkv (3*inner) and mlp_hidden (2*mlpHidden).
        let split1 = proj.split(indices: [innerDim * 3], axis: -1)
        let qkv = split1[0]
        let mlpHidden = split1[1]
        let qkvParts = qkv.split(parts: 3, axis: -1)
        var q = qkvParts[0], k = qkvParts[1]
        let v = qkvParts[2]

        let (b, l, _) = (q.dim(0), q.dim(1), q.dim(2))
        q = q.reshaped([b, l, heads, headDim]).transposed(0, 2, 1, 3)
        k = k.reshaped([b, l, heads, headDim]).transposed(0, 2, 1, 3)
        let vT = v.reshaped([b, l, heads, headDim]).transposed(0, 2, 1, 3)

        let qdt = q.dtype, kdt = k.dtype
        q = normQ(q.asType(.float32)).asType(qdt)
        k = normK(k.asType(.float32)).asType(kdt)

        let (cos, sin) = imageRotaryEmb
        (q, k) = F2Rope.apply(q, k, cos: cos, sin: sin)

        let attn = F2AttentionOps.compute(q, k, vT, batchSize: batchSize,
                                          numHeads: heads, headDim: headDim)
        let mlpOut = mlpAct(mlpHidden)
        let cat = MLX.concatenated([attn, mlpOut], axis: -1)
        return toOut(cat)
    }
}

// MARK: - Double transformer block

struct Flux2TransformerBlock {
    let norm1: F2LayerNorm, norm1Context: F2LayerNorm
    let attn: Flux2Attention
    let norm2: F2LayerNorm, norm2Context: F2LayerNorm
    let ff: Flux2FeedForward, ffContext: Flux2FeedForward

    /// Returns (encoderHiddenStates, hiddenStates).
    func callAsFunction(hiddenStates: MLXArray, encoderHiddenStates: MLXArray,
                        tembModParamsImg: [[MLXArray]], tembModParamsTxt: [[MLXArray]],
                        imageRotaryEmb: (MLXArray, MLXArray))
        -> (MLXArray, MLXArray)
    {
        let (shiftMsa, scaleMsa, gateMsa) = (tembModParamsImg[0][0], tembModParamsImg[0][1], tembModParamsImg[0][2])
        let (shiftMlp, scaleMlp, gateMlp) = (tembModParamsImg[1][0], tembModParamsImg[1][1], tembModParamsImg[1][2])
        let (cShiftMsa, cScaleMsa, cGateMsa) = (tembModParamsTxt[0][0], tembModParamsTxt[0][1], tembModParamsTxt[0][2])
        let (cShiftMlp, cScaleMlp, cGateMlp) = (tembModParamsTxt[1][0], tembModParamsTxt[1][1], tembModParamsTxt[1][2])

        var normHidden = norm1(hiddenStates)
        normHidden = (1 + scaleMsa) * normHidden + shiftMsa
        var normEnc = norm1Context(encoderHiddenStates)
        normEnc = (1 + cScaleMsa) * normEnc + cShiftMsa

        let (attnOut, encAttnOut) = attn(
            hiddenStates: normHidden, encoderHiddenStates: normEnc,
            imageRotaryEmb: imageRotaryEmb)

        var hs = hiddenStates + gateMsa * attnOut
        var es = encoderHiddenStates + cGateMsa * encAttnOut

        var normHidden2 = norm2(hs)
        normHidden2 = (1 + scaleMlp) * normHidden2 + shiftMlp
        hs = hs + gateMlp * ff(normHidden2)

        var normEnc2 = norm2Context(es)
        normEnc2 = (1 + cScaleMlp) * normEnc2 + cShiftMlp
        es = es + cGateMlp * ffContext(normEnc2)

        return (es, hs)
    }
}

// MARK: - Single transformer block

struct Flux2SingleTransformerBlock {
    let norm: F2LayerNorm
    let attn: Flux2ParallelSelfAttention

    func callAsFunction(_ hiddenStates: MLXArray, tembModParams: [MLXArray],
                        imageRotaryEmb: (MLXArray, MLXArray)) -> MLXArray {
        let modShift = tembModParams[0], modScale = tembModParams[1], modGate = tembModParams[2]
        var normHidden = norm(hiddenStates)
        normHidden = (1 + modScale) * normHidden + modShift
        let attnOut = attn(normHidden, imageRotaryEmb: imageRotaryEmb)
        return hiddenStates + modGate * attnOut
    }
}

// MARK: - Config

public struct Flux2TransformerConfig: Sendable {
    public let patchSize: Int            // 1
    public let inChannels: Int           // 128
    public let outChannels: Int          // 128
    public let numLayers: Int            // 8 (double blocks)
    public let numSingleLayers: Int      // 24
    public let attentionHeadDim: Int     // 128
    public let numAttentionHeads: Int    // 32
    public let jointAttentionDim: Int    // 12288
    public let timestepGuidanceChannels: Int  // 256
    public let mlpRatio: Float           // 3.0
    public let axesDimsRope: [Int]       // [32,32,32,32]
    public let ropeTheta: Float          // 2000
    public let guidanceEmbeds: Bool      // false
    public let groupSize: Int            // 64
    public let bits: Int                 // 8

    public var innerDim: Int { numAttentionHeads * attentionHeadDim }  // 4096

    public init(patchSize: Int, inChannels: Int, outChannels: Int, numLayers: Int,
                numSingleLayers: Int, attentionHeadDim: Int, numAttentionHeads: Int,
                jointAttentionDim: Int, timestepGuidanceChannels: Int, mlpRatio: Float,
                axesDimsRope: [Int], ropeTheta: Float, guidanceEmbeds: Bool,
                groupSize: Int, bits: Int) {
        self.patchSize = patchSize; self.inChannels = inChannels; self.outChannels = outChannels
        self.numLayers = numLayers; self.numSingleLayers = numSingleLayers
        self.attentionHeadDim = attentionHeadDim; self.numAttentionHeads = numAttentionHeads
        self.jointAttentionDim = jointAttentionDim
        self.timestepGuidanceChannels = timestepGuidanceChannels; self.mlpRatio = mlpRatio
        self.axesDimsRope = axesDimsRope; self.ropeTheta = ropeTheta
        self.guidanceEmbeds = guidanceEmbeds; self.groupSize = groupSize; self.bits = bits
    }
}

// MARK: - Full transformer

public struct Flux2Transformer {
    let posEmbed: Flux2PosEmbed
    let timeGuidanceEmbed: Flux2TimestepGuidanceEmbeddings
    let doubleStreamModImg: Flux2Modulation
    let doubleStreamModTxt: Flux2Modulation
    let singleStreamMod: Flux2Modulation
    let xEmbedder: F2QLinear
    let contextEmbedder: F2QLinear
    let transformerBlocks: [Flux2TransformerBlock]
    let singleTransformerBlocks: [Flux2SingleTransformerBlock]
    let normOut: F2AdaLayerNormContinuous
    let projOut: F2QLinear
    let config: Flux2TransformerConfig

    /// Run the transformer forward. Returns noise prediction (B, S_img, out_channels).
    public func callAsFunction(hiddenStates: MLXArray,
                               encoderHiddenStates: MLXArray,
                               timestep: MLXArray,
                               imgIds: MLXArray,
                               txtIds: MLXArray) -> MLXArray
    {
        let cfg = config
        // Timestep scaling: if max <= 1.0, multiply by 1000.
        var ts = timestep.asType(hiddenStates.dtype)
        if ts.ndim == 0 {
            ts = MLX.full([hiddenStates.dim(0)], values: ts)
        }
        let tsScale: Float = ts.max().item(Float.self) <= 1.0 ? 1000.0 : 1.0
        ts = ts * tsScale
        let temb = timeGuidanceEmbed(ts).asType(hiddenStates.dtype)

        var hidden = xEmbedder(hiddenStates)
        var encHidden = contextEmbedder(encoderHiddenStates)
        var imgIds2 = imgIds
        var txtIds2 = txtIds
        if imgIds2.ndim == 3 { imgIds2 = imgIds2[0] }
        if txtIds2.ndim == 3 { txtIds2 = txtIds2[0] }

        let imgRot = posEmbed(imgIds2)
        let txtRot = posEmbed(txtIds2)
        let concatRot: (MLXArray, MLXArray) = (
            MLX.concatenated([txtRot.0, imgRot.0], axis: 0),
            MLX.concatenated([txtRot.1, imgRot.1], axis: 0)
        )

        let modImg = doubleStreamModImg(temb)
        let modTxt = doubleStreamModTxt(temb)

        for block in transformerBlocks {
            (encHidden, hidden) = block(
                hiddenStates: hidden, encoderHiddenStates: encHidden,
                tembModParamsImg: modImg, tembModParamsTxt: modTxt,
                imageRotaryEmb: concatRot)
        }

        // Single stream: concat [text, image] along seq axis.
        hidden = MLX.concatenated([encHidden, hidden], axis: 1)
        let modSingle = singleStreamMod(temb)[0]  // single param set
        for block in singleTransformerBlocks {
            hidden = block(hidden, tembModParams: modSingle, imageRotaryEmb: concatRot)
        }

        // Slice off text tokens, keep image.
        hidden = hidden[0..., encHidden.dim(1)..<hidden.dim(1), 0...]
        hidden = normOut(hidden, temb)
        hidden = projOut(hidden)
        return hidden
    }

    /// Diagnostic forward that returns key intermediates for layer-by-layer
    /// comparison against the Python reference.
    public func diagnose(hiddenStates: MLXArray, encoderHiddenStates: MLXArray,
                         timestep: MLXArray, imgIds: MLXArray, txtIds: MLXArray)
        -> [String: MLXArray]
    {
        var ts = timestep.asType(hiddenStates.dtype)
        if ts.ndim == 0 { ts = MLX.full([hiddenStates.dim(0)], values: ts) }
        let tsScale: Float = ts.max().item(Float.self) <= 1.0 ? 1000.0 : 1.0
        ts = ts * tsScale
        let temb = timeGuidanceEmbed(ts).asType(hiddenStates.dtype)

        var hidden = xEmbedder(hiddenStates)
        var encHidden = contextEmbedder(encoderHiddenStates)
        var imgIds2 = imgIds
        var txtIds2 = txtIds
        if imgIds2.ndim == 3 { imgIds2 = imgIds2[0] }
        if txtIds2.ndim == 3 { txtIds2 = txtIds2[0] }

        let imgRot = posEmbed(imgIds2)
        let txtRot = posEmbed(txtIds2)
        let concatRot: (MLXArray, MLXArray) = (
            MLX.concatenated([txtRot.0, imgRot.0], axis: 0),
            MLX.concatenated([txtRot.1, imgRot.1], axis: 0)
        )

        let modImg = doubleStreamModImg(temb)
        let modTxt = doubleStreamModTxt(temb)

        (encHidden, hidden) = transformerBlocks[0](
            hiddenStates: hidden, encoderHiddenStates: encHidden,
            tembModParamsImg: modImg, tembModParamsTxt: modTxt,
            imageRotaryEmb: concatRot)

        return [
            "temb": temb.asType(.float32),
            "te_raw": Flux2TimestepGuidanceEmbeddings.timestepEmbedding(ts.asType(.float32), dim: config.timestepGuidanceChannels).asType(.float32),
            "hidden_post_embed": xEmbedder(hiddenStates).asType(.float32),
            "enc_post_embed": contextEmbedder(encoderHiddenStates).asType(.float32),
            "rope_cos": concatRot.0.asType(.float32),
            "enc_after_db0": encHidden.asType(.float32),
            "hidden_after_db0": hidden.asType(.float32),
        ]
    }
}

// MARK: - Weight loader

public struct Flux2TransformerWeights {
    public let config: Flux2TransformerConfig
    public let arrays: [String: MLXArray]

    public static func load(dir: URL) throws -> Flux2TransformerWeights {
        let configURL = dir.appendingPathComponent("config.json")
        let data = try Data(contentsOf: configURL)
        guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "Flux2TransformerWeights", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "config.json is not a JSON object"])
        }
        func intKey(_ k: String) -> Int {
            if let v = raw[k] as? Int { return v }
            if let s = raw[k] as? String, let v = Int(s) { return v }
            fatalError("transformer config.json missing key: \(k)")
        }
        func floatKey(_ k: String, _ d: Float) -> Float {
            if let v = raw[k] as? Double { return Float(v) }
            return d
        }
        let axesDims = (raw["axes_dims_rope"] as? [Int]) ?? [32, 32, 32, 32]
        let inCh = intKey("in_channels")
        let outCh = (raw["out_channels"] as? Int) ?? inCh
        let cfg = Flux2TransformerConfig(
            patchSize: intKey("patch_size"),
            inChannels: inCh,
            outChannels: outCh,
            numLayers: intKey("num_layers"),
            numSingleLayers: intKey("num_single_layers"),
            attentionHeadDim: intKey("attention_head_dim"),
            numAttentionHeads: intKey("num_attention_heads"),
            jointAttentionDim: intKey("joint_attention_dim"),
            timestepGuidanceChannels: intKey("timestep_guidance_channels"),
            mlpRatio: floatKey("mlp_ratio", 3.0),
            axesDimsRope: axesDims,
            ropeTheta: floatKey("rope_theta", 2000),
            guidanceEmbeds: (raw["guidance_embeds"] as? Bool) ?? false,
            groupSize: 64, bits: 8
        )
        var weights: [String: MLXArray] = [:]
        let files = (try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil))
            .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for f in files {
            let shard = try loadArrays(url: f)
            weights.merge(shard) { _, new in new }
        }
        return Flux2TransformerWeights(config: cfg, arrays: weights)
    }
}

public extension Flux2Transformer {
    static func build(weights: Flux2TransformerWeights) -> Flux2Transformer {
        let cfg = weights.config
        let gs = cfg.groupSize, bits = cfg.bits
        let w = weights.arrays
        let innerDim = cfg.innerDim
        let mlpHidden = Int(Float(innerDim) * cfg.mlpRatio)

        func ql(_ key: String) -> F2QLinear {
            F2QLinear(weight: w["\(key).weight"]!, scales: w["\(key).scales"]!,
                      biases: w["\(key).biases"]!, groupSize: gs, bits: bits)
        }
        func rmsn(_ key: String, eps: Float) -> F2RMSNormW {
            F2RMSNormW(weight: w["\(key).weight"]!, eps: eps)
        }
        let ln = F2LayerNorm(eps: 1e-6)

        var doubleBlocks: [Flux2TransformerBlock] = []
        doubleBlocks.reserveCapacity(cfg.numLayers)
        for i in 0..<cfg.numLayers {
            let p = "transformer_blocks.\(i)"
            doubleBlocks.append(Flux2TransformerBlock(
                norm1: ln, norm1Context: ln,
                attn: Flux2Attention(
                    toq: ql("\(p).attn.to_q"), tok: ql("\(p).attn.to_k"),
                    tov: ql("\(p).attn.to_v"),
                    normQ: rmsn("\(p).attn.norm_q", eps: 1e-5),
                    normK: rmsn("\(p).attn.norm_k", eps: 1e-5),
                    toOut: ql("\(p).attn.to_out"),
                    addQProj: ql("\(p).attn.add_q_proj"),
                    addKProj: ql("\(p).attn.add_k_proj"),
                    addVProj: ql("\(p).attn.add_v_proj"),
                    normAddedQ: rmsn("\(p).attn.norm_added_q", eps: 1e-5),
                    normAddedK: rmsn("\(p).attn.norm_added_k", eps: 1e-5),
                    toAddOut: ql("\(p).attn.to_add_out"),
                    heads: cfg.numAttentionHeads, headDim: cfg.attentionHeadDim),
                norm2: ln, norm2Context: ln,
                ff: Flux2FeedForward(linearIn: ql("\(p).ff.linear_in"),
                                     linearOut: ql("\(p).ff.linear_out")),
                ffContext: Flux2FeedForward(linearIn: ql("\(p).ff_context.linear_in"),
                                            linearOut: ql("\(p).ff_context.linear_out"))
            ))
        }

        var singleBlocks: [Flux2SingleTransformerBlock] = []
        singleBlocks.reserveCapacity(cfg.numSingleLayers)
        for i in 0..<cfg.numSingleLayers {
            let p = "single_transformer_blocks.\(i)"
            singleBlocks.append(Flux2SingleTransformerBlock(
                norm: ln,
                attn: Flux2ParallelSelfAttention(
                    toQkvMlpProj: ql("\(p).attn.to_qkv_mlp_proj"),
                    normQ: rmsn("\(p).attn.norm_q", eps: 1e-5),
                    normK: rmsn("\(p).attn.norm_k", eps: 1e-5),
                    toOut: ql("\(p).attn.to_out"),
                    heads: cfg.numAttentionHeads, headDim: cfg.attentionHeadDim,
                    innerDim: innerDim, mlpHiddenDim: mlpHidden)
            ))
        }

        return Flux2Transformer(
            posEmbed: Flux2PosEmbed(theta: cfg.ropeTheta, axesDim: cfg.axesDimsRope),
            timeGuidanceEmbed: Flux2TimestepGuidanceEmbeddings(
                linear1: ql("time_guidance_embed.linear_1"),
                linear2: ql("time_guidance_embed.linear_2"),
                inChannels: cfg.timestepGuidanceChannels),
            doubleStreamModImg: Flux2Modulation(
                linear: ql("double_stream_modulation_img.linear"), modParamSets: 2),
            doubleStreamModTxt: Flux2Modulation(
                linear: ql("double_stream_modulation_txt.linear"), modParamSets: 2),
            singleStreamMod: Flux2Modulation(
                linear: ql("single_stream_modulation.linear"), modParamSets: 1),
            xEmbedder: ql("x_embedder"),
            contextEmbedder: ql("context_embedder"),
            transformerBlocks: doubleBlocks,
            singleTransformerBlocks: singleBlocks,
            normOut: F2AdaLayerNormContinuous(
                linear: ql("norm_out.linear"), norm: ln, embeddingDim: innerDim),
            projOut: ql("proj_out"),
            config: cfg
        )
    }
}
