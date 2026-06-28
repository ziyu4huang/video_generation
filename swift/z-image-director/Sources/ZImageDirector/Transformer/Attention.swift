//
//  Attention.swift
//  ZImageDirector
//
//  Port of app/transformer.py:Attention.
//  Multi-head attention with RoPE (precomputed cos/sin) and QK-RMSNorm.
//  Supports both fused (to_qkv) and unfused (to_q/to_k/to_v) weight layouts —
//  the pipeline runs fuse_qkv() after loading, but the underlying safetensors
//  store them unfused; the loader picks the matching path.
//

import Foundation
import MLX
import MLXNN
import MLXFast

public final class Attention: Module {

    public let nheads: Int
    public let headDim: Int
    public let scale: Float
    public let ropeTheta: Float
    public let eps: Float

    // Unfused (on-disk layout).
    public var toq: QuantizedLinear?
    public var tok: QuantizedLinear?
    public var tov: QuantizedLinear?
    // Fused (optional, after fuse_qkv).
    public var toqkv: QuantizedLinear?
    public let too: QuantizedLinear

    public let normQ: ZRMSNorm
    public let normK: ZRMSNorm

    // RoPE axis dims: [32, 48, 48] → splits [0, 32, 80].
    public let dims: [Int]
    public let splits: [Int]

    public init(dim: Int, nheads: Int, ropeTheta: Float = 256.0, eps: Float = 1e-5) {
        self.nheads = nheads
        self.headDim = dim / nheads
        self.scale = pow(Float(headDim), -0.5)
        self.ropeTheta = ropeTheta
        self.eps = eps
        self.dims = [32, 48, 48]
        self.splits = [0, 32, 80]
        self.toq = QuantizedLinear(dim, dim, bias: false)
        self.tok = QuantizedLinear(dim, dim, bias: false)
        self.tov = QuantizedLinear(dim, dim, bias: false)
        self.toqkv = nil
        self.too = QuantizedLinear(dim, dim, bias: false)
        self.normQ = ZRMSNorm(dims: headDim, eps: eps)
        self.normK = ZRMSNorm(dims: headDim, eps: eps)
        super.init()
    }

    /// Build from loaded weights (unfused on-disk layout).
    public init(
        dim: Int, nheads: Int, ropeTheta: Float = 256.0, eps: Float = 1e-5,
        toq: QuantizedLinear, tok: QuantizedLinear, tov: QuantizedLinear,
        too: QuantizedLinear, normQ: ZRMSNorm, normK: ZRMSNorm
    ) {
        self.nheads = nheads
        self.headDim = dim / nheads
        self.scale = pow(Float(headDim), -0.5)
        self.ropeTheta = ropeTheta
        self.eps = eps
        self.dims = [32, 48, 48]
        self.splits = [0, 32, 80]
        self.toq = toq
        self.tok = tok
        self.tov = tov
        self.toqkv = nil
        self.too = too
        self.normQ = normQ
        self.normK = normK
        super.init()
    }

    /// Mark as fused so __call__ uses the to_qkv path.
    public func markFused(_ fused: QuantizedLinear) {
        self.toqkv = fused
        self.toq = nil
        self.tok = nil
        self.tov = nil
    }

    public func callAsFunction(
        _ x: MLXArray, mask: MLXArray? = nil, positions: MLXArray? = nil,
        cos: MLXArray? = nil, sin: MLXArray? = nil
    ) -> MLXArray {
        let (B, L, _) = (x.dim(0), x.dim(1), x.dim(2))

        var q: MLXArray
        var k: MLXArray
        var v: MLXArray
        if let toqkv = toqkv {
            // qkv = to_qkv(x).reshape(B, L, 3, nheads, head_dim); split axis=2
            let qkv = toqkv(x).reshaped([B, L, 3, nheads, headDim])
            let parts = qkv.split(parts: 3, axis: 2)
            q = parts[0].squeezed(axis: 2)
            k = parts[1].squeezed(axis: 2)
            v = parts[2].squeezed(axis: 2)
        } else {
            q = toq!(x).reshaped([B, L, nheads, headDim])
            k = tok!(x).reshaped([B, L, nheads, headDim])
            v = tov!(x).reshaped([B, L, nheads, headDim])
        }

        q = normQ(q)
        k = normK(k)

        if let cos = cos, let sin = sin {
            // RoPE: rotate even/odd index pairs. q,k are (B, L, H, headDim).
            // cos/sin are (B, L, 1, headDim/2) — broadcast over heads.
            // Use reshape→split (robust) instead of strided indexing.
            let half = headDim / 2
            let qr = q.reshaped([B, L, nheads, half, 2])
            let q1 = qr[0..., 0..., 0..., 0..., 0]   // q[..., 0::2]
            let q2 = qr[0..., 0..., 0..., 0..., 1]   // q[..., 1::2]
            q = MLX.stacked(
                [q1 * cos - q2 * sin, q1 * sin + q2 * cos], axis: -1
            ).reshaped([B, L, nheads, headDim])

            let kr = k.reshaped([B, L, nheads, half, 2])
            let k1 = kr[0..., 0..., 0..., 0..., 0]
            let k2 = kr[0..., 0..., 0..., 0..., 1]
            k = MLX.stacked(
                [k1 * cos - k2 * sin, k1 * sin + k2 * cos], axis: -1
            ).reshaped([B, L, nheads, headDim])
        }

        // (B, nheads, L, headDim)
        q = q.transposed(0, 2, 1, 3)
        k = k.transposed(0, 2, 1, 3)
        v = v.transposed(0, 2, 1, 3)

        let output = MLXFast.scaledDotProductAttention(
            queries: q, keys: k, values: v, scale: scale, mask: mask
        )
        return too(output.transposed(0, 2, 1, 3).reshaped([B, L, x.dim(2)]))
    }
}
