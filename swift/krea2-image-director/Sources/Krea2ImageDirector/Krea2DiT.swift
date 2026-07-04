//
//  Krea2DiT.swift
//  Krea2ImageDirector
//
//  Native Swift port of python/mlx-movie-director/app/krea2_transformer.py
//  (single-stream MMDiT). Functional, weight-dict-driven. MANUAL GQA attention
//  (the python port validated mx.fast.sdpa diverges in the full DiT graph).
//  Weight keys match the turbo.safetensors state_dict (strict-loadable).
//

import Foundation
import MLX
import MLXNN

/// Style-transfer attention-injection config (training-free, jieg9341-lab
/// port). When set + active for a block, the DiT runs as a 2B batch
/// `[target ; ref_noisy]` and the target's image-token attention is extended
/// with the reference batch's K/V (scaled per-frequency + V-AdaIN-mixed).
/// See docs/controlnet-styletransfer-port.md Feature B.
public struct Krea2StyleConfig {
    public let targetB: Int                  // size of the target batch (batch index [0..<targetB])
    public let imgS: Int                      // image-token range start (== txtlen)
    public let imgE: Int                      // image-token range end (== L)
    public let activeBlocks: Set<Int>         // blocks to inject in (default 7...27)
    public let scaleVec: MLXArray             // (headDim,) per-frequency K scale, broadcastable
    public let refKStrength: Float            // extra K multiplier (1.06)
    public let valueAdainStrength: Float      // V AdaIN mix α (0.65)
    public let refValueMix: Float             // raw-ref V mix (1.0)
    public let mix: Float                     // styled-vs-native blend (1.0)

    public init(targetB: Int, imgS: Int, imgE: Int, activeBlocks: Set<Int>,
                scaleVec: MLXArray, refKStrength: Float = 1.06,
                valueAdainStrength: Float = 0.65, refValueMix: Float = 1.0, mix: Float = 1.0) {
        self.targetB = targetB; self.imgS = imgS; self.imgE = imgE
        self.activeBlocks = activeBlocks; self.scaleVec = scaleVec
        self.refKStrength = refKStrength; self.valueAdainStrength = valueAdainStrength
        self.refValueMix = refValueMix; self.mix = mix
    }
}

public struct Krea2DiT {
    public let config: Krea2Config
    let w: [String: MLXArray]
    /// Optional Control LoRA control-half input projection (features, 64) +
    /// bias. When set, `callAsFunction(controlTokens:)` adds
    /// `controlStrength * (controlTokens @ firstControl.T)` to the image
    /// projection at the DiT input (facok input-concat mechanism). See
    /// Krea2ControlLoRA.swift + docs/controlnet-styletransfer-port.md.
    public let firstControl: MLXArray?
    public let firstControlBias: MLXArray?
    /// Optional training-free style-transfer config. When set, the caller runs
    /// the DiT on a 2·targetB batch `[target ; ref_noisy]` and `attention`
    /// injects the reference batch's image-token K/V into the target attention
    /// for blocks in `style.activeBlocks`. See Krea2StyleConfig.
    public let style: Krea2StyleConfig?

    public init(config: Krea2Config, weights: [String: MLXArray],
                firstControl: MLXArray? = nil, firstControlBias: MLXArray? = nil,
                style: Krea2StyleConfig? = nil) {
        self.config = config
        self.w = weights
        self.firstControl = firstControl
        self.firstControlBias = firstControlBias
        self.style = style
    }

    // MARK: - primitives

