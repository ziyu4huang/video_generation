//
//  VAE.swift
//  ZImageDirector
//
//  Phase 4: Z-Image VAE decoder. Port of mflux's z_image_vae decoder tree.
//
//  Latent format: (1, 16, H/8, W/8) → pixel (1, 3, H, W).
//  Path: ConvIn(16→512) → UNetMidBlock(512, +attn) → 4× UpDecoderBlock →
//        ConvNormOut(128) → SiLU → ConvOut(128→3).
//
//  Convs operate in NHWC (mlx native). GroupNorm upcasts to float32 for
//  stability (matches mflux/PyTorch). Weights are bfloat16 (NOT quantized).
//

import Foundation
import MLX
import MLXNN
import MLXFast
import CommonImageDirector

// VAE building blocks (LoadedConv2d, LoadedGroupNorm, VAEResnetBlock2D,
// VAEAttention, VAEMidBlock, VAEUpSampler, VAEUpDecoderBlock, VAEDownSampler,
// VAEDownEncoderBlock) live in CommonImageDirector — they are generic
// diffusers-AutoencoderKL primitives shared with flux2-image-director.
// Only the Z-Image-specific assembly (weight-key layout, scaling/shift
// factors, channel wiring) is defined below.

// MARK: - Full decoder + weight builder

public final class ZImageVAEDecoder: Module {

    let convIn: LoadedConv2d
    let midBlock: VAEMidBlock
    let upBlocks: [VAEUpDecoderBlock]
    let convNormOut: LoadedGroupNorm
    let convOut: LoadedConv2d

    /// ConvIn wrapper: transposes NCHW→NHWC, conv, NHWC→NCHW (matches Python).
    func convInCall(_ input: MLXArray) -> MLXArray {
        let hidden = input.transposed(0, 2, 3, 1)   // NCHW → NHWC
        return convIn(hidden).transposed(0, 3, 1, 2)
    }

    /// ConvNormOut wrapper: NCHW in/out (Python transposes internally + upcasts to float32).
    func convNormOutApply(_ input: MLXArray) -> MLXArray {
        let hidden = input.transposed(0, 2, 3, 1).asType(.float32)  // NHWC, float32
        return convNormOut(hidden).asType(input.dtype).transposed(0, 3, 1, 2)
    }

    /// ConvOut wrapper: NCHW in/out.
    func convOutApply(_ input: MLXArray) -> MLXArray {
        let hidden = input.transposed(0, 2, 3, 1)
        return convOut(hidden).transposed(0, 3, 1, 2)
    }

    public init(weights: [String: MLXArray]) {
        // weightLookup("conv_in.conv.weight") → weights["decoder.conv_in.conv.weight"]
        func weightLookup(_ key: String) -> MLXArray { weights["decoder." + key]! }
        func conv(_ path: String, padding: Int) -> LoadedConv2d {
            LoadedConv2d(weight: weightLookup("\(path).weight"),
                         bias: weightLookup("\(path).bias"), padding: padding)
        }
        func norm(_ path: String) -> LoadedGroupNorm {
            LoadedGroupNorm(weight: weightLookup("\(path).weight"),
                            bias: weightLookup("\(path).bias"))
        }
        func lin(_ path: String) -> Linear {
            Linear(weight: weightLookup("\(path).weight"), bias: weightLookup("\(path).bias"))
        }

        func resnet(_ path: String) -> VAEResnetBlock2D {
            let shortcutConv: LoadedConv2d? = weights["decoder.\(path).conv_shortcut.weight"].map { _ in
                conv("\(path).conv_shortcut", padding: 0)
            }
            return VAEResnetBlock2D(
                norm1: norm("\(path).norm1"), conv1: conv("\(path).conv1", padding: 1),
                norm2: norm("\(path).norm2"), conv2: conv("\(path).conv2", padding: 1),
                convShortcut: shortcutConv
            )
        }

        self.convIn = conv("conv_in.conv", padding: 1)
        self.midBlock = VAEMidBlock(
            resnet1: resnet("mid_block.resnets.0"),
            attention: VAEAttention(
                groupNorm: norm("mid_block.attentions.0.group_norm"),
                toq: lin("mid_block.attentions.0.to_q"),
                tok: lin("mid_block.attentions.0.to_k"),
                tov: lin("mid_block.attentions.0.to_v"),
                too: lin("mid_block.attentions.0.to_out.0")
            ),
            resnet2: resnet("mid_block.resnets.1")
        )

        // 4 up blocks: (512→512,up), (512→512,up), (512→256,up), (256→128,no up).
        let upConfigs: [Bool] = [true, true, true, false]
        self.upBlocks = upConfigs.enumerated().map { (blockIdx, addUp) in
            VAEUpDecoderBlock(
                resnets: (0..<3).map { layerIdx in resnet("up_blocks.\(blockIdx).resnets.\(layerIdx)") },
                upsamplers: addUp
                    ? [VAEUpSampler(conv: conv("up_blocks.\(blockIdx).upsamplers.0.conv", padding: 1))]
                    : nil
            )
        }

        self.convNormOut = norm("conv_norm_out.norm")
        self.convOut = conv("conv_out.conv", padding: 1)
        super.init()
    }

