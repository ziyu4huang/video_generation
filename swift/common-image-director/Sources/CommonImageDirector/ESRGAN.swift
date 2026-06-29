//
//  ESRGAN.swift
//  CommonImageDirector
//
//  Phase D (4K修復): native Swift/MLX port of RealPLKSR (Partial Large Kernel
//  CNN for super-resolution), the arch behind 4xNomosWebPhoto_RealPLKSR. Direct
//  port of spandrel's RealPLKSR.py (torch) — the python upscale path runs torch,
//  so this is the self-contained MLX equivalent for the Swift CLIs.
//
//  Arch (forward):  feats(x) + repeat_interleave(x, r², channel)  →  PixelShuffle(r)
//    feats = Conv(3→dim) → nBlocks×PLKBlock → Conv(dim→out·r²)
//    PLKBlock: skip; DCCM(conv dim→2d, Mish, conv 2d→dim); PLKConv(large-kernel conv
//              on first dim·split channels); EA(x·σ(conv(x))); refine(1×1 conv);
//              GroupNorm(groups) ; + skip
//
//  MLX conv2d is channels-LAST (NHWC) with weight [C_out,kH,kW,C_in]; torch is
//  NCHW with weight [C_out,C_in,kH,kW]. Weights are permuted once at load and the
//  whole network runs in NHWC. PixelShuffle/GroupNorm/repeat_interleave are
//  implemented via reshape+permute to match PyTorch's exact layout (verified by
//  parity against the torch reference).
//

import Foundation
import MLX

/// Native MLX RealPLKSR super-resolution model (4×). Loads a converted
/// safetensors state_dict (torch keys: feats.0, feats.<i>.<...>, feats.30).
public struct RealPLKSR {
    public let dim: Int
    public let nBlocks: Int
    public let upscale: Int          // r
    public let kernelSize: Int       // 17
    public let splitDim: Int         // pdim = dim * splitRatio (channels the large kernel acts on)
    public let normGroups: Int       // 4

    // entry conv (feats.0): 3 → dim, 3×3
    let entryW: MLXArray
    let entryB: MLXArray
    // exit conv (feats.30): dim → out*upscale² , 3×3
    let exitW: MLXArray
    let exitB: MLXArray
    // per-block weights (index 0..nBlocks-1 maps to feats.1..nBlocks)
    let blocks: [Block]
    let outChannels: Int

    struct Block {
        let cm0W: MLXArray; let cm0B: MLXArray   // DCCM conv dim→2dim 3×3
        let cm1W: MLXArray; let cm1B: MLXArray   // DCCM conv 2dim→dim 3×3
        let lkW: MLXArray;  let lkB: MLXArray    // PLK conv splitDim→splitDim k×k
        let eaW: MLXArray;  let eaB: MLXArray    // EA conv dim→dim 3×3
        let refW: MLXArray; let refB: MLXArray   // refine conv dim→dim 1×1
        let gnW: MLXArray;  let gnB: MLXArray    // GroupNorm(groups, dim)
    }

    public init(weights: [String: MLXArray], dim: Int = 64, nBlocks: Int = 28,
                upscale: Int = 4, kernelSize: Int = 17, splitRatio: Float = 0.25,
                normGroups: Int = 4, outChannels: Int = 3) {
        self.dim = dim; self.nBlocks = nBlocks; self.upscale = upscale
        self.kernelSize = kernelSize
        self.splitDim = Int(Float(dim) * splitRatio)
        self.normGroups = normGroups
        self.outChannels = outChannels

        func convW(_ key: String) -> MLXArray {
            // torch (C_out, C_in, kH, kW) → MLX (C_out, kH, kW, C_in) = permute [0,2,3,1]
            weights[key]!.transposed(0, 2, 3, 1).asType(.float32)
        }
        func b(_ key: String) -> MLXArray { weights[key]!.asType(.float32) }

        entryW = convW("feats.0.weight"); entryB = b("feats.0.bias")
        exitW = convW("feats.\(nBlocks + 2).weight")     // feats.30 for 28 blocks (0, 1..28, 29=dropout, 30)
        exitB = b("feats.\(nBlocks + 2).bias")

        var blks: [Block] = []
        blks.reserveCapacity(nBlocks)
        for i in 0..<nBlocks {
            let p = "feats.\(i + 1)"      // feats.1..28
            blks.append(Block(
                cm0W: convW("\(p).channel_mixer.0.weight"), cm0B: b("\(p).channel_mixer.0.bias"),
                cm1W: convW("\(p).channel_mixer.2.weight"), cm1B: b("\(p).channel_mixer.2.bias"),
                lkW: convW("\(p).lk.conv.weight"),          lkB:  b("\(p).lk.conv.bias"),
                eaW: convW("\(p).attn.f.0.weight"),         eaB:  b("\(p).attn.f.0.bias"),
                refW: convW("\(p).refine.weight"),          refB: b("\(p).refine.bias"),
                gnW: b("\(p).norm.weight"),                 gnB:  b("\(p).norm.bias")))
        }
        self.blocks = blks
    }