    /// Linear: x @ weight.T + bias. Auto-detects MLX-quantized weights (8-bit
    /// g64) via the `<prefix>.weight.scales` companion key and dispatches to
    /// quantizedMM; otherwise plain matmul. Matches python
    /// scripts/krea2_quantize_turbo.py (BITS=8, GROUP=64).
    ///
    /// Also adds a Control-LoRA low-rank delta when `<prefix>.lora.A`/`.B` are
    /// present (A is (in,r), B is (out,r); scale = 1 since α=rank). The delta
    /// is `matmul(matmul(x, A), B.T)` — keeps the base Q8 weights untouched.
    @inline(__always) func lin(_ x: MLXArray, _ prefix: String) -> MLXArray {
        let wk = "\(prefix).weight"
        var y: MLXArray
        if let scales = w["\(wk).scales"] {
            y = MLX.quantizedMM(x, w[wk]!, scales: scales, biases: w["\(wk).biases"],
                                transpose: true, groupSize: 64, bits: 8)
        } else {
            y = MLX.matmul(x, w[wk]!.transposed(1, 0))
        }
        if let a = w["\(prefix).lora.A"], let b = w["\(prefix).lora.B"] {
            // Δ = (x @ A) @ Bᵀ ; A:(in,r) B:(out,r) → (.,r) → (.,out)
            y = y + MLX.matmul(MLX.matmul(x, a), b.transposed(1, 0))
        }
        if let b = w["\(prefix).bias"] { return y + b }
        return y
    }

    /// RMSNorm, weight = stored scale + 1 (torch QwenImageRMSNorm convention).
    /// scaleKey is the module path (e.g. "blocks.0.prenorm"); the param is "...scale".
    @inline(__always) func rms(_ x: MLXArray, _ scaleKey: String, eps: Float = 1e-5) -> MLXArray {
        MLX.rmsNorm(x, weight: 1.0 + w["\(scaleKey).scale"]!, eps: eps)
    }

    // MARK: - timestep embedding

    /// t (B,) -> (B, dim). period 1e4, t scaled by 1e3.
    func temb(_ t: MLXArray, _ dim: Int) -> MLXArray {
        let half = dim / 2
        let scaleArr = MLXArray((0..<half).map { Float($0) * 2.0 / Float(dim) })
        let omega = 1.0 / MLX.pow(MLXArray(Float(1e4)), scaleArr)        // (half,)
        let args = (t.asType(.float32) * 1e3).expandedDimensions(axis: 1).expandedDimensions(axis: 1)
            * omega.expandedDimensions(axis: 0).expandedDimensions(axis: 0)  // (B,1,half)
        return MLX.concatenated([MLX.cos(args), MLX.sin(args)], axis: -1)   // (B,1,dim)
    }

    // MARK: - RoPE (interleaved 2x2, theta=1e3)

    /// pos (B,L,3) -> freqs (B,L,totalHalf,2,2) per-token rotation matrices.
    func ropeFreqs(_ pos: MLXArray) -> MLXArray {
        let (B, L) = (pos.dim(0), pos.dim(1))
        var perAxis: [MLXArray] = []
        for (i, d) in config.ropeAxes.enumerated() {
            let half = d / 2
            let scaleArr = MLXArray((0..<half).map { Float($0) * 2.0 / Float(d) })
            let omega = 1.0 / MLX.pow(MLXArray(Float(config.theta)), scaleArr)
            let p = pos[0..., 0..., i].asType(.float32)                  // (B,L)
            let o = p.expandedDimensions(axis: 2) * omega.expandedDimensions(axis: 0).expandedDimensions(axis: 0)
            let c = MLX.cos(o), s = MLX.sin(o)
            let st = MLX.stacked([c, -s, s, c], axis: -1)                // (B,L,half,4)
            perAxis.append(st.reshaped([B, L, half, 2, 2]))
        }
        return MLX.concatenated(perAxis, axis: 2)                        // (B,L,totalHalf,2,2)
    }

    /// Apply 2x2 rotation via matmul. x (B,H,L,D), freqs (B,L,half,2,2) -> (B,H,L,D).
    func ropeApply(_ x: MLXArray, _ freqs: MLXArray) -> MLXArray {
        let (B, H, L, D) = (x.dim(0), x.dim(1), x.dim(2), x.dim(3))
        let half = D / 2
        let xv = x.asType(.float32).reshaped([B, H, L, half, 2, 1])
        let f = freqs.expandedDimensions(axis: 1)                        // (B,1,L,half,2,2)
        return MLX.matmul(f, xv).reshaped([B, H, L, D])                  // (B,H,L,D)
    }

