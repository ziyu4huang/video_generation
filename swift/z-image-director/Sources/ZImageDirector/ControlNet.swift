//
//  ControlNet.swift
//  ZImageDirector
//
//  Z-Image Union ControlNet 2.1 (native MLX port of app/controlnet.py).
//  Turbo-specific: pairs with the Z-Image Turbo transformer (moody-pro-mix etc).
//
//  Architecture (185 quantized keys):
//    control_all_x_embedder["2-1"]   [3840, 132]  — embeds 33-ch control image patches
//    control_noise_refiner[0,1]                   — 2 refinement blocks (block 0 has before_proj)
//    control_layers[0..2]                         — 3 blocks (block 0 has before_proj)
//
//  The control blocks run interleaved with the main transformer's forward pass,
//  receiving the main model's hidden state at each injection point. Residuals
//  are added back into the main image tokens × controlnet_strength.
//
//  Input: 33-channel patchified image [control_latent(16), mask(1), inpaint_latent(16)]
//    For non-inpaint: mask=zeros, inpaint_latent=VAE(gray_image).
//

import Foundation
import MLX
import MLXNN
import MLXFast

// Architecture constants (mirror app/controlnet.py)
private let CN_DIM = 3840
private let CN_N_HEADS = 30
private let CN_HEAD_DIM = CN_DIM / CN_N_HEADS   // 128
private let CN_HIDDEN = Int(CN_DIM / 3 * 8)     // 10240
private let CN_T_EMB_DIM = 256                  // min(dim, 256) from main transformer
private let CN_CONTROL_IN_DIM = 132             // 33 ch × 4 (patchification)
private let CN_N_CONTROL_LAYERS = 3
private let CN_N_REFINERS = 2

/// Flux latent format (ZImage inherits → Flux VAE).
/// process_in(latent) = (latent - shift) * scale. Matches _FLUX_* in controlnet.py.
public enum FluxLatent {
    public static let shiftFactor: Float = 0.1159
    public static let scaleFactor: Float = 0.3611
}

// MARK: - ControlNet sub-modules

/// Attention for control blocks. to_q/k/v/out + RMSNorm on q,k. No bias.
/// Mirrors _ControlNetAttention; reuses MLXFast.scaledDotProductAttention.
final class ControlNetAttention: Module {
    let toq: QuantizedLinear
    let tok: QuantizedLinear
    let tov: QuantizedLinear
    let too: QuantizedLinear
    let normQ: ZRMSNorm
    let normK: ZRMSNorm
    let scale: Float

    init(toq: QuantizedLinear, tok: QuantizedLinear, tov: QuantizedLinear,
         too: QuantizedLinear, normQ: ZRMSNorm, normK: ZRMSNorm) {
        self.toq = toq; self.tok = tok; self.tov = tov; self.too = too
        self.normQ = normQ; self.normK = normK
        self.scale = pow(Float(CN_HEAD_DIM), -0.5)
        super.init()
    }

    func callAsFunction(_ x: MLXArray, cos: MLXArray?, sin: MLXArray?) -> MLXArray {
        let (B, L, _) = (x.dim(0), x.dim(1), x.dim(2))
        var q = toq(x).reshaped([B, L, CN_N_HEADS, CN_HEAD_DIM])
        var k = tok(x).reshaped([B, L, CN_N_HEADS, CN_HEAD_DIM])
        var v = tov(x).reshaped([B, L, CN_N_HEADS, CN_HEAD_DIM])
        q = normQ(q)
        k = normK(k)
        if let cos = cos, let sin = sin {
            // RoPE: rotate even/odd index pairs. cos/sin are (B, L, 1, headDim/2).
            let half = CN_HEAD_DIM / 2
            let qr = q.reshaped([B, L, CN_N_HEADS, half, 2])
            let q1 = qr[0..., 0..., 0..., 0..., 0]; let q2 = qr[0..., 0..., 0..., 0..., 1]
            q = MLX.stacked([q1 * cos - q2 * sin, q1 * sin + q2 * cos], axis: -1)
                .reshaped([B, L, CN_N_HEADS, CN_HEAD_DIM])
            let kr = k.reshaped([B, L, CN_N_HEADS, half, 2])
            let k1 = kr[0..., 0..., 0..., 0..., 0]; let k2 = kr[0..., 0..., 0..., 0..., 1]
            k = MLX.stacked([k1 * cos - k2 * sin, k1 * sin + k2 * cos], axis: -1)
                .reshaped([B, L, CN_N_HEADS, CN_HEAD_DIM])
        }
        q = q.transposed(0, 2, 1, 3)  // (B, nheads, L, headDim)
        k = k.transposed(0, 2, 1, 3)
        v = v.transposed(0, 2, 1, 3)
        let out = MLXFast.scaledDotProductAttention(
            queries: q, keys: k, values: v, scale: scale, mask: nil)
        return too(out.reshaped([B, L, CN_DIM]))
    }
}

