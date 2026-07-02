//
//  RoPE.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.transformer.rope — the DiT
//  transformer's rotary position embeddings. LTX-2.3 uses log-spaced
//  frequency indices with fractional positions (NOT standard 1/theta^k
//  RoPE), and SPLIT layout (first-half-cos/second-half-sin) — production
//  checkpoints all use SPLIT (upstream switched the default from
//  INTERLEAVED in PR #212); INTERLEAVED is legacy and not ported here.
//
//  Phase 2 start: this is a pure-function (no learnable weights) building
//  block of the 48-layer transformer — the actual latent-generating
//  denoiser, still bridged via RunPyBridge (see PLAN.md). No weights means
//  no checkpoint-loading concerns, just numerical parity.
//

import Foundation
import MLX

public enum RoPE {
    /// Log-spaced frequency indices. Reference: generate_freq_grid_pytorch.
    public static func generateFreqGrid(theta: Double, numPosDims: Int, innerDim: Int) -> MLXArray {
        let nElem = 2 * numPosDims
        let numFreqs = innerDim / nElem
        let logTheta = log(theta)
        // linspace(log(1)/log(theta), log(theta)/log(theta), numFreqs) == linspace(0, 1, numFreqs)
        let lin = MLXArray(stride(from: 0.0, through: Double(numFreqs - 1), by: 1).map { Float($0) / Float(max(1, numFreqs - 1)) })
        let indices = MLX.pow(MLXArray(Float(theta)), lin.asType(.float32))
        _ = logTheta
        return indices * Float(Double.pi / 2.0)
    }

    /// Fractional-position frequency angles. Reference: compute_freqs.
    public static func computeFreqs(freqIndices: MLXArray, positions: MLXArray, maxPos: [Int]) -> MLXArray {
        let numPosDims = positions.dim(-1)
        let b = positions.dim(0), n = positions.dim(1)
        var perAxis: [MLXArray] = []
        for i in 0..<numPosDims {
            let axis = positions[0..., 0..., i].asType(.float32) / Float(maxPos[i])
            perAxis.append(axis)
        }
        let fracPositions = MLX.stacked(perAxis, axis: -1)  // (B, N, numPosDims)
        let scaled = freqIndices * (fracPositions.expandedDimensions(axis: -1) * 2.0 - 1.0)
        // (B, N, numPosDims, numFreqs) -> transpose to (B, N, numFreqs, numPosDims) -> flatten
        let transposed = scaled.transposed(0, 1, 3, 2)
        return transposed.reshaped([b, n, -1])
    }

    public struct Freqs {
        public let cos: MLXArray
        public let sin: MLXArray
    }

    /// Precompute per-head SPLIT-layout RoPE cos/sin. Reference: precompute_freqs_cis (rope_type="split").
    public static func precomputeSplit(
        positions: MLXArray, innerDim: Int, numHeads: Int, theta: Double = 10000.0, maxPos: [Int]? = nil
    ) -> Freqs {
        let numPosDims = positions.dim(-1)
        let resolvedMaxPos = maxPos ?? Array([20, 2048, 2048].prefix(numPosDims))
        let freqIndices = generateFreqGrid(theta: theta, numPosDims: numPosDims, innerDim: innerDim)
        var freqs = computeFreqs(freqIndices: freqIndices, positions: positions, maxPos: resolvedMaxPos)

        let b = freqs.dim(0), n = freqs.dim(1), numFreqs = freqs.dim(2)
        let expected = innerDim / 2
        let padSize = expected - numFreqs
        if padSize > 0 {
            let padding = MLXArray.zeros([b, n, padSize])
            freqs = MLX.concatenated([padding, freqs], axis: -1)
        }

        let cosF = MLX.cos(freqs)
        let sinF = MLX.sin(freqs)
        let headDimHalf = innerDim / (2 * numHeads)
        let cosR = cosF.reshaped([b, n, numHeads, headDimHalf]).transposed(0, 2, 1, 3)
        let sinR = sinF.reshaped([b, n, numHeads, headDimHalf]).transposed(0, 2, 1, 3)
        return Freqs(cos: cosR, sin: sinR)
    }

    /// Apply SPLIT-layout RoPE: first half cos, second half sin.
    /// x: (B, H, N, dim); cos/sin: (B, H, N, dim/2).
    public static func applySplit(_ x: MLXArray, cos: MLXArray, sin: MLXArray) -> MLXArray {
        let cosF = cos.asType(x.dtype)
        let sinF = sin.asType(x.dtype)
        let half = x.dim(-1) / 2
        let x1 = x[.ellipsis, 0..<half]
        let x2 = x[.ellipsis, half..<x.dim(-1)]
        return MLX.concatenated([x1 * cosF - x2 * sinF, x1 * sinF + x2 * cosF], axis: -1)
    }
}
