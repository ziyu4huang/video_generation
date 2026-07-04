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
//    - spatial_x2 (Conv2d + PixelShuffle2D(2), checkpoint at
//      mlx-models/vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors) AND
//      spatial_x1_5 (rational resampler — Conv2d + PixelShuffle2D(3) +
//      BlurDownsample(stride=2), checkpoint at
//      mlx-models/vae/ltx-2.3-vae/spatial_upscaler_x1_5_v1_0.safetensors,
//      config confirms rational_resampler=true/spatial_scale=1.5). Both are
//      real ComfyUI-reference upscale stages (Stage #2 uses x2, Stage #3 of
//      the 3-stage FFLF workflow uses x1_5 — see docs/reference/
//      comfyui_workflows/README.md's second pass).
//    - temporal_x2 (PixelShuffle3D) is NOT ported — the reference workflows
//      this package targets never select it; see model.py's
//      `_pixel_shuffle_3d` for what a future port would need.
//
//  Weight key structure (verified against the real checkpoints via
//  scripts/dump_latent_upsampler_reference.py):
//    initial_conv.weight/bias, initial_norm.weight/bias
//    res_blocks.{0-3}.conv1/conv2/norm1/norm2.weight/bias
//    upsampler.0.weight/bias                              (Conv2d, spatial_x2)
//    upsampler.conv.weight/bias, upsampler.blur_down.kernel (spatial_x1_5 —
//      the blur kernel is a REAL checkpoint tensor, not derived on load —
//      confirmed via direct safetensors header inspection: shape (1,5,5,1)
//      BF16 — so it's loaded like any other weight, not recomputed from the
//      binomial-coefficient formula the Python reference falls back to only
//      when the checkpoint omits it)
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

/// Depthwise blur-then-downsample on a BHWC tensor — direct port of
/// model.py's `_blur_downsample`: each channel is convolved independently
/// with the SAME (1, K, K, 1) kernel by folding channels into the batch
/// axis (not MLX's `groups:` conv parameter — matches the reference's own
/// reshape-based implementation exactly, not just its numerical result).
func blurDownsample2D(_ x: MLXArray, kernel: MLXArray, stride: Int) -> MLXArray {
    if stride == 1 { return x }
    let b = x.dim(0), h = x.dim(1), w = x.dim(2), c = x.dim(3)
    let k = kernel.dim(1)
    let pad = k / 2
    var xr = x.transposed(0, 3, 1, 2).reshaped([b * c, h, w, 1])
    xr = MLX.padded(xr, widths: [
        IntOrPair([0, 0]), IntOrPair([pad, pad]), IntOrPair([pad, pad]), IntOrPair([0, 0]),
    ])
    xr = MLX.conv2d(xr, kernel, stride: IntOrPair((stride, stride)))
    let h2 = xr.dim(1), w2 = xr.dim(2)
    xr = xr.reshaped([b, c, h2, w2])
    return xr.transposed(0, 2, 3, 1)
}

/// Rational spatial resampler (spatial_x1_5): Conv2d -> PixelShuffle2D(3) ->
/// BlurDownsample(stride=2) — net 3x upsample then 2x downsample = 1.5x.
/// Direct port of model.py's `SpatialRationalResampler`.
struct SpatialRationalResampler {
    let convWeight: MLXArray, convBias: MLXArray
    let blurKernel: MLXArray
    let num: Int, den: Int

