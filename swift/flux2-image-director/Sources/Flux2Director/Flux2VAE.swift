//
//  Flux2VAE.swift
//  Flux2Director
//
//  Phase 2.1: Flux2 Klein VAE (AutoencoderKLFlux2). Port of mflux's
//  flux2_vae.{encoder,decoder,vae}. Structurally the same diffusers
//  AutoencoderKL as Z-Image's ultraflux VAE (shared primitives live in
//  CommonImageDirector.VAEPrimitives), but with Flux2-specific wiring:
//
//    - latent_channels = 32 (Z-Image = 16)
//    - scaling_factor = 1.0, shift_factor = 0.0 (no-ops; Z-Image = 0.3611/0.1159)
//    - quant_conv (64→64, 1×1) on the encode path after conv_out
//    - post_quant_conv (32→32, 1×1) on the decode path before conv_in
//    - mid-block attention to_q/k/v/out are 8-bit quantized (U32 + scales/biases)
//    - bn (BatchNormStats, 128 features) denormalizes the transformer's
//      128-ch packed latents in the T2I decode_packed_latents path
//
//  Weight keys use diffusers standard naming (no `.conv` suffix):
//    decoder.conv_in.weight, encoder.down_blocks.0.resnets.0.norm1.weight, ...
//  The only `.0`-suffixed submodule is NOT present: attention to_out is a
//  single Linear (key `to_out.weight`, not `to_out.0.weight`).
//

import Foundation
import MLX
import MLXNN
import MLXFast
import CommonImageDirector

// MARK: - Quantized attention loader

/// Build a QuantizedLinear from pre-quantized safetensors tensors.
/// Flux2's mid-block attention linears are 8-bit quantized (group_size=64):
///   weight  : U32 [out, packed]   (packed = in / (32/bits) = in/4 for bits=8)
///   scales  : BF16 [out, groups]
///   biases  : BF16 [out, groups]
///   bias    : BF16 [out]   (regular Linear bias)
private func quantLinear(_ weights: [String: MLXArray], _ key: String) -> QuantizedLinear {
    QuantizedLinear(
        weight: weights["\(key).weight"]!,
        bias: weights["\(key).bias"],
        scales: weights["\(key).scales"]!,
        biases: weights["\(key).biases"]!,
        groupSize: 64,
        bits: 8
    )
}

// MARK: - BatchNorm stats (T2I packed-latent denorm)

/// Holds BatchNorm running statistics for decode_packed_latents.
/// Not a learned-norm module — just a parameter container. eps matches config
/// (batch_norm_eps=1e-4). Used to invert the transformer's output norm:
///   latent = packed * sqrt(var + eps) + mean
public struct Flux2BatchNormStats {
    public let runningMean: MLXArray   // [128]
    public let runningVar: MLXArray    // [128]
    public let eps: Float              // 1e-4

    public init(runningMean: MLXArray, runningVar: MLXArray, eps: Float = 1e-4) {
        self.runningMean = runningMean
        self.runningVar = runningVar
        self.eps = eps
    }
}

// MARK: - Decoder

/// Flux2 VAE decoder. Port of mflux flux2_vae.decoder.Decoder + post_quant_conv.
///
/// Decode path (standard, 32-ch latents in):
///   latents (1,32,h,w)
///     → (latents / 1.0) + 0.0          [scaling/shift no-ops]
///     → post_quant_conv (32→32, 1×1)
///     → conv_in (32→512, 3×3)
///     → mid_block (512: resnet, attn, resnet)
///     → up_blocks ×4 (512→512→512→256→128, 3 resnets each, upsample on first 3)
///     → conv_norm_out (128, GroupNorm)
///     → SiLU
///     → conv_out (128→3, 3×3)          → pixels (1,3,H,W) in [-1,1]
public final class Flux2VAEDecoder: Module {

    let postQuantConv: LoadedConv2d      // 32→32, 1×1
    let convIn: LoadedConv2d             // 32→512, 3×3
    let midBlock: VAEMidBlock            // 512
    let upBlocks: [VAEUpDecoderBlock]    // 4 blocks
    let convNormOut: LoadedGroupNorm     // 128ch
    let convOut: LoadedConv2d            // 128→3, 3×3

