//
//  VideoDecoder.swift
//  LTXVideoDirector
//
//  Native assembly of the LTX-2.3 video VAE decoder (ltx_core_mlx.model.
//  video_vae.video_vae.VideoDecoder) from the components ported so far
//  (Conv3dBlock, ResBlockStage, PixelNorm, VAESampling, PerChannelStatistics),
//  wired against the REAL checkpoint's structure — confirmed by inspecting
//  mlx-models/vae/ltx-2.3-vae/vae_decoder.safetensors directly (86 tensors):
//
//    conv_in:  Conv3dBlock 128 -> 1024
//    up_blocks.0: ResBlockStage(1024ch, 2 blocks)
//    up_blocks.1: DepthToSpaceUpsample 1024->4096, pixelShuffle(sf=2,tf=2) -> 512ch
//    up_blocks.2: ResBlockStage(512ch, 2 blocks)
//    up_blocks.3: DepthToSpaceUpsample 512->4096, pixelShuffle(sf=2,tf=2) -> 512ch
//    up_blocks.4: ResBlockStage(512ch, 4 blocks)
//    up_blocks.5: DepthToSpaceUpsample 512->512, pixelShuffle(sf=1,tf=2) -> 256ch
//    up_blocks.6: ResBlockStage(256ch, 6 blocks)
//    up_blocks.7: DepthToSpaceUpsample 256->512, pixelShuffle(sf=2,tf=1) -> 128ch
//    up_blocks.8: ResBlockStage(128ch, 4 blocks)
//    conv_out: Conv3dBlock 128 -> 48   (48 = 3 * patchSize^2, patchSize=4)
//    unpatchify_spatial(patchSize=4) -> 3 channels (RGB)
//
//  This is the assembly the real checkpoint uses (up_blocks upsample factor
//  schedule AND the two easy-to-miss details read directly from video_vae.py's
//  own decode() body: dropping the first frame after every temporal upsample,
//  and a PixelNorm+SiLU pre-activation before conv_out), not a guess. Not yet
//  parity-tested end-to-end against a real forward pass (no tiling/memory
//  budgeting ported yet — see PLAN.md) — safe for small latents only.
//

import Foundation
import MLX
import MLXNN

public struct VideoDecoderUpsampleStage {
    public let upsample: DepthToSpaceUpsample
    public let spatialFactor: Int
    public let temporalFactor: Int
}

public struct VideoDecoder {
    public let convIn: Conv3dBlock
    public let convOut: Conv3dBlock
    public let stats: PerChannelStatistics
    /// Alternating ResBlockStage / DepthToSpaceUpsample, matching up_blocks.0-8.
    public let resStages: [ResBlockStage]     // indices 0,2,4,6,8
    public let upsampleStages: [VideoDecoderUpsampleStage]  // indices 1,3,5,7
    public let patchSize: Int
    public let causal: Bool
    public let spatialPaddingMode: String

    /// Real upsample factor schedule from video_vae.py's VideoDecoder.__init__
    /// (`_upsample_config`) — NOT derivable from checkpoint shapes alone
    /// (shape only gives total channel count, not the sf/tf split).
    public static let upsampleConfig: [(sf: Int, tf: Int)] = [(2, 2), (2, 2), (1, 2), (2, 1)]

    /// `causal` defaults to false — LTX-2.3's actual trained config (per
    /// video_vae.py's own default and embedded_config.json's
    /// "spatial_padding_mode": "zeros"; a prior hardcoded "reflect" caused a
    /// documented keyframe hold-cut-decay regression at the latent boundary).
    public init(weights: [String: MLXArray], causal: Bool = false, spatialPaddingMode: String = "zeros", patchSize: Int = 4) {
        func w(_ key: String) -> MLXArray { weights[key]! }

        self.causal = causal
        self.spatialPaddingMode = spatialPaddingMode
        self.patchSize = patchSize

        self.convIn = Conv3dBlock(
            weight: w("conv_in.conv.weight"), bias: w("conv_in.conv.bias"),
            causal: causal, spatialPaddingMode: spatialPaddingMode)
        self.convOut = Conv3dBlock(
            weight: w("conv_out.conv.weight"), bias: w("conv_out.conv.bias"),
            causal: causal, spatialPaddingMode: spatialPaddingMode)
        self.stats = PerChannelStatistics(
            mean: w("per_channel_statistics.mean"), std: w("per_channel_statistics.std"))

        let resBlockIndices = [0, 2, 4, 6, 8]
        let upsampleIndices = [1, 3, 5, 7]

        var stages: [ResBlockStage] = []
        for idx in resBlockIndices {
            let prefix = "up_blocks.\(idx)"
            var count = 0
            while weights["\(prefix).res_blocks.\(count).conv1.conv.weight"] != nil { count += 1 }
            let subWeights = Dictionary(uniqueKeysWithValues: weights.compactMap { k, v -> (String, MLXArray)? in
                guard k.hasPrefix("\(prefix).") else { return nil }
                return (String(k.dropFirst(prefix.count + 1)), v)
            })
            stages.append(ResBlockStage(weights: subWeights, numBlocks: count, causal: causal, spatialPaddingMode: spatialPaddingMode))
        }
        self.resStages = stages

        var upsamples: [VideoDecoderUpsampleStage] = []
        for (i, idx) in upsampleIndices.enumerated() {
            let prefix = "up_blocks.\(idx)"
            let conv = Conv3dBlock(
                weight: w("\(prefix).conv.conv.weight"), bias: w("\(prefix).conv.conv.bias"),
                causal: causal, spatialPaddingMode: spatialPaddingMode)
            let (sf, tf) = Self.upsampleConfig[i]
            upsamples.append(VideoDecoderUpsampleStage(
                upsample: DepthToSpaceUpsample(conv: conv), spatialFactor: sf, temporalFactor: tf))
        }
        self.upsampleStages = upsamples
    }

    /// Decode a latent (B, C, F, H, W) in PyTorch/BCFHW layout, matching the
    /// reference `decode()`'s own input/output convention exactly (it
    /// transposes to BFHWC internally and back to BCFHW on return).
    public func callAsFunction(_ latentBCFHW: MLXArray) -> MLXArray {
        var x = latentBCFHW.transposed(0, 2, 3, 4, 1)  // BCFHW -> BFHWC
        x = stats.denormalizeLatent(x)
        x = convIn(x)
        for i in 0..<resStages.count {
            x = resStages[i](x)
            if i < upsampleStages.count {
                let stage = upsampleStages[i]
                x = stage.upsample(x)
                x = VAESampling.pixelShuffle3D(x, spatialFactor: stage.spatialFactor, temporalFactor: stage.temporalFactor)
                // Reference: ALWAYS drop the first frame after a temporal
                // upsample (unconditional on causal, gated only on tf>1).
                if stage.temporalFactor > 1 {
                    let d = x.dim(1)
                    x = x[0..., 1..<d, 0..., 0..., 0...]
                }
            }
        }
        // Pre-activation PixelNorm + SiLU before the final conv.
        x = convOut(MLXNN.silu(PixelNorm.apply(x)))
        x = VAESampling.unpatchifySpatial(x, patchSize: patchSize)
        return x.transposed(0, 4, 1, 2, 3)  // BFHWC -> BCFHW
    }
}