    /// Decode latents (1, 16, H/8, W/8) → pixels (1, 3, H, W).
    /// Matches VAE.decode: latents are first de-scaled ((latents/0.3611)+0.1159)
    /// before feeding the decoder.
    public func callAsFunction(_ latents: MLXArray) -> MLXArray {
        let scalingFactor: Float = 0.3611
        let shiftFactor: Float = 0.1159
        let scaledLatents = (latents / scalingFactor) + shiftFactor
        var hidden = convInCall(scaledLatents)
        hidden = midBlock(hidden)
        for upBlock in upBlocks { hidden = upBlock(hidden) }
        hidden = convNormOutApply(hidden)
        hidden = MLXNN.silu(hidden)
        hidden = convOutApply(hidden)
        return hidden
    }
}

// MARK: - VAE Encoder (i2i: image → latent)

/// Z-Image VAE encoder. Port of mflux z_image_vae.encoder.Encoder.
///
/// Path: ConvIn(3→128) → Down×3 (128→128→256→512, stride-2) →
///       Down×1 (512→512, no-down) → UNetMidBlock(512, +attn) →
///       GroupNorm → SiLU → ConvOut(512→32) → split mean → scale.
///
/// Weight-key note: encoder conv_in/conv_out use `.conv2d.{weight,bias}`
/// (decoder uses `.conv.`); resnets/downsamplers share the same `.conv1/`conv2`/
/// `.conv` naming as the decoder. Input pixels are in [-1, 1] (normalized).
public final class ZImageVAEEncoder: Module {

    let convIn: LoadedConv2d
    let downBlocks: [VAEDownEncoderBlock]
    let midBlock: VAEMidBlock
    let convNormOut: LoadedGroupNorm
    let convOut: LoadedConv2d

    /// Same NHWC-wrappers as the decoder.
    func convInCall(_ input: MLXArray) -> MLXArray {
        let hidden = input.transposed(0, 2, 3, 1)   // NCHW → NHWC
        return convIn(hidden).transposed(0, 3, 1, 2)
    }

    func convNormOutApply(_ input: MLXArray) -> MLXArray {
        let hidden = input.transposed(0, 2, 3, 1).asType(.float32)  // NHWC, float32
        return convNormOut(hidden).asType(input.dtype).transposed(0, 3, 1, 2)
    }

    func convOutApply(_ input: MLXArray) -> MLXArray {
        let hidden = input.transposed(0, 2, 3, 1)
        return convOut(hidden).transposed(0, 3, 1, 2)
    }

