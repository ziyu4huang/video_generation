//
//  AudioVAEEncoder.swift
//  LTXVideoDirector
//
//  Native assembly of the LTX-2.3 audio VAE encoder
//  (ltx_core_mlx.model.audio_vae.encoder.AudioVAEEncoder) — the exact
//  structural inverse of AudioVAEDecoder.swift, reusing its shared
//  building blocks (WrappedConv2d, AudioResBlock). Confirmed against the
//  real vendor source directly:
//
//    conv_in:  WrappedConv2d 2 -> 128 (causal)
//    down.0:   2x AudioResBlock(128), AudioDownsample(128)   -> freq 64->32
//    down.1:   2x AudioResBlock(128->256, shortcut on block 0), AudioDownsample(256) -> freq 32->16
//    down.2:   2x AudioResBlock(256->512, shortcut on block 0), no downsample
//    mid:      AudioResBlock(512) -> AudioResBlock(512), no attention
//    conv_out: pixel_norm -> silu -> WrappedConv2d 512 -> 16 (causal), double_z:
//              keep first 8 channels (mean), discard logvar (last 8)
//
//  AudioDownsample is NOT a plain WrappedConv2d: the vendor's causal
//  padding is asymmetric — (2,0) on the time axis (causal) but (0,1) on
//  the frequency axis (right-pad only), vs. WrappedConv2d's symmetric
//  [padW,padW] width padding. Kept as its own small struct here rather
//  than distorting WrappedConv2d's shared semantics.
//
//  Latent layout mirrors the decoder: mel (B,2,T',64) NCHW-ish ->
//  (B,T',64,2) NHWC for Conv2d -> ... -> (B,T,16,8) NHWC mean channels ->
//  flattened (B,T,128) for per-channel normalization -> (B,8,T,16) output.
//

import MLX
import MLXNN

public struct AudioDownsample {
    public let conv: WrappedConv2d
    public let causal: Bool

    public init(conv: WrappedConv2d, causal: Bool) {
        self.conv = conv
        self.causal = causal
    }

    /// x: (B, H, W, C) NHWC.
    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        if causal {
            let padded = MLX.padded(x, widths: [
                IntOrPair([0, 0]), IntOrPair([2, 0]), IntOrPair([0, 1]), IntOrPair([0, 0]),
            ])
            return conv(padded)
        }
        return conv(x)
    }
}

public struct AudioDownStage {
    public let blocks: [AudioResBlock]
    public let downsample: AudioDownsample?

    public init(blocks: [AudioResBlock], downsample: AudioDownsample? = nil) {
        self.blocks = blocks
        self.downsample = downsample
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = x
        for block in blocks { h = block(h) }
        if let downsample { h = downsample(h) }
        return h
    }
}

public struct AudioVAEEncoder {
    public let convIn: WrappedConv2d
    public let down0: AudioDownStage  // 128->128, downsample
    public let down1: AudioDownStage  // 128->256, downsample
    public let down2: AudioDownStage  // 256->512, no downsample
    public let midBlock1: AudioResBlock
    public let midBlock2: AudioResBlock
    public let convOut: WrappedConv2d
    public let meanOfMeans: MLXArray
    public let stdOfMeans: MLXArray

    public init(
        convIn: WrappedConv2d, down0: AudioDownStage, down1: AudioDownStage, down2: AudioDownStage,
        midBlock1: AudioResBlock, midBlock2: AudioResBlock,
        convOut: WrappedConv2d, meanOfMeans: MLXArray, stdOfMeans: MLXArray
    ) {
        self.convIn = convIn
        self.down0 = down0; self.down1 = down1; self.down2 = down2
        self.midBlock1 = midBlock1; self.midBlock2 = midBlock2
        self.convOut = convOut
        self.meanOfMeans = meanOfMeans
        self.stdOfMeans = stdOfMeans
    }

    private func pixelNorm(_ x: MLXArray, eps: Float = 1e-6) -> MLXArray {
        let xf = x.asType(.float32)
        let meanSquare = (xf * xf).mean(axis: -1, keepDims: true)
        return xf / MLX.sqrt(meanSquare + eps)
    }

    /// Encode mel (B, 2, T', 64) to latent (B, 8, T, 16).
    public func callAsFunction(_ mel: MLXArray) -> MLXArray {
        var x = mel.transposed(0, 2, 3, 1)  // (B, T', 64, 2) NHWC

        x = convIn(x)
        x = down0(x)
        x = down1(x)
        x = down2(x)

        x = midBlock1(x)
        x = midBlock2(x)

        x = pixelNorm(x)
        x = MLXNN.silu(x)
        x = convOut(x)  // (B, T, 16, 16) NHWC — double_z

        let b = x.dim(0), t = x.dim(1), w = x.dim(2)
        x = x[0..., 0..., 0..., 0..<8]  // mean channels only, (B, T, 16, 8)

        x = x.transposed(0, 1, 3, 2)  // (B, T, 8, 16) — c first, f second
        var xFlat = x.reshaped([b, t, 8 * w])  // (B, T, 128)

        let mean = meanOfMeans.reshaped([1, 1, -1])
        let std = stdOfMeans.reshaped([1, 1, -1])
        xFlat = (xFlat - mean) / (std + 1e-8)

        let out = xFlat.reshaped([b, t, 8, w])  // (B, T, 8, 16)
        return out.transposed(0, 2, 1, 3)  // (B, 8, T, 16)
    }
}