    // MARK: - attention (manual GQA)

    func attention(_ qkv: MLXArray, _ prefix: String, heads: Int, kvh: Int, hd: Int,
                   freqs: MLXArray?, mask: MLXArray?, blockIndex: Int? = nil) -> MLXArray {
        let (B, L) = (qkv.dim(0), qkv.dim(1))
        var q = lin(qkv, "\(prefix).wq").reshaped([B, L, heads, hd])
        var k = lin(qkv, "\(prefix).wk").reshaped([B, L, kvh, hd])
        var v = lin(qkv, "\(prefix).wv").reshaped([B, L, kvh, hd])
        let gate = lin(qkv, "\(prefix).gate")
        q = rms(q, "\(prefix).qknorm.qnorm")
        k = rms(k, "\(prefix).qknorm.knorm")
        q = q.transposed(0, 2, 1, 3); k = k.transposed(0, 2, 1, 3); v = v.transposed(0, 2, 1, 3)
        if let freqs { q = ropeApply(q, freqs); k = ropeApply(k, freqs) }
        let rep = heads / kvh
        k = MLX.repeated(k, count: rep, axis: 1)
        v = MLX.repeated(v, count: rep, axis: 1)
        let scale = Float(Foundation.pow(Double(hd), -0.5))

        // ── Style-transfer K/V injection (training-free). When a style config
        //    is attached, this is a 2·targetB batch [target ; ref_noisy] and
        //    the block is in the active set: extend the target attention with
        //    the reference batch's image-token K (per-frequency scaled) + V
        //    (AdaIN-mixed). See Krea2StyleConfig + docs Feature B.
        var out: MLXArray
        if let st = style, let bi = blockIndex, st.activeBlocks.contains(bi), B == 2 * st.targetB {
            out = styledAttention(q: q, k: k, v: v, scale: scale, mask: mask, st: st)
        } else {
            var scores = MLX.matmul(q, k.transposed(0, 1, 3, 2)) * scale     // (B,H,L,L)
            if let mask { scores = MLX.where(mask, scores, MLXArray(-1e9)) }
            let a = MLX.softmax(scores, axis: -1)
            out = MLX.matmul(a, v).transposed(0, 2, 1, 3).reshaped([B, L, heads * hd])
        }
        out = lin(out * MLX.sigmoid(gate), "\(prefix).wo")
        return out
    }