/// Feed-forward (SwiGLU): w2(silu(w1(x)) * w3(x)). Mirrors _ControlNetFeedForward.
final class ControlNetFeedForward: Module {
    let w1: QuantizedLinear
    let w2: QuantizedLinear
    let w3: QuantizedLinear

    init(w1: QuantizedLinear, w2: QuantizedLinear, w3: QuantizedLinear) {
        self.w1 = w1; self.w2 = w2; self.w3 = w3
        super.init()
    }

    func callAsFunction(_ x: MLXArray) -> MLXArray {
        w2(MLXNN.silu(w1(x)) * w3(x))
    }
}

/// Shared attention+FFN+modulation forward for control blocks.
/// Mirrors _block_forward in controlnet.py.
final class ControlNetCore {
    let adaLN: QuantizedLinear           // adaLN_modulation.0: 256 → 4*dim
    let attention: ControlNetAttention
    let feedForward: ControlNetFeedForward
    let attentionNorm1: ZRMSNorm
    let attentionNorm2: ZRMSNorm
    let ffnNorm1: ZRMSNorm
    let ffnNorm2: ZRMSNorm

    init(adaLN: QuantizedLinear, attention: ControlNetAttention,
         feedForward: ControlNetFeedForward,
         attentionNorm1: ZRMSNorm, attentionNorm2: ZRMSNorm,
         ffnNorm1: ZRMSNorm, ffnNorm2: ZRMSNorm) {
        self.adaLN = adaLN; self.attention = attention; self.feedForward = feedForward
        self.attentionNorm1 = attentionNorm1; self.attentionNorm2 = attentionNorm2
        self.ffnNorm1 = ffnNorm1; self.ffnNorm2 = ffnNorm2
    }

    /// Run the attention+FFN+modulation core (no before/after projection).
    func core(_ h: MLXArray, temb: MLXArray, cos: MLXArray?, sin: MLXArray?) -> MLXArray {
        let chunks = adaLN(temb)
        let parts = chunks.split(parts: 4, axis: -1)
        var scaleMsa = parts[0]; var gateMsa = parts[1]
        var scaleMlp = parts[2]; var gateMlp = parts[3]
        scaleMsa = (1.0 + scaleMsa).expandedDimensions(axis: -2)
        scaleMlp = (1.0 + scaleMlp).expandedDimensions(axis: -2)
        gateMsa = MLX.tanh(gateMsa).expandedDimensions(axis: -2)
        gateMlp = MLX.tanh(gateMlp).expandedDimensions(axis: -2)
        let attnOut = attention(attentionNorm1(h) * scaleMsa, cos: cos, sin: sin)
        var x = h + gateMsa * attentionNorm2(attnOut)
        let ffnOut = feedForward(ffnNorm1(x) * scaleMlp)
        x = x + gateMlp * ffnNorm2(ffnOut)
        return x
    }
}

/// Index-0 block — has before_proj AND after_proj.
final class ControlNetBlockFirst {
    let core: ControlNetCore
    let beforeProj: QuantizedLinear
    let afterProj: QuantizedLinear

    init(core: ControlNetCore, beforeProj: QuantizedLinear, afterProj: QuantizedLinear) {
        self.core = core; self.beforeProj = beforeProj; self.afterProj = afterProj
    }

    /// Returns (residual, updatedContext).
    /// At block 0: project control context and ADD main model's hidden state.
    func callAsFunction(
        _ controlContext: MLXArray, mainHidden: MLXArray,
        temb: MLXArray, cos: MLXArray?, sin: MLXArray?
    ) -> (MLXArray, MLXArray) {
        let h = beforeProj(controlContext) + mainHidden
        let out = core.core(h, temb: temb, cos: cos, sin: sin)
        return (afterProj(out), out)
    }
}

/// Index > 0 block — only after_proj (main hidden NOT added).
final class ControlNetBlockRest {
    let core: ControlNetCore
    let afterProj: QuantizedLinear

