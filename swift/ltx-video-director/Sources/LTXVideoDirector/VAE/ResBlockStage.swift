//
//  ResBlockStage.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.video_vae.resnet.{ResBlock3d,ResBlockStage}
//  — the pre-activation residual blocks used throughout the LTX-2.3 video VAE.
//  Forward: norm1 -> silu -> conv1 -> norm2 -> silu -> conv2 + skip.
//

import MLX
import MLXNN

public struct ResBlock3d {
    public let conv1: Conv3dBlock
    public let conv2: Conv3dBlock

    public init(conv1: Conv3dBlock, conv2: Conv3dBlock) {
        self.conv1 = conv1
        self.conv2 = conv2
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        let residual = x
        var h = conv1(MLXNN.silu(PixelNorm.apply(x)))
        h = conv2(MLXNN.silu(PixelNorm.apply(h)))
        return h + residual
    }
}

public struct ResBlockStage {
    public let blocks: [ResBlock3d]

    public init(blocks: [ResBlock3d]) {
        self.blocks = blocks
    }

    /// Load a stage's weights from a flat dict keyed like the checkpoint:
    /// `res_blocks.{i}.conv{1,2}.conv.{weight,bias}`.
    public init(weights: [String: MLXArray], numBlocks: Int, causal: Bool, spatialPaddingMode: String) {
        var blocks: [ResBlock3d] = []
        blocks.reserveCapacity(numBlocks)
        for i in 0..<numBlocks {
            let prefix = "res_blocks.\(i)"
            let conv1 = Conv3dBlock(
                weight: weights["\(prefix).conv1.conv.weight"]!,
                bias: weights["\(prefix).conv1.conv.bias"]!,
                causal: causal, spatialPaddingMode: spatialPaddingMode)
            let conv2 = Conv3dBlock(
                weight: weights["\(prefix).conv2.conv.weight"]!,
                bias: weights["\(prefix).conv2.conv.bias"]!,
                causal: causal, spatialPaddingMode: spatialPaddingMode)
            blocks.append(ResBlock3d(conv1: conv1, conv2: conv2))
        }
        self.blocks = blocks
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = x
        for block in blocks {
            h = block(h)
        }
        return h
    }
}