    public init(weights: [String: MLXArray]) {
        // Direct key lookup (diffusers naming, no prefix shift).
        func conv(_ path: String, padding: Int, stride: Int = 1) -> LoadedConv2d {
            LoadedConv2d(weight: weights["\(path).weight"]!,
                         bias: weights["\(path).bias"], stride: stride, padding: padding)
        }
        func norm(_ path: String) -> LoadedGroupNorm {
            LoadedGroupNorm(weight: weights["\(path).weight"]!,
                            bias: weights["\(path).bias"]!)
        }
        func resnet(_ path: String) -> VAEResnetBlock2D {
            let shortcutConv: LoadedConv2d? = weights["\(path).conv_shortcut.weight"].map { _ in
                conv("\(path).conv_shortcut", padding: 0)
            }
            return VAEResnetBlock2D(
                norm1: norm("\(path).norm1"), conv1: conv("\(path).conv1", padding: 1),
                norm2: norm("\(path).norm2"), conv2: conv("\(path).conv2", padding: 1),
                convShortcut: shortcutConv
            )
        }

        self.postQuantConv = conv("post_quant_conv", padding: 0)
        self.convIn = conv("decoder.conv_in", padding: 1)
        self.midBlock = VAEMidBlock(
            resnet1: resnet("decoder.mid_block.resnets.0"),
            attention: VAEAttention(
                groupNorm: norm("decoder.mid_block.attentions.0.group_norm"),
                toq: quantLinear(weights, "decoder.mid_block.attentions.0.to_q"),
                tok: quantLinear(weights, "decoder.mid_block.attentions.0.to_k"),
                tov: quantLinear(weights, "decoder.mid_block.attentions.0.to_v"),
                too: quantLinear(weights, "decoder.mid_block.attentions.0.to_out")
            ),
            resnet2: resnet("decoder.mid_block.resnets.1")
        )

        // 4 up blocks: reversed(block_out_channels) = [512, 512, 256, 128].
        //   block 0: 512→512, up
        //   block 1: 512→512, up
        //   block 2: 512→256, up   (conv_shortcut on resnets.0)
        //   block 3: 256→128, no up (conv_shortcut on resnets.0)
        let upHasUpsample: [Bool] = [true, true, true, false]
        self.upBlocks = (0..<4).map { blockIdx in
            VAEUpDecoderBlock(
                resnets: (0..<3).map { layerIdx in
                    resnet("decoder.up_blocks.\(blockIdx).resnets.\(layerIdx)")
                },
                upsamplers: upHasUpsample[blockIdx]
                    ? [VAEUpSampler(conv: conv("decoder.up_blocks.\(blockIdx).upsamplers.0.conv", padding: 1))]
                    : nil
            )
        }

        self.convNormOut = norm("decoder.conv_norm_out")
        self.convOut = conv("decoder.conv_out", padding: 1)
        super.init()
    }

    /// NCHW→NHWC→conv→NCHW wrapper (matches mflux ConvIn/ConvOut transposes).
    private func convNCHW(_ input: MLXArray, _ layer: LoadedConv2d) -> MLXArray {
        let hidden = input.transposed(0, 2, 3, 1)
        return layer(hidden).transposed(0, 3, 1, 2)
    }

    /// Decode 32-ch latents (1,32,h,w) → pixels (1,3,H,W) in [-1,1].
    /// scaling/shift are no-ops (1.0/0.0) for Flux2.
    public func callAsFunction(_ latents: MLXArray) -> MLXArray {
        var hidden = convNCHW(latents, postQuantConv)   // post_quant_conv (1×1)
        hidden = convNCHW(hidden, convIn)               // conv_in (3×3)
        hidden = midBlock(hidden)
        for upBlock in upBlocks { hidden = upBlock(hidden) }
        // conv_norm_out: GroupNorm upcast to float32 (matches mflux ConvNormOut).
        hidden = hidden.transposed(0, 2, 3, 1).asType(.float32)
        hidden = convNormOut(hidden).asType(hidden.dtype).transposed(0, 3, 1, 2)
        hidden = MLXNN.silu(hidden)
        hidden = convNCHW(hidden, convOut)              // conv_out (3×3)
        return hidden
    }

    /// Decode packed transformer latents (1,128,h,w) → pixels (1,3,2h,2w).
    /// Path: bn denorm → unpatchify (128→32, 2× spatial) → standard decode.
    /// This is the T2I generation path (transformer outputs packed latents).
    public func decodePackedLatents(_ packed: MLXArray, bn: Flux2BatchNormStats) -> MLXArray {
        // bn denormalize: latent = packed * sqrt(var + eps) + mean
        // broadcasting over (1, 128, h, w): reshape stats to (1,128,1,1)
        let mean = bn.runningMean.reshaped([1, -1, 1, 1]).asType(packed.dtype)
        let std = MLX.sqrt(bn.runningVar.reshaped([1, -1, 1, 1]).asType(.float32) + bn.eps).asType(packed.dtype)
        var latents = packed * std + mean
        // unpatchify: (1,128,h,w) → (1,32,2h,2w)
        latents = Self.unpatchify(latents)
        return self(latents)
    }

    /// Unpatchify packed latents: (1, C, h, w) with C=4*latent_ch → (1, C/4, 2h, 2w).
    /// Port of Flux2VAE._unpatchify_latents:
    ///   reshape (1, C/4, 2, 2, h, w) → transpose (0,1,4,2,5,3) → reshape (1, C/4, 2h, 2w)
    public static func unpatchify(_ latents: MLXArray) -> MLXArray {
        let batchSize = latents.dim(0)
        let numChannels = latents.dim(1)
        let height = latents.dim(2)
        let width = latents.dim(3)
        var x = latents.reshaped([batchSize, numChannels / 4, 2, 2, height, width])
        x = x.transposed(0, 1, 4, 2, 5, 3)
        return x.reshaped([batchSize, numChannels / 4, height * 2, width * 2])
    }
}

// MARK: - Encoder