    /// Upscale an image. Input/output are (1, H, W, 3) float32 in [0,1] (NHWC).
    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        let r = upscale
        let B = x.dim(0), H = x.dim(1), W = x.dim(2)
        let identity = x.asType(.float32)

        var h = conv(identity, entryW, entryB, padding: 1)     // (1,H,W,dim)
        for blk in blocks {
            let skip = h
            // DCCM: conv dim→2dim (Mish) → conv 2dim→dim
            var y = conv(h, blk.cm0W, blk.cm0B, padding: 1)
            y = mish(y)
            y = conv(y, blk.cm1W, blk.cm1B, padding: 1)
            // PLKConv: large-kernel conv on the first splitDim channels, rest passthrough.
            let head = y[0..., 0..<H, 0..<W, 0..<splitDim]
            let headOut = conv(head, blk.lkW, blk.lkB, padding: kernelSize / 2)
            if splitDim < dim {
                let tail = y[0..., 0..<H, 0..<W, splitDim..<dim]
                y = MLX.concatenated([headOut, tail], axis: 3)
            } else {
                y = headOut
            }
            // EA: y * sigmoid(conv(y))
            let attn = MLX.sigmoid(conv(y, blk.eaW, blk.eaB, padding: 1))
            y = y * attn
            // refine 1×1
            y = conv(y, blk.refW, blk.refB, padding: 0)
            // GroupNorm(groups, dim) on the channel axis
            y = groupNorm(y, weight: blk.gnW, bias: blk.gnB, groups: normGroups, channels: dim)
            h = y + skip
        }
        // exit conv → out·r² channels
        var feats = conv(h, exitW, exitB, padding: 1)    // (1,H,W,out·r²)
        // global residual: repeat_interleave(identity, r², channel) added before shuffle.
        let rep = identity.expandedDimensions(axis: 4)               // (1,H,W,3,1)
        let repB = MLX.broadcast(rep, to: [B, H, W, outChannels, r * r])
        let idRep = repB.reshaped([B, H, W, outChannels * r * r]).asType(.float32)
        feats = feats + idRep
        // PixelShuffle (NHWC, PyTorch layout): (B,H,W,C·r²) → (B,H·r,W·r,C)
        return pixelShuffleNHWC(feats, r: r, channels: outChannels)
    }

    // MARK: - ops

    /// NHWC conv2d + bias with explicit padding (IntOrPair literal inference is
    /// unreliable across MLX versions, so wrap it).
    private func conv(_ x: MLXArray, _ w: MLXArray, _ b: MLXArray, padding: Int) -> MLXArray {
        MLX.conv2d(x, w, stride: IntOrPair(1), padding: IntOrPair(padding),
                   dilation: IntOrPair(1), groups: 1) + b
    }

    // MARK: - ops

    /// Mish: x * tanh(softplus(x)); softplus via stable log1p(exp(-|x|)) + relu(x).
    private func mish(_ x: MLXArray) -> MLXArray {
        let sp = MLX.maximum(x, MLXArray(0.0)) + MLX.log1p(MLX.exp(-MLX.abs(x)))
        return x * MLX.tanh(sp)
    }

    /// GroupNorm on the last (channel) axis: split channels into `groups`,
    /// normalize within each group, then affine.
    private func groupNorm(_ x: MLXArray, weight: MLXArray, bias: MLXArray,
                           groups: Int, channels: Int) -> MLXArray {
        let B = x.dim(0), H = x.dim(1), W = x.dim(2)
        let cg = channels / groups
        let xr = x.reshaped([B, H, W, groups, cg]).asType(.float32)
        let mean = xr.mean(axis: 4, keepDims: true)
        let varr = ((xr - mean) * (xr - mean)).mean(axis: 4, keepDims: true)
        let norm = (xr - mean) / MLX.sqrt(varr + 1e-6)
        let w = weight.reshaped([1, 1, 1, channels]).asType(.float32)
        let bvec = bias.reshaped([1, 1, 1, channels]).asType(.float32)
        return norm.reshaped([B, H, W, channels]) * w + bvec
    }

    /// PyTorch PixelShuffle for NHWC: (B,H,W,C·r²) → (B,H·r,W·r,C).
    /// channel ch = c·r² + rh·r + rw maps to spatial (H·r+rh, W·r+rw, c).
    private func pixelShuffleNHWC(_ x: MLXArray, r: Int, channels: Int) -> MLXArray {
        let B = x.dim(0), H = x.dim(1), W = x.dim(2)
        let xr = x.reshaped([B, H, W, channels, r, r])      // (B,H,W,c,rh,rw)
        let p = xr.transposed(0, 1, 4, 2, 5, 3)             // (B,H,rh,W,rw,c)
        return p.reshaped([B, H * r, W * r, channels])
    }
}

/// Load a RealPLKSR model from a converted safetensors file (torch state_dict).
public enum ESRGANLoader {
    public static func loadRealPLKSR(url: URL) throws -> RealPLKSR {
        RealPLKSR(weights: try loadArrays(url: url))
    }
}