    init(core: ControlNetCore, afterProj: QuantizedLinear) {
        self.core = core; self.afterProj = afterProj
    }

    func callAsFunction(
        _ controlContext: MLXArray, mainHidden: MLXArray,
        temb: MLXArray, cos: MLXArray?, sin: MLXArray?
    ) -> (MLXArray, MLXArray) {
        let out = core.core(controlContext, temb: temb, cos: cos, sin: sin)
        return (afterProj(out), out)
    }
}

// MARK: - Full ControlNet

/// Z-Image Union ControlNet 2.1. Supports interleaved execution where control
/// blocks receive the main model's hidden state at each injection point.
public final class ZImageControlNet: Module {

    let controlXEmbedder: Linear                // control_all_x_embedder["2-1"]: 132 → 3880 (bf16, unquantized)
    let controlNoiseRefiner: [Any]                 // [ControlNetBlockFirst, ControlNetBlockRest]
    let controlLayers: [Any]                       // [First, Rest, Rest]

    /// Load from a weights dict (keys prefixed as in safetensors).
    public init(weights: [String: MLXArray], groupSize: Int = 32, bits: Int = 4) {
        // Quantized linear: weight + scales + biases (+ optional bias).
        func ql(_ prefix: String) -> QuantizedLinear {
            QuantizedLinear(
                weight: weights[prefix + ".weight"]!,
                bias: weights[prefix + ".bias"],
                scales: weights[prefix + ".scales"]!,
                biases: weights[prefix + ".biases"]!,
                groupSize: groupSize, bits: bits
            )
        }
        // Unquantized linear: weight + bias (no scales/biases). The embedder
        // ships as bf16; we wrap it in a plain Linear (callAsFunction identical).
        func linear(_ prefix: String) -> Linear {
            Linear(weight: weights[prefix + ".weight"]!, bias: weights[prefix + ".bias"])
        }
        func rms(_ prefix: String) -> ZRMSNorm {
            ZRMSNorm(weight: weights[prefix + ".weight"]!, eps: 1e-5)
        }
        func core(_ prefix: String) -> ControlNetCore {
            ControlNetCore(
                adaLN: ql("\(prefix).adaLN_modulation.0"),
                attention: ControlNetAttention(
                    toq: ql("\(prefix).attention.to_q"),
                    tok: ql("\(prefix).attention.to_k"),
                    tov: ql("\(prefix).attention.to_v"),
                    too: ql("\(prefix).attention.to_out.0"),
                    normQ: rms("\(prefix).attention.norm_q"),
                    normK: rms("\(prefix).attention.norm_k")
                ),
                feedForward: ControlNetFeedForward(
                    w1: ql("\(prefix).feed_forward.w1"),
                    w2: ql("\(prefix).feed_forward.w2"),
                    w3: ql("\(prefix).feed_forward.w3")
                ),
                attentionNorm1: rms("\(prefix).attention_norm1"),
                attentionNorm2: rms("\(prefix).attention_norm2"),
                ffnNorm1: rms("\(prefix).ffn_norm1"),
                ffnNorm2: rms("\(prefix).ffn_norm2")
            )
        }
        func blockFirst(_ prefix: String) -> ControlNetBlockFirst {
            ControlNetBlockFirst(
                core: core(prefix),
                beforeProj: ql("\(prefix).before_proj"),
                afterProj: ql("\(prefix).after_proj")
            )
        }
        func blockRest(_ prefix: String) -> ControlNetBlockRest {
            ControlNetBlockRest(core: core(prefix), afterProj: ql("\(prefix).after_proj"))
        }

        self.controlXEmbedder = linear("control_all_x_embedder.2-1")
        self.controlNoiseRefiner = [
            blockFirst("control_noise_refiner.0"),
            blockRest("control_noise_refiner.1"),
        ]
        self.controlLayers = [
            blockFirst("control_layers.0"),
            blockRest("control_layers.1"),
            blockRest("control_layers.2"),
        ]
        super.init()
    }

    /// Embed the 33-channel control image into the ControlNet hidden space.
    /// Input [1, 33, H, W] → [1, N_patches, 3840].
    public func embedControl(_ controlImage33ch: MLXArray) -> MLXArray {
        let (B, C, H, W) = (controlImage33ch.dim(0), controlImageShape1(controlImage33ch),
                            controlImage33ch.dim(2), controlImage33ch.dim(3))
        _ = (B, C)
        let patch = 2
        let hTok = H / patch, wTok = W / patch
        // [B, C, H, W] → [B, C, hTok, 2, wTok, 2] → [B, hTok, wTok, 2, 2, C] → [B, N, 132]
        var x = controlImage33ch.reshaped([B, C, hTok, patch, wTok, patch])
        x = x.transposed(0, 2, 4, 3, 5, 1)
        x = x.reshaped([B, hTok * wTok, C * patch * patch])
        return controlXEmbedder(x)
    }

