//
//  VAEPrimitives.swift
//  CommonImageDirector
//
//  Generic diffusers-AutoencoderKL building blocks shared by both Z-Image's
//  ultraflux VAE and Flux2's klein VAE (both are the same AutoencoderKL family:
//  ResnetBlock2D + mid-block attention + up/down samplers). Model-specific
//  assembly (weight-key layout, scaling/shift factors, channel counts) lives
//  in each app's own VAE.swift.
//
//  Conventions (ported from mflux, verified in the ZImage port):
//    - Convs operate in NHWC (mlx native). Callers transpose NCHW→NHWC.
//    - GroupNorm upcasts to float32 for stability (matches PyTorch/mflux).
//    - Weights are bfloat16 (the VAE is NOT quantized, except Flux2's
//      mid-block attention which uses QuantizedLinear — see each app).
//

import Foundation
import MLX
import MLXNN
import MLXFast

// MARK: - Loaded primitives

/// Conv2d built from pre-loaded weight/bias. mlx-swift's Conv2d has no public
/// weight-injection init, so we call conv2d directly. Input/output NHWC.
public final class LoadedConv2d: Module, UnaryLayer {
    public let weight: MLXArray
    public let bias: MLXArray?
    public let stride: Int
    public let padding: Int

    public init(weight: MLXArray, bias: MLXArray?, stride: Int = 1, padding: Int = 0) {
        self.weight = weight
        self.bias = bias
        self.stride = stride
        self.padding = padding
        super.init()
    }

    public func callAsFunction(_ input: MLXArray) -> MLXArray {
        var output = MLX.conv2d(input, weight, stride: IntOrPair(stride), padding: IntOrPair(padding))
        if let bias { output += bias }
        return output
    }
}

/// GroupNorm(32 groups, pytorch_compatible), eps=1e-6. Input: (..., C) in NHWC.
/// PyTorch GroupNorm normalizes over (groups, C/groups) jointly.
public final class LoadedGroupNorm: Module, UnaryLayer {
    public let weight: MLXArray
    public let bias: MLXArray
    public let numGroups: Int
    public let eps: Float

    public init(weight: MLXArray, bias: MLXArray, numGroups: Int = 32, eps: Float = 1e-6) {
        self.weight = weight
        self.bias = bias
        self.numGroups = numGroups
        self.eps = eps
        super.init()
    }