    /// Style-transfer attention. q,k,v are (B,H,L,D) post-rope, post-KV-repeat,
    /// with B == 2·targetB and batch order [target ; ref]. The target's
    /// attention is extended with the ref batch's image-token K/V; the ref
    /// batch attends natively (unchanged). Returns (B,L,H·D).
    /// Minimal viable port: V-AdaIN + per-frequency K scale (the core mechanism
    /// per the repo README); Q/K AdaIN + dual-ref deferred (see docs).
    func styledAttention(q: MLXArray, k: MLXArray, v: MLXArray, scale: Float,
                         mask: MLXArray?, st: Krea2StyleConfig) -> MLXArray {
        let (B, H, L, D) = (q.dim(0), q.dim(1), q.dim(2), q.dim(3))
        let tb = st.targetB
        let ir = st.imgS..<st.imgE
        let qT = q[0..<tb], qR = q[tb..<B]
        let kT = k[0..<tb], kR = k[tb..<B]
        let vT = v[0..<tb], vR = v[tb..<B]

        // Reference K slice (image tokens) × per-frequency scale × refKStrength.
        let scaleVec = st.scaleVec.expandedDimensions(axis: 0).expandedDimensions(axis: 0)
            .expandedDimensions(axis: 0)                                  // (1,1,1,D)
        let refK = kR[0..., 0..., ir, 0...] * scaleVec * st.refKStrength  // (tb,H,imgLen,D)

        // V AdaIN over image tokens: ref stats → target shape, then blend.
        let refV = vR[0..., 0..., ir, 0...]                              // (tb,H,imgLen,D)
        let tgtV = vT[0..., 0..., ir, 0...]
        let eps = MLXArray(1e-6)
        let muT = tgtV.mean(axis: 2, keepDims: true), sdT = MLX.sqrt(tgtV.variance(axis: 2, keepDims: true) + eps)
        let muR = refV.mean(axis: 2, keepDims: true), sdR = MLX.sqrt(refV.variance(axis: 2, keepDims: true) + eps)
        let adaV = (tgtV - muT) / sdT * sdR + muR
        let baseV = tgtV * (1 - st.valueAdainStrength) + adaV * st.valueAdainStrength
        let injV = baseV * (1 - st.refValueMix) + refV * st.refValueMix   // (tb,H,imgLen,D)

        // Target attends to its own K/V PLUS the ref K/V (extended sequence).
        let kTarget = MLX.concatenated([kT, refK], axis: 2)               // (tb,H,L+imgLen,D)
        let vTarget = MLX.concatenated([vT, injV], axis: 2)
        var scoresT = MLX.matmul(qT, kTarget.transposed(0, 1, 3, 2)) * scale  // (tb,H,L,L+imgLen)
        // Native target attention (for the mix blend).
        let nativeScores = MLX.matmul(qT, kT.transposed(0, 1, 3, 2)) * scale
        // Mask: `mask` is the (B,1,L,L) key-padding product row*col. Extract
        // the per-batch KEY-validity vector mask[b,0,0,:] (== col == mp[b])
        // and reshape to (tb,1,1,L) so it broadcasts over heads + query rows.
        // The appended imgLen ref columns are fully attended (ones).
        if let mask {
            let keyT = mask[0..<tb, 0, 0, 0...]                          // (tb, L)
            let keyTb = keyT.expandedDimensions(axis: 1).expandedDimensions(axis: 2)  // (tb,1,1,L)
            let nm = MLX.where(keyTb, nativeScores, MLXArray(-1e9))      // (tb,H,L,L)
            let nativeOut = MLX.matmul(MLX.softmax(nm, axis: -1), vT)    // (tb,H,L,D)
            let ones = MLX.ones([tb, 1, 1, ir.count], dtype: keyT.dtype)
            let mExt = MLX.concatenated([keyTb, ones], axis: 3)          // (tb,1,1,L+imgLen)
            let sm = MLX.where(mExt, scoresT, MLXArray(-1e9))            // (tb,H,L,L+imgLen)
            let styledOut = MLX.matmul(MLX.softmax(sm, axis: -1), vTarget)
            let outT = nativeOut * (1 - st.mix) + styledOut * st.mix
            // Ref batch: native attention, unchanged.
            let keyR = mask[tb..<B, 0, 0, 0...]                          // (tb, L)
            let keyRb = keyR.expandedDimensions(axis: 1).expandedDimensions(axis: 2)
            var scoresR = MLX.matmul(qR, kR.transposed(0, 1, 3, 2)) * scale
            scoresR = MLX.where(keyRb, scoresR, MLXArray(-1e9))
            let outR = MLX.matmul(MLX.softmax(scoresR, axis: -1), vR)
            return MLX.concatenated([outT, outR], axis: 0).transposed(0, 2, 1, 3).reshaped([B, L, H * D])
        } else {
            let nativeA = MLX.softmax(nativeScores, axis: -1)
            let nativeOut = MLX.matmul(nativeA, vT)
            let styledOut = MLX.matmul(MLX.softmax(scoresT, axis: -1), vTarget)
            let outT = nativeOut * (1 - st.mix) + styledOut * st.mix
            let outR = MLX.matmul(MLX.softmax(MLX.matmul(qR, kR.transposed(0, 1, 3, 2)) * scale, axis: -1), vR)
            return MLX.concatenated([outT, outR], axis: 0).transposed(0, 2, 1, 3).reshaped([B, L, H * D])
        }
    }

    // MARK: - blocks / fusion / mlp

    func swiGLU(_ x: MLXArray, _ prefix: String) -> MLXArray {
        let g = MLXNN.silu(lin(x, "\(prefix).gate"))
        return lin(g * lin(x, "\(prefix).up"), "\(prefix).down")
    }