/// Flux2 VAE encoder. Port of mflux flux2_vae.encoder.Encoder + quant_conv.
///
/// Encode path (image → 32-ch latent):
///   image (1,3,H,W) in [-1,1]
///     → conv_in (3→128, 3×3)
///     → down_blocks ×4 (128→128→256→512→512, 2 resnets each, downsample on first 3)
///     → mid_block (512: resnet, attn, resnet)
///     → conv_norm_out (512, GroupNorm) → SiLU → conv_out (512→64, 3×3)
///     → quant_conv (64→64, 1×1) → split → mean (32ch)
///     → (mean - 0.0) * 1.0 = mean    [scaling/shift no-ops]
public final class Flux2VAEEncoder: Module {

    let convIn: LoadedConv2d               // 3→128, 3×3
    let downBlocks: [VAEDownEncoderBlock]  // 4 blocks
    let midBlock: VAEMidBlock              // 512
    let convNormOut: LoadedGroupNorm       // 512ch
    let convOut: LoadedConv2d              // 512→64, 3×3
    let quantConv: LoadedConv2d            // 64→64, 1×1

    public init(weights: [String: MLXArray]) {
        func conv(_ path: String, padding: Int, stride: Int = 1) -> LoadedConv2d {
            LoadedConv2d(weight: weights["\(path).weight"]!,
                         bias: weights["\(path).bias"], stride: stride, padding: padding)
        }
        func norm(_ path: String) -> LoadedGroupNorm {
            LoadedGroupNorm(weight: weights["\(path).weight"]!,
                            bias: weights["\(path).bias"]!)
        }
        func resnet(_ path: String) -> VAEResnetBlock2D {
            let shortcutConv: LoadedConv2d? = weights["\(path).conv_shortcut.weight"].map { _ in
                conv("\(path).conv_shortcut", padding: 0)
            }
            return VAEResnetBlock2D(
                norm1: norm("\(path).norm1"), conv1: conv("\(path).conv1", padding: 1),
                norm2: norm("\(path).norm2"), conv2: conv("\(path).conv2", padding: 1),
                convShortcut: shortcutConv
            )
        }

        self.convIn = conv("encoder.conv_in", padding: 1)
        // 4 down blocks: block_out_channels = [128, 256, 512, 512].
        //   block 0: 128→128, down   (no shortcut)
        //   block 1: 128→256, down   (shortcut on resnets.0)
        //   block 2: 256→512, down   (shortcut on resnets.0)
        //   block 3: 512→512, no down (final block)
        let downHasDownsample: [Bool] = [true, true, true, false]
        self.downBlocks = (0..<4).map { blockIdx in
            VAEDownEncoderBlock(
                resnets: (0..<2).map { layerIdx in
                    resnet("encoder.down_blocks.\(blockIdx).resnets.\(layerIdx)")
                },
                downsamplers: downHasDownsample[blockIdx]
                    ? [VAEDownSampler(conv: conv("encoder.down_blocks.\(blockIdx).downsamplers.0.conv", padding: 0, stride: 2))]
                    : nil
            )
        }
        self.midBlock = VAEMidBlock(
            resnet1: resnet("encoder.mid_block.resnets.0"),
            attention: VAEAttention(
                groupNorm: norm("encoder.mid_block.attentions.0.group_norm"),
                toq: quantLinear(weights, "encoder.mid_block.attentions.0.to_q"),
                tok: quantLinear(weights, "encoder.mid_block.attentions.0.to_k"),
                tov: quantLinear(weights, "encoder.mid_block.attentions.0.to_v"),
                too: quantLinear(weights, "encoder.mid_block.attentions.0.to_out")
            ),
            resnet2: resnet("encoder.mid_block.resnets.1")
        )
        self.convNormOut = norm("encoder.conv_norm_out")
        self.convOut = conv("encoder.conv_out", padding: 1)
        self.quantConv = conv("quant_conv", padding: 0)
        super.init()
    }

    private func convNCHW(_ input: MLXArray, _ layer: LoadedConv2d) -> MLXArray {
        let hidden = input.transposed(0, 2, 3, 1)
        return layer(hidden).transposed(0, 3, 1, 2)
    }

    /// Encode image (1,3,H,W) in [-1,1] → latent (1,32,H/8,W/8).
    /// scaling/shift are no-ops (1.0/0.0) for Flux2.
    public func callAsFunction(_ image: MLXArray) -> MLXArray {
        var hidden = convNCHW(image, convIn)
        for downBlock in downBlocks { hidden = downBlock(hidden) }
        hidden = midBlock(hidden)
        hidden = hidden.transposed(0, 2, 3, 1).asType(.float32)
        hidden = convNormOut(hidden).asType(hidden.dtype).transposed(0, 3, 1, 2)
        hidden = MLXNN.silu(hidden)
        hidden = convNCHW(hidden, convOut)        // → (1,64,H/8,W/8)
        hidden = convNCHW(hidden, quantConv)      // → (1,64,H/8,W/8)
        // split mean/logvar along channel axis, take mean
        let halves = MLX.split(hidden, parts: 2, axis: 1)
        let mean = halves[0]
        return mean   // (mean - 0.0) * 1.0 = mean
    }
}
