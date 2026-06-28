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

// MARK: - Loaded primitives

/// Conv2d built from pre-loaded weight/bias. mlx-swift's Conv2d has no public
/// weight-injection init, so we call conv2d directly. Input/output NHWC.
final class LoadedConv2d: Module, UnaryLayer {
    let weight: MLXArray
    let bias: MLXArray?
    let stride: Int
    let padding: Int

    init(weight: MLXArray, bias: MLXArray?, stride: Int = 1, padding: Int = 0) {
        self.weight = weight
        self.bias = bias
        self.stride = stride
        self.padding = padding
        super.init()
    }

    func callAsFunction(_ input: MLXArray) -> MLXArray {
        var output = MLX.conv2d(input, weight, stride: IntOrPair(stride), padding: IntOrPair(padding))
        if let bias { output += bias }
        return output
    }
}

/// GroupNorm(32 groups, pytorch_compatible), eps=1e-6. Input: (..., C) in NHWC.
/// PyTorch GroupNorm normalizes over (groups, C/groups) jointly.
final class LoadedGroupNorm: Module, UnaryLayer {
    let weight: MLXArray
    let bias: MLXArray
    let numGroups: Int
    let eps: Float

    init(weight: MLXArray, bias: MLXArray, numGroups: Int = 32, eps: Float = 1e-6) {
        self.weight = weight
        self.bias = bias
        self.numGroups = numGroups
        self.eps = eps
        super.init()
    }

    func callAsFunction(_ input: MLXArray) -> MLXArray {
        // PyTorch GroupNorm (pytorch_compatible=True):
        // (B, ..., C) → (B, S, groups, C//groups) → transpose → (B, groups, S*groupSize)
        // → layerNorm over last axis → unreshape. Matches mlx-swift pytorchGroupNorm.
        let inputShape = input.shape
        let batchSize = inputShape[0]
        let channels = inputShape[inputShape.count - 1]
        let spatial = inputShape.dropFirst().dropLast()           // spatial dims
        let groupSize = channels / numGroups
        var normalized = input.reshaped([batchSize, -1, numGroups, groupSize])
        normalized = normalized.transposed(0, 2, 1, 3).reshaped([batchSize, numGroups, -1])
        normalized = MLXFast.layerNorm(normalized, weight: nil, bias: nil, eps: eps)
        normalized = normalized.reshaped([batchSize, numGroups, -1, groupSize])
        normalized = normalized.transposed(0, 2, 1, 3)
            .reshaped([batchSize] + Array(spatial) + [channels])
        return normalized * weight + bias
    }
}

// MARK: - VAE decoder blocks (init takes submodules)

final class VAEResnetBlock2D: Module {
    let norm1: LoadedGroupNorm
    let conv1: LoadedConv2d
    let norm2: LoadedGroupNorm
    let conv2: LoadedConv2d
    let convShortcut: LoadedConv2d?

    init(norm1: LoadedGroupNorm, conv1: LoadedConv2d,
         norm2: LoadedGroupNorm, conv2: LoadedConv2d,
         convShortcut: LoadedConv2d?) {
        self.norm1 = norm1; self.conv1 = conv1
        self.norm2 = norm2; self.conv2 = conv2
        self.convShortcut = convShortcut
        super.init()
    }

    func callAsFunction(_ inputArray: MLXArray) -> MLXArray {
        var hidden = inputArray.transposed(0, 2, 3, 1)   // NCHW → NHWC
        let original = hidden
        // GroupNorm in float32 for numerical stability (matches mflux pattern).
        hidden = norm1(hidden.asType(.float32)).asType(hidden.dtype)
        hidden = MLXNN.silu(hidden)
        hidden = conv1(hidden)
        hidden = norm2(hidden.asType(.float32)).asType(hidden.dtype)
        hidden = MLXNN.silu(hidden)
        hidden = conv2(hidden)
        let skip = convShortcut != nil ? convShortcut!(original) : original
        return (skip + hidden).transposed(0, 3, 1, 2)   // NHWC → NCHW
    }
}