    func textFusionBlock(_ x: MLXArray, _ prefix: String, mask: MLXArray?) -> MLXArray {
        // txtFusion head dim = txtdim/txtheads (== config.headDim only at the real
        // config where both happen to be 128; pass it explicitly for correctness).
        let h = x + attention(rms(x, "\(prefix).prenorm"), "\(prefix).attn",
                              heads: config.txtheads, kvh: config.txtkvheads,
                              hd: config.txtdim / config.txtheads, freqs: nil, mask: mask)
        return h + swiGLU(rms(h, "\(prefix).postnorm"), "\(prefix).mlp")
    }

    func txtFusion(_ x: MLXArray, mask: MLXArray?) -> MLXArray {
        let (b, l, n, d) = (x.dim(0), x.dim(1), x.dim(2), x.dim(3))
        var z = x.reshaped([b * l, n, d])
        for i in 0..<2 { z = textFusionBlock(z, "txtfusion.layerwise_blocks.\(i)", mask: nil) }
        z = z.transposed(0, 2, 1)                                        // (b*l, d, n)
        z = lin(z, "txtfusion.projector").squeezed(axis: -1)            // (b*l, d)
        z = z.reshaped([b, l, d])
        for i in 0..<2 { z = textFusionBlock(z, "txtfusion.refiner_blocks.\(i)", mask: mask) }
        return z
    }

    func txtMLP(_ x: MLXArray) -> MLXArray {
        lin(MLXNN.geluApproximate(lin(rms(x, "txtmlp.0"), "txtmlp.1")), "txtmlp.3")
    }

    func singleStreamBlock(_ x: MLXArray, vec: MLXArray, freqs: MLXArray,
                           mask: MLXArray?, _ i: Int) -> MLXArray {
        let p = "blocks.\(i)"
        let modOut = vec + w["\(p).mod.lin"]!                            // (B, 6*features)
        let ch = MLX.split(modOut, parts: 6, axis: -1)
        let e: (MLXArray) -> MLXArray = { $0.expandedDimensions(axis: 1) }  // (B,features)->(B,1,features)
        let attnIn = (1 + e(ch[0])) * rms(x, "\(p).prenorm") + e(ch[1])
        var h = x + e(ch[2]) * attention(attnIn, "\(p).attn",
                                          heads: config.heads, kvh: config.kvheads, hd: config.headDim,
                                          freqs: freqs, mask: mask, blockIndex: i)
        let mlpIn = (1 + e(ch[3])) * rms(h, "\(p).postnorm") + e(ch[4])
        h = h + e(ch[5]) * swiGLU(mlpIn, "\(p).mlp")
        return h
    }

    func lastLayer(_ x: MLXArray, t: MLXArray) -> MLXArray {
        // SimpleModulation: (t[:,None,:] + lin[2,dim]) -> chunk(2, axis=1) -> scale, shift
        let lin2 = w["last.modulation.lin"]!                             // (2, dim)
        let m = t.expandedDimensions(axis: 1) + lin2.expandedDimensions(axis: 0)  // (B,2,dim)
        let parts = MLX.split(m, parts: 2, axis: 1)                     // each (B,1,dim)
        let n = (1 + parts[0]) * rms(x, "last.norm") + parts[1]
        return lin(n, "last.linear")
    }

    // MARK: - forward

    /// Compute only the text path (txtFusion + txtMLP) — the post-fusion context
    /// tokens `(B, txtlen, features)`. Identical across all denoise steps and
    /// across the 2B batch (same prompt), so style-transfer calls this ONCE and
    /// passes the result to `callAsFunction(cachedCtx:)` to skip ~23 redundant
    /// text-path evaluations (the named "2-B text-path sharing" cost lever).
    public func textPath(context: MLXArray, mask: MLXArray?) -> MLXArray {
        let txtlenPre = context.dim(1)
        let txtFusionMask: MLXArray? = {
            guard let m = mask else { return nil }
            let tm = m[0..., 0..<txtlenPre]
            let row = tm.expandedDimensions(axis: 1).expandedDimensions(axis: 2)
            let col = tm.expandedDimensions(axis: 1).expandedDimensions(axis: 3)
            return row * col
        }()
        return txtMLP(txtFusion(context, mask: txtFusionMask))
    }