    /// x: (B, D, H, W, C) BDHWC — applied per-frame, matching the reference.
    func callAsFunction(_ x: MLXArray) -> MLXArray {
        let b = x.dim(0), d = x.dim(1), h = x.dim(2), w = x.dim(3), c = x.dim(4)
        var frames = x.reshaped([b * d, h, w, c])
        frames = MLX.conv2d(frames, convWeight, stride: 1, padding: 1) + convBias
        frames = pixelShuffle2D(frames, factor: num)
        frames = blurDownsample2D(frames, kernel: blurKernel, stride: den)
        let h2 = frames.dim(1), w2 = frames.dim(2), c2 = frames.dim(3)
        return frames.reshaped([b, d, h2, w2, c2])
    }
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

/// Native port of LatentUpsampler — supports the spatial_x2 and spatial_x1_5
/// variants (see this file's header). Input/output: (B, C=128, F, H, W)
/// BCFHW, same latent layout VideoEncoder/VideoDecoder already use.
public struct LatentUpsampler {
    /// Which real checkpoint's upsampler sub-module shape this instance was
    /// loaded from — determines which weights `_apply_upsampler` reads and
    /// how, mirroring model.py's `_upsampler_type` dispatch.
    public enum Variant {
        case spatialX2
        case spatialX1_5
    }

    let initialConvWeight: MLXArray, initialConvBias: MLXArray
    let initialNormWeight: MLXArray, initialNormBias: MLXArray
    let resBlocks: [UpsamplerResBlock]
    let variant: Variant
    // spatial_x2 only:
    let upsamplerConvWeight: MLXArray?, upsamplerConvBias: MLXArray?
    // spatial_x1_5 only:
    let rationalResampler: SpatialRationalResampler?
    let postUpsampleResBlocks: [UpsamplerResBlock]
    let finalConvWeight: MLXArray, finalConvBias: MLXArray
    let numGroups: Int

    public init(
        weights: [String: MLXArray], variant: Variant = .spatialX2,
        numBlocksPerStage: Int = 4, numGroups: Int = 32
    ) {
        func w(_ key: String) -> MLXArray { weights[key]!.asType(.float32) }

        self.variant = variant
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

        switch variant {
        case .spatialX2:
            self.upsamplerConvWeight = w("upsampler.0.weight")
            self.upsamplerConvBias = w("upsampler.0.bias")
            self.rationalResampler = nil
        case .spatialX1_5:
            self.upsamplerConvWeight = nil
            self.upsamplerConvBias = nil
            self.rationalResampler = SpatialRationalResampler(
                convWeight: w("upsampler.conv.weight"), convBias: w("upsampler.conv.bias"),
                blurKernel: w("upsampler.blur_down.kernel"), num: 3, den: 2)
        }

        self.finalConvWeight = w("final_conv.weight")
        self.finalConvBias = w("final_conv.bias")
        self.numGroups = numGroups
    }

    /// latent: (B, C, F, H, W) BCFHW. Returns the spatially-upscaled latent
    /// in the same layout (2x for `.spatialX2`, 1.5x for `.spatialX1_5`).
    public func callAsFunction(_ latent: MLXArray) -> MLXArray {
        // BCFHW -> BFHWC (MLX conv layout).
        var x = latent.transposed(0, 2, 3, 4, 1)

        x = MLX.conv3d(x, initialConvWeight, stride: 1, padding: 1) + initialConvBias
        x = groupNorm5D(x, weight: initialNormWeight, bias: initialNormBias, numGroups: numGroups)
        x = MLXNN.silu(x)

        for block in resBlocks {
            x = block(x)
        }

        switch variant {
        case .spatialX2:
            // Conv2d per-frame + PixelShuffle2D(2).
            let b = x.dim(0), d = x.dim(1), h = x.dim(2), wDim = x.dim(3), c = x.dim(4)
            var frames = x.reshaped([b * d, h, wDim, c])
            frames = MLX.conv2d(frames, upsamplerConvWeight!, stride: 1, padding: 1) + upsamplerConvBias!
            frames = pixelShuffle2D(frames, factor: 2)
            let h2 = frames.dim(1), w2 = frames.dim(2), c2 = frames.dim(3)
            x = frames.reshaped([b, d, h2, w2, c2])
        case .spatialX1_5:
            x = rationalResampler!(x)
        }

        for block in postUpsampleResBlocks {
            x = block(x)
        }

        x = MLX.conv3d(x, finalConvWeight, stride: 1, padding: 1) + finalConvBias

        // BFHWC -> BCFHW.
        return x.transposed(0, 4, 1, 2, 3)
    }
}