final class VAEAttention: Module {
    let groupNorm: LoadedGroupNorm
    let toq: Linear
    let tok: Linear
    let tov: Linear
    let too: Linear

    init(groupNorm: LoadedGroupNorm, toq: Linear, tok: Linear, tov: Linear, too: Linear) {
        self.groupNorm = groupNorm
        self.toq = toq; self.tok = tok; self.tov = tov; self.too = too
        super.init()
    }

    func callAsFunction(_ inputArray: MLXArray) -> MLXArray {
        var hidden = inputArray.transposed(0, 2, 3, 1)
        let batchSize = hidden.dim(0)
        let height = hidden.dim(1)
        let width = hidden.dim(2)
        let channels = hidden.dim(3)
        let original = hidden
        hidden = groupNorm(hidden.asType(.float32)).asType(hidden.dtype)
        let tokens = batchSize * height * width
        let query = toq(hidden).reshaped([batchSize, tokens, 1, channels]).transposed(0, 2, 1, 3)
        let key = tok(hidden).reshaped([batchSize, tokens, 1, channels]).transposed(0, 2, 1, 3)
        let value = tov(hidden).reshaped([batchSize, tokens, 1, channels]).transposed(0, 2, 1, 3)
        let scale = 1.0 / Float(sqrt(Double(channels)))
        hidden = MLXFast.scaledDotProductAttention(queries: query, keys: key, values: value, scale: scale, mask: nil)
        hidden = hidden.transposed(0, 2, 1, 3).reshaped([batchSize, height, width, channels])
        hidden = too(hidden)
        return (original + hidden).transposed(0, 3, 1, 2)
    }
}

final class VAEMidBlock: Module {
    let resnet1: VAEResnetBlock2D
    let attention: VAEAttention
    let resnet2: VAEResnetBlock2D

    init(resnet1: VAEResnetBlock2D, attention: VAEAttention, resnet2: VAEResnetBlock2D) {
        self.resnet1 = resnet1; self.attention = attention; self.resnet2 = resnet2
        super.init()
    }

    func callAsFunction(_ hidden: MLXArray) -> MLXArray {
        resnet2(attention(resnet1(hidden)))
    }
}

/// Nearest-2x upsample then Conv2d 3x3.
final class VAEUpSampler: Module {
    let conv: LoadedConv2d
    let scale: Int

    init(conv: LoadedConv2d, scale: Int = 2) {
        self.conv = conv; self.scale = scale
        super.init()
    }

    func callAsFunction(_ inputArray: MLXArray) -> MLXArray {
        var hidden = inputArray.transposed(0, 2, 3, 1)
        let batchSize = hidden.dim(0)
        let height = hidden.dim(1)
        let width = hidden.dim(2)
        let channels = hidden.dim(3)
        // (B,H,1,W,1,C) → broadcast to (B,H,s,W,s,C) → reshape (B,H*s,W*s,C)
        hidden = hidden.expandedDimensions(axis: 2).expandedDimensions(axis: 4)
        hidden = MLX.broadcast(hidden, to: [batchSize, height, scale, width, scale, channels])
        hidden = hidden.reshaped([batchSize, height * scale, width * scale, channels])
        hidden = conv(hidden)
        return hidden.transposed(0, 3, 1, 2)
    }
}

final class VAEUpDecoderBlock: Module {
    let resnets: [VAEResnetBlock2D]
    let upsamplers: [VAEUpSampler]?

    init(resnets: [VAEResnetBlock2D], upsamplers: [VAEUpSampler]?) {
        self.resnets = resnets; self.upsamplers = upsamplers
        super.init()
    }

    func callAsFunction(_ hidden: MLXArray) -> MLXArray {
        var state = hidden
        for resnet in resnets { state = resnet(state) }
        if let ups = upsamplers { for upsampler in ups { state = upsampler(state) } }
        return state
    }
}

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
