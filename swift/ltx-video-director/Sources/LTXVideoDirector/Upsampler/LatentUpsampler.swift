//
//  LatentUpsampler.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.upsampler.model.LatentUpsampler — LTX-2.3's
//  dedicated neural spatial-upscale network for the two-stage generation
//  pipeline (generate at half-resolution -> neural-upscale the LATENT ->
//  refine). This is NOT the IC-LoRA restoration/upscale path
//  (UpscaleEngine.swift / `ltx-video upscale`, which fuses LoRA weights onto
//  the full 48-block transformer and needs whole-clip reference
//  conditioning — see PLAN.md's "Research: native spatial upscaling"
//  milestone for why that's a separate, much larger port). LatentUpsampler
//  is a small, self-contained Conv3d/Conv2d ResNet (comparable in size to
//  VideoDecoder/VideoEncoder) that operates directly in the same 128-channel
//  VAE latent space this package already produces — no LoRA, no transformer,
//  no reference-conditioning needed.
//
//  Scope, deliberately narrow (matches this package's other VAE ports):
//    - ONLY the spatial_x2 variant (the checkpoint actually present at
//      mlx-models/vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors —
//      spatial_upsample=true, temporal_upsample=false, rational_resampler=false).
//    - spatial_x1_5 (rational resampler, PixelShuffle2D(3)+BlurDownsample)
//      and temporal_x2 (PixelShuffle3D) are NOT ported — see model.py's
//      SpatialRationalResampler / `_pixel_shuffle_3d` for what a future
//      port of those variants would need.
//
//  Weight key structure (verified against the real checkpoint via
//  scripts/dump_latent_upsampler_reference.py):
//    initial_conv.weight/bias, initial_norm.weight/bias
//    res_blocks.{0-3}.conv1/conv2/norm1/norm2.weight/bias
//    upsampler.0.weight/bias                              (Conv2d, spatial_x2 only)
//    post_upsample_res_blocks.{0-3}.conv1/conv2/norm1/norm2.weight/bias
//    final_conv.weight/bias
//

import Foundation
import MLX
import MLXNN

/// PyTorch-compatible GroupNorm(32, channels) over a 5D (B, D, H, W, C)
/// tensor — normalizes over (D, H, W, channels-in-group) jointly per
/// (batch, group), matching AudioAttnBlock's proven 4D groupNorm extended
/// with the extra depth axis.
func groupNorm5D(_ x: MLXArray, weight: MLXArray, bias: MLXArray, numGroups: Int, eps: Float = 1e-5) -> MLXArray {
    let b = x.dim(0), d = x.dim(1), h = x.dim(2), w = x.dim(3), c = x.dim(4)
    let cg = c / numGroups
    var xr = x.asType(.float32).reshaped([b, d, h, w, numGroups, cg])
    xr = xr.transposed(0, 4, 1, 2, 3, 5).reshaped([b, numGroups, d * h * w * cg])
    let mean = xr.mean(axis: -1, keepDims: true)
    let variance = ((xr - mean) * (xr - mean)).mean(axis: -1, keepDims: true)
    var normed = (xr - mean) / MLX.sqrt(variance + eps)
    normed = normed.reshaped([b, numGroups, d, h, w, cg]).transposed(0, 2, 3, 4, 1, 5).reshaped([b, d, h, w, c])
    let weightR = weight.asType(.float32).reshaped([1, 1, 1, 1, c])
    let biasR = bias.asType(.float32).reshaped([1, 1, 1, 1, c])
    return normed * weightR + biasR
}

/// 2D pixel shuffle in BHWC layout: (B, H, W, C*factor*factor) -> (B,
/// H*factor, W*factor, C). Matches PyTorch's `rearrange(x, "b (c p1 p2) h w
/// -> b c (h p1) (w p2)")` — channel is outermost (varies slowest).
func pixelShuffle2D(_ x: MLXArray, factor: Int) -> MLXArray {
    let b = x.dim(0), h = x.dim(1), w = x.dim(2), cTotal = x.dim(3)
    let c = cTotal / (factor * factor)
    var xr = x.reshaped([b, h, w, c, factor, factor])
    xr = xr.transposed(0, 1, 4, 2, 5, 3)
    return xr.reshaped([b, h * factor, w * factor, c])
}

/// Residual block: conv1 -> norm1 -> SiLU -> conv2 -> norm2 -> SiLU(x +
/// residual). Conv3d with kernel_size=3, stride=1, zero-padding=1 (NOT the
/// causal/replicate-padding Conv3dBlock the VAE uses — LatentUpsampler's
/// reference is a plain `nn.Conv3d(..., padding=1)`).
struct UpsamplerResBlock {
    let conv1Weight: MLXArray, conv1Bias: MLXArray
    let conv2Weight: MLXArray, conv2Bias: MLXArray
    let norm1Weight: MLXArray, norm1Bias: MLXArray
    let norm2Weight: MLXArray, norm2Bias: MLXArray
    let numGroups: Int

