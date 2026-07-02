//
//  AudioVAEDecoder.swift
//  LTXVideoDirector
//
//  Native assembly of the LTX-2.3 audio VAE decoder
//  (ltx_core_mlx.model.audio_vae.audio_vae.AudioVAEDecoder) from the
//  components ported so far (WrappedConv2d, AudioResBlock, AudioUpsample),
//  wired against the REAL checkpoint's structure — confirmed by inspecting
//  mlx-models/audio/ltx-2.3-audio/audio_vae.safetensors directly (no
//  attention keys present anywhere — `add_attention=False` for both `mid`
//  and every `up` stage in this checkpoint) AND by reading
//  AudioVAEDecoder.__init__/decode() directly:
//
//    conv_in:  WrappedConv2d 8 -> 512 (causal)
//    mid:      AudioResBlock(512) -> AudioResBlock(512), no attention
//    up.2:     3x AudioResBlock(512), Upsample        -> freq 16->32
//    up.1:     3x AudioResBlock(512->256), Upsample   -> freq 32->64
//    up.0:     3x AudioResBlock(256->128), no upsample
//    (up stages run in REVERSE index order: up.2, up.1, up.0)
//    conv_out: pixel_norm -> silu -> WrappedConv2d 128 -> 2 (causal)
//
//  Latent layout: (B, 8, T, 16) PyTorch-ish -> flattened to (B, T, 128) for
//  per-channel denormalization -> reshaped to (B, T, 16, 8) NHWC for Conv2d
//  (T=height/time, 16=width/frequency, 8=channels). Output (B, T', 64, 2)
//  NHWC -> transposed to (B, 2, T', 64) mel.
//

import MLX
import MLXNN

public struct AudioResStage {
    public let blocks: [AudioResBlock]
    public let upsample: AudioUpsample?

    public init(blocks: [AudioResBlock], upsample: AudioUpsample? = nil) {
        self.blocks = blocks
        self.upsample = upsample
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = x
        for block in blocks { h = block(h) }
        if let upsample { h = upsample(h) }
        return h
    }
}

public struct AudioVAEDecoder {
    public let convIn: WrappedConv2d
    public let midBlock1: AudioResBlock
    public let midBlock2: AudioResBlock
    public let up0: AudioResStage  // 256->128, no upsample
    public let up1: AudioResStage  // 512->256, upsample
    public let up2: AudioResStage  // 512->512, upsample
    public let convOut: WrappedConv2d
    public let meanOfMeans: MLXArray
    public let stdOfMeans: MLXArray

    public init(
        convIn: WrappedConv2d, midBlock1: AudioResBlock, midBlock2: AudioResBlock,
        up0: AudioResStage, up1: AudioResStage, up2: AudioResStage,
        convOut: WrappedConv2d, meanOfMeans: MLXArray, stdOfMeans: MLXArray
    ) {
        self.convIn = convIn
        self.midBlock1 = midBlock1
        self.midBlock2 = midBlock2
        self.up0 = up0; self.up1 = up1; self.up2 = up2
        self.convOut = convOut
        self.meanOfMeans = meanOfMeans
        self.stdOfMeans = stdOfMeans
    }

    private func pixelNorm(_ x: MLXArray, eps: Float = 1e-6) -> MLXArray {
        let xf = x.asType(.float32)
        let meanSquare = (xf * xf).mean(axis: -1, keepDims: true)
        return xf / MLX.sqrt(meanSquare + eps)
    }

    /// Decode `latent` (B, 8, T, 16) to mel (B, 2, T', 64).
    public func callAsFunction(_ latent: MLXArray) -> MLXArray {
        let b = latent.dim(0), c1 = latent.dim(1), t = latent.dim(2), c2 = latent.dim(3)

        var xFlat = latent.transposed(0, 2, 1, 3).reshaped([b, t, c1 * c2])
        let mean = meanOfMeans.reshaped([1, 1, -1])
        let std = stdOfMeans.reshaped([1, 1, -1])
        xFlat = xFlat * std + mean

        var x = xFlat.reshaped([b, t, c1, c2]).transposed(0, 1, 3, 2)  // (B,T,16,8) NHWC

        x = convIn(x)
        x = midBlock1(x)
        x = midBlock2(x)

        x = up2(x)
        x = up1(x)
        x = up0(x)

        x = pixelNorm(x)
        x = MLXNN.silu(x)
        x = convOut(x)

        return x.transposed(0, 3, 1, 2)  // (B, 2, T', 64)
    }
}
