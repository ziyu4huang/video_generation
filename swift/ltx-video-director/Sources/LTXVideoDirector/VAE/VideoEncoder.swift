//
//  VideoEncoder.swift
//  LTXVideoDirector
//
//  Native assembly of the LTX-2.3 video VAE encoder (ltx_core_mlx.model.
//  video_vae.video_vae.VideoEncoder) — turns a conditioning image/video into
//  a latent (needed for real I2V conditioning, not just training/round-trip).
//  Wired against the REAL checkpoint's structure — confirmed by inspecting
//  mlx-models/vae/ltx-2.3-vae/vae_encoder.safetensors directly (86 tensors)
//  AND by reading video_vae.py's VideoEncoder.__init__/encode() directly:
//
//    patchifySpatial(pixels, patchSize=4): 3ch -> 48ch, 4x spatial downsample
//    conv_in:  Conv3dBlock 48 -> 128
//    down_blocks.0: ResBlockStage(128ch, 4 blocks)
//    down_blocks.1: SpaceToDepthDownsample 128->256, stride (1,2,2)  -> 64ch conv-branch
//    down_blocks.2: ResBlockStage(256ch, 6 blocks)
//    down_blocks.3: SpaceToDepthDownsample 256->512, stride (2,1,1)  -> 256ch conv-branch
//    down_blocks.4: ResBlockStage(512ch, 4 blocks)
//    down_blocks.5: SpaceToDepthDownsample 512->1024, stride (2,2,2) -> 128ch conv-branch
//    down_blocks.6: ResBlockStage(1024ch, 2 blocks)
//    down_blocks.7: SpaceToDepthDownsample 1024->1024, stride (2,2,2) -> 128ch conv-branch
//    down_blocks.8: ResBlockStage(1024ch, 2 blocks)
//    conv_out: Conv3dBlock 1024 -> 129 (keep first 128 channels, discard the rest)
//    normalize_latent: (x - mean) / std  — SUBTRACT, unlike the decoder's denormalize (ADD)
//
//  All down_blocks use causal=true (confirmed: video_vae.py hardcodes
//  causal=True for every ResBlockStage/conv_in/conv_out in VideoEncoder,
//  unlike VideoDecoder which defaults to false for LTX-2.3).
//
//  Checkpoint quirk: per_channel_statistics keys are underscore-prefixed
//  (`_mean_of_means`/`_std_of_means`) in the safetensors file — MLX nn.Module
//  skips underscore-prefixed attributes, so the reference remaps them on
//  load (`remap_encoder_weight_keys`). This loader does the same remap.
//

import Foundation
import MLX
import MLXNN

public struct VideoEncoderDownStage {
    public let downsample: SpaceToDepthDownsample
}

public struct VideoEncoder {
    public let convIn: Conv3dBlock
    public let convOut: Conv3dBlock
    public let meanOfMeans: MLXArray
    public let stdOfMeans: MLXArray
    public let resStages: [ResBlockStage]              // indices 0,2,4,6,8
    public let downsampleStages: [SpaceToDepthDownsample]  // indices 1,3,5,7
    public let patchSize: Int

    /// Real down_blocks.{1,3,5,7} (in_channels, out_channels, stride) — NOT
    /// derivable from checkpoint shapes alone (a shape only gives the
    /// conv-branch's out-channel count, not the (in,out) pair the group_size
    /// skip-branch formula needs). Read from VideoEncoder.__init__ directly.
    public static let downsampleConfig: [(inCh: Int, outCh: Int, stride: (Int, Int, Int))] = [
        (128, 256, (1, 2, 2)),
        (256, 512, (2, 1, 1)),
        (512, 1024, (2, 2, 2)),
        (1024, 1024, (2, 2, 2)),
    ]

    public init(weights: [String: MLXArray], patchSize: Int = 4) {
        // Remap underscore-prefixed per-channel-statistics keys (checkpoint
        // quirk — see file header).
        var w = weights
        if let v = w.removeValue(forKey: "per_channel_statistics._mean_of_means") {
            w["per_channel_statistics.mean_of_means"] = v
        }
        if let v = w.removeValue(forKey: "per_channel_statistics._std_of_means") {
            w["per_channel_statistics.std_of_means"] = v
        }

        self.patchSize = patchSize
        self.convIn = Conv3dBlock(weight: w["conv_in.conv.weight"]!, bias: w["conv_in.conv.bias"]!, causal: true, spatialPaddingMode: "zeros")
        self.convOut = Conv3dBlock(weight: w["conv_out.conv.weight"]!, bias: w["conv_out.conv.bias"]!, causal: true, spatialPaddingMode: "zeros")
        self.meanOfMeans = w["per_channel_statistics.mean_of_means"]!
        self.stdOfMeans = w["per_channel_statistics.std_of_means"]!

        let resBlockIndices = [0, 2, 4, 6, 8]
        var stages: [ResBlockStage] = []
        for idx in resBlockIndices {
            let prefix = "down_blocks.\(idx)"
            var count = 0
            while w["\(prefix).res_blocks.\(count).conv1.conv.weight"] != nil { count += 1 }
            let subWeights = Dictionary(uniqueKeysWithValues: w.compactMap { k, v -> (String, MLXArray)? in
                guard k.hasPrefix("\(prefix).") else { return nil }
                return (String(k.dropFirst(prefix.count + 1)), v)
            })
            stages.append(ResBlockStage(weights: subWeights, numBlocks: count, causal: true, spatialPaddingMode: "zeros"))
        }
        self.resStages = stages

        let downsampleIndices = [1, 3, 5, 7]
        var downs: [SpaceToDepthDownsample] = []
        for (i, idx) in downsampleIndices.enumerated() {
            let prefix = "down_blocks.\(idx)"
            let cfg = Self.downsampleConfig[i]
            downs.append(SpaceToDepthDownsample(
                weight: w["\(prefix).conv.conv.weight"]!, bias: w["\(prefix).conv.conv.bias"]!,
                inChannels: cfg.inCh, outChannels: cfg.outCh, stride: cfg.stride))
        }
        self.downsampleStages = downs
    }

    /// Encode pixels (B, 3, F, H, W) in [-1, 1], PyTorch/BCFHW layout, to a
    /// latent (B, 128, F', H', W') in the same layout — matching the
    /// reference `encode()` exactly.
    public func callAsFunction(_ pixelsBCFHW: MLXArray) -> MLXArray {
        var x = pixelsBCFHW.transposed(0, 2, 3, 4, 1)  // BCFHW -> BFHWC
        x = VAESampling.patchifySpatial(x, patchSize: patchSize)
        x = convIn(x)

        for i in 0..<resStages.count {
            x = resStages[i](x)
            if i < downsampleStages.count {
                x = downsampleStages[i](x)
            }
        }

        x = convOut(MLXNN.silu(PixelNorm.apply(x)))
        let c = x.dim(4)
        x = x[0..., 0..., 0..., 0..., 0..<min(128, c)]

        let mean = meanOfMeans.reshaped([1, 1, 1, 1, -1])
        let std = stdOfMeans.reshaped([1, 1, 1, 1, -1])
        x = (x - mean) / std

        return x.transposed(0, 4, 1, 2, 3)  // BFHWC -> BCFHW
    }
}
