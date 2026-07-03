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

public struct Krea2DiT {
    public let config: Krea2Config
    let w: [String: MLXArray]

    public init(config: Krea2Config, weights: [String: MLXArray]) {
        self.config = config
        self.w = weights
    }

    // MARK: - primitives

    /// Linear: x @ weight.T + bias. Auto-detects MLX-quantized weights (8-bit
    /// g64) via the `<prefix>.weight.scales` companion key and dispatches to
    /// quantizedMM; otherwise plain matmul. Matches python
    /// scripts/krea2_quantize_turbo.py (BITS=8, GROUP=64).
    @inline(__always) func lin(_ x: MLXArray, _ prefix: String) -> MLXArray {
        let wk = "\(prefix).weight"
        let y: MLXArray
        if let scales = w["\(wk).scales"] {
            y = MLX.quantizedMM(x, w[wk]!, scales: scales, biases: w["\(wk).biases"],
                                transpose: true, groupSize: 64, bits: 8)
        } else {
            y = MLX.matmul(x, w[wk]!.transposed(1, 0))
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
                   freqs: MLXArray?, mask: MLXArray?) -> MLXArray {
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
        var scores = MLX.matmul(q, k.transposed(0, 1, 3, 2)) * scale     // (B,H,L,L)
        if let mask { scores = MLX.where(mask, scores, MLXArray(-1e9)) }
        let a = MLX.softmax(scores, axis: -1)
        var out = MLX.matmul(a, v).transposed(0, 2, 1, 3).reshaped([B, L, heads * hd])
        out = lin(out * MLX.sigmoid(gate), "\(prefix).wo")
        return out
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
                                          freqs: freqs, mask: mask)
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

    public func callAsFunction(img: MLXArray, context: MLXArray, t: MLXArray,
                               pos: MLXArray, mask: MLXArray?) -> MLXArray {
        let cfg = config
        let x = lin(img, "first")
        let tH = temb(t, cfg.tdim).reshaped([t.dim(0), cfg.tdim])
        let tmlpOut = lin(MLXNN.geluApproximate(lin(tH, "tmlp.0")), "tmlp.2")  // (B, features)
        let tvec = lin(MLXNN.geluApproximate(tmlpOut), "tproj.1")       // (B, 6*features)

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
        let ctx = txtMLP(txtFusion(context, mask: txtFusionMask))
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