    public func callAsFunction(_ input: MLXArray) -> MLXArray {
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

// MARK: - VAE blocks

/// ResnetBlock2D: GroupNorm→SiLU→Conv → GroupNorm→SiLU→Conv + shortcut.
/// Input/output NCHW (transposes to NHWC internally).
public final class VAEResnetBlock2D: Module {
    public let norm1: LoadedGroupNorm
    public let conv1: LoadedConv2d
    public let norm2: LoadedGroupNorm
    public let conv2: LoadedConv2d
    public let convShortcut: LoadedConv2d?

    public init(norm1: LoadedGroupNorm, conv1: LoadedConv2d,
                norm2: LoadedGroupNorm, conv2: LoadedConv2d,
                convShortcut: LoadedConv2d?) {
        self.norm1 = norm1; self.conv1 = conv1
        self.norm2 = norm2; self.conv2 = conv2
        self.convShortcut = convShortcut
        super.init()
    }

    public func callAsFunction(_ inputArray: MLXArray) -> MLXArray {
        var hidden = inputArray.transposed(0, 2, 3, 1)   // NCHW → NHWC
        let original = hidden
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

/// Single-head spatial self-attention (mid-block). Input/output NCHW.
/// `toq/tok/tov/too` are UnaryLayer (caller picks bf16 Linear or
/// QuantizedLinear — Flux2's mid-block attention is quantized).
public final class VAEAttention: Module {
    public let groupNorm: LoadedGroupNorm
    public let toq: any UnaryLayer
    public let tok: any UnaryLayer
    public let tov: any UnaryLayer
    public let too: any UnaryLayer

    public init(groupNorm: LoadedGroupNorm, toq: any UnaryLayer, tok: any UnaryLayer, tov: any UnaryLayer, too: any UnaryLayer) {
        self.groupNorm = groupNorm
        self.toq = toq; self.tok = tok; self.tov = tov; self.too = too
        super.init()
    }

    public func callAsFunction(_ inputArray: MLXArray) -> MLXArray {
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

/// Mid block: Resnet → Attention → Resnet. Input/output NCHW.
public final class VAEMidBlock: Module {
    public let resnet1: VAEResnetBlock2D
    public let attention: VAEAttention
    public let resnet2: VAEResnetBlock2D

    public init(resnet1: VAEResnetBlock2D, attention: VAEAttention, resnet2: VAEResnetBlock2D) {
        self.resnet1 = resnet1; self.attention = attention; self.resnet2 = resnet2
        super.init()
    }

    public func callAsFunction(_ hidden: MLXArray) -> MLXArray {
        resnet2(attention(resnet1(hidden)))
    }
}

/// Nearest-2x upsample then Conv2d 3x3. Input/output NCHW.
public final class VAEUpSampler: Module {
    public let conv: LoadedConv2d
    public let scale: Int

    public init(conv: LoadedConv2d, scale: Int = 2) {
        self.conv = conv; self.scale = scale
        super.init()
    }

    public func callAsFunction(_ inputArray: MLXArray) -> MLXArray {
        var hidden = inputArray.transposed(0, 2, 3, 1)
        let batchSize = hidden.dim(0)
        let height = hidden.dim(1)
        let width = hidden.dim(2)
        let channels = hidden.dim(3)
        hidden = hidden.expandedDimensions(axis: 2).expandedDimensions(axis: 4)
        hidden = MLX.broadcast(hidden, to: [batchSize, height, scale, width, scale, channels])
        hidden = hidden.reshaped([batchSize, height * scale, width * scale, channels])
        hidden = conv(hidden)
        return hidden.transposed(0, 3, 1, 2)
    }
}

/// Up decoder block: N resnets + optional upsamplers. Input/output NCHW.
public final class VAEUpDecoderBlock: Module {
    public let resnets: [VAEResnetBlock2D]
    public let upsamplers: [VAEUpSampler]?

    public init(resnets: [VAEResnetBlock2D], upsamplers: [VAEUpSampler]?) {
        self.resnets = resnets; self.upsamplers = upsamplers
        super.init()
    }

    public func callAsFunction(_ hidden: MLXArray) -> MLXArray {
        var state = hidden
        for resnet in resnets { state = resnet(state) }
        if let ups = upsamplers { for upsampler in ups { state = upsampler(state) } }
        return state
    }
}

/// Stride-2 conv downsampler with asymmetric spatial padding.
/// Port of mflux DownSampler: pad H,W by (0,1) each, transpose to NHWC,
/// Conv2d(k3, s2, p0), transpose back. Halves spatial dims. Input/output NCHW.
public final class VAEDownSampler: Module {
    public let conv: LoadedConv2d

    public init(conv: LoadedConv2d) {
        self.conv = conv
        super.init()
    }

    public func callAsFunction(_ inputArray: MLXArray) -> MLXArray {
        let widths: [IntOrPair] = [0, 0, [0, 1], [0, 1]]
        let padded = MLX.padded(inputArray, widths: widths)
        let hidden = padded.transposed(0, 2, 3, 1)
        return conv(hidden).transposed(0, 3, 1, 2)
    }
}

/// Encoder down block: N resnets + optional downsamplers. Input/output NCHW.
public final class VAEDownEncoderBlock: Module {
    public let resnets: [VAEResnetBlock2D]
    public let downsamplers: [VAEDownSampler]?

    public init(resnets: [VAEResnetBlock2D], downsamplers: [VAEDownSampler]?) {
        self.resnets = resnets
        self.downsamplers = downsamplers
        super.init()
    }

    public func callAsFunction(_ hidden: MLXArray) -> MLXArray {
        var state = hidden
        for resnet in resnets { state = resnet(state) }
        if let downs = downsamplers { for d in downs { state = d(state) } }
        return state
    }
}