    /// Load from the same weights dict as the decoder (keys prefixed `encoder.`).
    /// NOTE: conv_in/conv_out use `.conv2d.` (not `.conv.`) in the encoder keys.
    public init(weights: [String: MLXArray]) {
        func weightLookup(_ key: String) -> MLXArray { weights["encoder." + key]! }
        func conv2d(_ path: String, padding: Int) -> LoadedConv2d {
            LoadedConv2d(weight: weightLookup("\(path).weight"),
                         bias: weightLookup("\(path).bias"), padding: padding)
        }
        func norm(_ path: String) -> LoadedGroupNorm {
            LoadedGroupNorm(weight: weightLookup("\(path).weight"),
                            bias: weightLookup("\(path).bias"))
        }
        func lin(_ path: String) -> Linear {
            Linear(weight: weightLookup("\(path).weight"), bias: weightLookup("\(path).bias"))
        }
        // Resnets in the encoder use the same .conv1/.conv2 key names as decoder.
        func conv(_ path: String, padding: Int, stride: Int = 1) -> LoadedConv2d {
            LoadedConv2d(weight: weightLookup("\(path).weight"),
                         bias: weightLookup("\(path).bias"), stride: stride, padding: padding)
        }
        func resnet(_ path: String) -> VAEResnetBlock2D {
            let shortcutConv: LoadedConv2d? = weights["encoder.\(path).conv_shortcut.weight"].map { _ in
                conv("\(path).conv_shortcut", padding: 0)
            }
            return VAEResnetBlock2D(
                norm1: norm("\(path).norm1"), conv1: conv("\(path).conv1", padding: 1),
                norm2: norm("\(path).norm2"), conv2: conv("\(path).conv2", padding: 1),
                convShortcut: shortcutConv
            )
        }

        // conv_in uses the `.conv2d` key suffix (encoder-specific).
        self.convIn = conv2d("conv_in.conv2d", padding: 1)

        // 4 down blocks: (128→128,down), (128→256,down), (256→512,down), (512→512,no down).
        // Each has 2 resnets; downsampler present on blocks 0-2 only.
        let downConfigs: [(out: Int, addDown: Bool)] = [
            (out: 128, addDown: true),
            (out: 256, addDown: true),
            (out: 512, addDown: true),
            (out: 512, addDown: false),
        ]
        self.downBlocks = downConfigs.enumerated().map { (blockIdx, cfg) in
            VAEDownEncoderBlock(
                resnets: (0..<2).map { layerIdx in resnet("down_blocks.\(blockIdx).resnets.\(layerIdx)") },
                downsamplers: cfg.addDown
                    ? [VAEDownSampler(conv: conv("down_blocks.\(blockIdx).downsamplers.0.conv", padding: 0, stride: 2))]
                    : nil
            )
        }

        self.midBlock = VAEMidBlock(
            resnet1: resnet("mid_block.resnets.0"),
            attention: VAEAttention(
                groupNorm: norm("mid_block.attentions.0.group_norm"),
                toq: lin("mid_block.attentions.0.to_q"),
                tok: lin("mid_block.attentions.0.to_k"),
                tov: lin("mid_block.attentions.0.to_v"),
                too: lin("mid_block.attentions.0.to_out.0")
            ),
            resnet2: resnet("mid_block.resnets.1")
        )

        self.convNormOut = norm("conv_norm_out.norm")
        // conv_out uses the `.conv2d` key suffix (encoder-specific).
        self.convOut = conv2d("conv_out.conv2d", padding: 1)
        super.init()
    }

    /// Encode pixels (1, 3, H, W) → raw 32-channel output, then take the mean
    /// half (first 16 channels) and apply the VAE shift/scale.
    /// Matches VAE.encode: latent = (mean - 0.1159) * 0.3611.
    /// Input pixels are expected normalized to [-1, 1].
    public func callAsFunction(_ pixels: MLXArray) -> MLXArray {
        var hidden = convInCall(pixels)
        for downBlock in downBlocks { hidden = downBlock(hidden) }
        hidden = midBlock(hidden)
        hidden = convNormOutApply(hidden)
        hidden = MLXNN.silu(hidden)
        hidden = convOutApply(hidden)   // (1, 32, H/8, W/8)
        // Split into (mean, logvar); take mean (first 16 channels).
        let mean = hidden[0..<1, 0..<16, 0..., 0...]
        let scalingFactor: Float = 0.3611
        let shiftFactor: Float = 0.1159
        return (mean - shiftFactor) * scalingFactor
    }
}