    /// Forward. `controlTokens` (optional, (B, Ht*Wt, 64)) carries the Control
    /// LoRA's control latent; when present + `firstControl` set, the control
    /// half is added at the input projection:
    ///   x = first_base(img) + controlStrength * (controlTokens @ firstControl.T [+ bias])
    /// This is the facok input-concat mechanism (see Krea2ControlLoRA.swift).
    public func callAsFunction(img: MLXArray, context: MLXArray, t: MLXArray,
                               pos: MLXArray, mask: MLXArray?,
                               controlTokens: MLXArray? = nil,
                               controlStrength: Float = 1.0,
                               cachedCtx: MLXArray? = nil) -> MLXArray {
        let cfg = config
        var x = lin(img, "first")
        if let ctrl = controlTokens, let fc = firstControl {
            var c = MLX.matmul(ctrl, fc.transposed(1, 0)) * controlStrength   // (B,N,features)
            if let cb = firstControlBias { c = c + cb }
            x = x + c
        }
        let tH = temb(t, cfg.tdim).reshaped([t.dim(0), cfg.tdim])
        let tmlpOut = lin(MLXNN.geluApproximate(lin(tH, "tmlp.0")), "tmlp.2")  // (B, features)
        let tvec = lin(MLXNN.geluApproximate(tmlpOut), "tproj.1")       // (B, 6*features)

        // The text path (txtFusion + txtMLP) depends only on (context, mask's
        // text slice) — identical across every denoise step and across the 2B
        // batch (same prompt). Style-transfer computes it ONCE via `textPath`
        // and passes it as `cachedCtx` to skip ~23 redundant text-path evals.
        let ctx: MLXArray
        if let cached = cachedCtx {
            ctx = cached
        } else {
            // txtFusion mask: BOOL (True = attend), matching torch _mask(). The
            // earlier `mask: nil` deviated from the reference (which masks text
            // padding). Built from the text slice of the key-padding mask.
            let txtlenPre = context.dim(1)
            let txtFusionMask: MLXArray? = {
                guard let m = mask else { return nil }
                let tm = m[0..., 0..<txtlenPre]                          // (B, txtlen) bool
                let row = tm.expandedDimensions(axis: 1).expandedDimensions(axis: 2)  // (B,1,1,txtlen)
                let col = tm.expandedDimensions(axis: 1).expandedDimensions(axis: 3)  // (B,1,txtlen,1)
                return row * col                                          // (B,1,txtlen,txtlen) bool
            }()
            ctx = txtMLP(txtFusion(context, mask: txtFusionMask))
        }
        let txtlen = ctx.dim(1)
        var combined = MLX.concatenated([ctx, x], axis: 1)
        var posP = pos
        var maskP = mask
        let pad = (-combined.dim(1)) % 256
        if pad > 0 {
            combined = MLX.padded(combined, widths: [[0, 0], [0, pad], [0, 0]])
            posP = MLX.padded(pos, widths: [[0, 0], [0, pad], [0, 0]])
            if let m = mask { maskP = MLX.padded(m, widths: [[0, 0], [0, pad]]) }
        }
        let attnMask: MLXArray? = {
            guard let mp = maskP else { return nil }
            let row = mp.expandedDimensions(axis: 1).expandedDimensions(axis: 2)  // (B,1,1,L)
            let col = mp.expandedDimensions(axis: 1).expandedDimensions(axis: 3)  // (B,1,L,1)
            return row * col
        }()
        let freqs = ropeFreqs(posP)
        var h = combined
        for i in 0..<cfg.layers {
            h = singleStreamBlock(h, vec: tvec, freqs: freqs, mask: attnMask, i)
        }
        let final = lastLayer(h, t: tmlpOut)
        return final[0..., txtlen..<(txtlen + x.dim(1)), 0...]
    }
}