    private func controlImageShape1(_ a: MLXArray) -> Int { a.dim(1) }

    /// Run one noise refiner control block.
    /// Returns (residual, updatedContext).
    public func forwardNoiseRefiner(
        layerId: Int, controlContext: MLXArray, mainHidden: MLXArray,
        temb: MLXArray, cos: MLXArray?, sin: MLXArray?
    ) -> (MLXArray, MLXArray) {
        if layerId == 0 {
            return (controlNoiseRefiner[0] as! ControlNetBlockFirst)(
                controlContext, mainHidden: mainHidden, temb: temb, cos: cos, sin: sin)
        } else {
            return (controlNoiseRefiner[layerId] as! ControlNetBlockRest)(
                controlContext, mainHidden: mainHidden, temb: temb, cos: cos, sin: sin)
        }
    }

    /// Run one control layer block (stride-2 injection into main layers).
    public func forwardControlLayer(
        layerId: Int, controlContext: MLXArray, mainHidden: MLXArray,
        temb: MLXArray, cos: MLXArray?, sin: MLXArray?
    ) -> (MLXArray, MLXArray) {
        if layerId == 0 {
            return (controlLayers[0] as! ControlNetBlockFirst)(
                controlContext, mainHidden: mainHidden, temb: temb, cos: cos, sin: sin)
        } else {
            return (controlLayers[layerId] as! ControlNetBlockRest)(
                controlContext, mainHidden: mainHidden, temb: temb, cos: cos, sin: sin)
        }
    }

    public var nControlLayers: Int { controlLayers.count }
}

// MARK: - Control input builder

public enum ControlNetInput {
    /// Build the 33-channel control input: [control_latent(16), mask(1), inpaint_latent(16)].
    /// All inputs are Flux-normalized latents [1, C, H, W].
    ///
    /// - Parameters:
    ///   - ctrlLatent: [1, 16, H, W] VAE-encoded control image (already Flux-normalized).
    ///   - inpaintLatent: optional [1, 16, H, W] source-image latent for appearance
    ///     anchor (Flux-normalized). nil → zeros (no inpaint anchor).
    ///   - mask: optional [1, 1, H, W] spatial mask. 0=preserve source, 1=allow
    ///     generation. nil → uniform zeros (no inpaint guidance).
    public static func build33ch(
        ctrlLatent: MLXArray, inpaintLatent: MLXArray? = nil, mask: MLXArray? = nil
    ) -> MLXArray {
        let H = ctrlLatent.dim(2)
        let W = ctrlLatent.dim(3)
        let dt = ctrlLatent.dtype
        let inpaint = inpaintLatent ?? MLX.zeros([1, 16, H, W]).asType(dt)
        let m = mask ?? MLX.zeros([1, 1, H, W]).asType(dt)
        return MLX.concatenated([ctrlLatent, m.asType(dt), inpaint.asType(dt)], axis: 1)
    }

    /// Convenience: build from a control PIL image + pipeline encoder.
    /// Encodes the control image and a neutral gray inpaint anchor.
    public static func build33chFromImage(
        controlPixels: MLXArray, pipeline: T2IPipeline,
        inpaintPixels: MLXArray? = nil, mask: MLXArray? = nil
    ) -> MLXArray {
        let ctrlNorm = ImageLoad.normalizeForVAE(controlPixels)
        let ctrlLatent = pipeline.encodeImage(ctrlNorm)
        let inpaintLatent: MLXArray?
        if let inp = inpaintPixels {
            inpaintLatent = pipeline.encodeImage(ImageLoad.normalizeForVAE(inp))
        } else {
            // Neutral gray anchor: encode mid-gray so the inpaint channel is neutral.
            let (W, H) = (controlPixels.dim(3), controlPixels.dim(2))
            let gray = MLX.full([1, 3, H, W], values: 0.5).asType(controlPixels.dtype)
            inpaintLatent = pipeline.encodeImage(ImageLoad.normalizeForVAE(gray))
        }
        return build33ch(ctrlLatent: ctrlLatent, inpaintLatent: inpaintLatent, mask: mask)
    }
}