    /// x: (B, D, H, W, C).
    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let residual = x
        var h = MLX.conv3d(x, conv1Weight, stride: 1, padding: 1) + conv1Bias
        h = groupNorm5D(h, weight: norm1Weight, bias: norm1Bias, numGroups: numGroups)
        h = MLXNN.silu(h)
        h = MLX.conv3d(h, conv2Weight, stride: 1, padding: 1) + conv2Bias
        h = groupNorm5D(h, weight: norm2Weight, bias: norm2Bias, numGroups: numGroups)
        return MLXNN.silu(h + residual)
    }
}

/// Native port of LatentUpsampler (spatial_x2 variant only — see this
/// file's header). Input/output: (B, C=128, F, H, W) BCFHW, same latent
/// layout VideoEncoder/VideoDecoder already use.
public struct LatentUpsampler {
    let initialConvWeight: MLXArray, initialConvBias: MLXArray
    let initialNormWeight: MLXArray, initialNormBias: MLXArray
    let resBlocks: [UpsamplerResBlock]
    let upsamplerConvWeight: MLXArray, upsamplerConvBias: MLXArray
    let postUpsampleResBlocks: [UpsamplerResBlock]
    let finalConvWeight: MLXArray, finalConvBias: MLXArray
    let numGroups: Int

    public init(weights: [String: MLXArray], numBlocksPerStage: Int = 4, numGroups: Int = 32) {
        func w(_ key: String) -> MLXArray { weights[key]!.asType(.float32) }

        self.initialConvWeight = w("initial_conv.weight")
        self.initialConvBias = w("initial_conv.bias")
        self.initialNormWeight = w("initial_norm.weight")
        self.initialNormBias = w("initial_norm.bias")

        func loadResBlocks(prefix: String) -> [UpsamplerResBlock] {
            (0..<numBlocksPerStage).map { i in
                UpsamplerResBlock(
                    conv1Weight: w("\(prefix).\(i).conv1.weight"), conv1Bias: w("\(prefix).\(i).conv1.bias"),
                    conv2Weight: w("\(prefix).\(i).conv2.weight"), conv2Bias: w("\(prefix).\(i).conv2.bias"),
                    norm1Weight: w("\(prefix).\(i).norm1.weight"), norm1Bias: w("\(prefix).\(i).norm1.bias"),
                    norm2Weight: w("\(prefix).\(i).norm2.weight"), norm2Bias: w("\(prefix).\(i).norm2.bias"),
                    numGroups: numGroups)
            }
        }
        self.resBlocks = loadResBlocks(prefix: "res_blocks")
        self.postUpsampleResBlocks = loadResBlocks(prefix: "post_upsample_res_blocks")

        self.upsamplerConvWeight = w("upsampler.0.weight")
        self.upsamplerConvBias = w("upsampler.0.bias")

        self.finalConvWeight = w("final_conv.weight")
        self.finalConvBias = w("final_conv.bias")
        self.numGroups = numGroups
    }

    /// latent: (B, C, F, H, W) BCFHW. Returns (B, C, F, 2H, 2W) BCFHW.
    public func callAsFunction(_ latent: MLXArray) -> MLXArray {
        // BCFHW -> BFHWC (MLX conv layout).
        var x = latent.transposed(0, 2, 3, 4, 1)

        x = MLX.conv3d(x, initialConvWeight, stride: 1, padding: 1) + initialConvBias
        x = groupNorm5D(x, weight: initialNormWeight, bias: initialNormBias, numGroups: numGroups)
        x = MLXNN.silu(x)

        for block in resBlocks {
            x = block(x)
        }

        // Spatial upsampler: Conv2d per-frame + PixelShuffle2D(2).
        let b = x.dim(0), d = x.dim(1), h = x.dim(2), wDim = x.dim(3), c = x.dim(4)
        var frames = x.reshaped([b * d, h, wDim, c])
        frames = MLX.conv2d(frames, upsamplerConvWeight, stride: 1, padding: 1) + upsamplerConvBias
        frames = pixelShuffle2D(frames, factor: 2)
        let h2 = frames.dim(1), w2 = frames.dim(2), c2 = frames.dim(3)
        x = frames.reshaped([b, d, h2, w2, c2])

        for block in postUpsampleResBlocks {
            x = block(x)
        }

        x = MLX.conv3d(x, finalConvWeight, stride: 1, padding: 1) + finalConvBias

        // BFHWC -> BCFHW.
        return x.transposed(0, 4, 1, 2, 3)
    }
}
