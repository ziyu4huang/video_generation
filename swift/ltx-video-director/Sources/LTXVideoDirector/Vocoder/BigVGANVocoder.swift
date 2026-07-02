//
//  BigVGANVocoder.swift
//  LTXVideoDirector
//
//  Native assembly of the LTX-2.3 BigVGAN v2 vocoder
//  (ltx_core_mlx.model.audio_vae.vocoder.BigVGANVocoder) from the
//  components ported so far (SnakeBeta, Activation1d, AMPBlock1), plus a
//  new ConvTranspose1d wrapper. Wired against the REAL checkpoint's
//  structure — confirmed by inspecting mlx-models/audio/ltx-2.3-audio/
//  vocoder.safetensors directly (`ups.N.weight` shape (C_out, K, C_in),
//  matching MLX.convTransposed1d's documented weight layout exactly, no
//  transpose needed) AND by reading BigVGANVocoder.__init__/__call__
//  directly:
//
//    conv_pre:  Conv1d 128 -> 1536, k=7, padding=3
//    6x stage:  ConvTranspose1d (rates 5,2,2,2,2,2; channels 1536->768->
//               384->192->96->48->24) -> 3x AMPBlock1 (kernel 3/7/11,
//               dilations (1,3,5) each) -> average the 3 resblock outputs
//    act_post:  Activation1d(24)
//    conv_post: Conv1d 24 -> 2, k=7, padding=3, NO bias
//    final:     tanh (when apply_final_activation, default true)
//
//  ConvTranspose1d padding formula: `(kernel - rate) // 2` (NOT the
//  standard `kernel // 2` used elsewhere in this port) — confirmed by
//  reading the reference constructor directly, not assumed.
//

import MLX

public struct ConvTranspose1d {
    public let weight: MLXArray  // (C_out, K, C_in)
    public let bias: MLXArray?
    public let stride: Int
    public let padding: Int

    public init(weight: MLXArray, bias: MLXArray?, stride: Int, padding: Int) {
        self.weight = weight
        self.bias = bias
        self.stride = stride
        self.padding = padding
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        let y = MLX.convTransposed1d(x, weight, stride: stride, padding: padding)
        return bias.map { y + $0 } ?? y
    }
}

public struct BigVGANUpsampleStage {
    public let up: ConvTranspose1d
    public let resblocks: [AMPBlock1]  // 3 per stage, averaged

    public init(up: ConvTranspose1d, resblocks: [AMPBlock1]) {
        self.up = up
        self.resblocks = resblocks
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        let h = up(x)
        var sum: MLXArray?
        for block in resblocks {
            let out = block(h)
            sum = sum.map { $0 + out } ?? out
        }
        return sum! / Float(resblocks.count)
    }
}

public struct BigVGANVocoder {
    public let convPreWeight: MLXArray, convPreBias: MLXArray
    public let stages: [BigVGANUpsampleStage]
    public let actPost: Activation1d
    public let convPostWeight: MLXArray  // no bias
    public let applyFinalActivation: Bool

    public init(
        convPreWeight: MLXArray, convPreBias: MLXArray, stages: [BigVGANUpsampleStage],
        actPost: Activation1d, convPostWeight: MLXArray, applyFinalActivation: Bool = true
    ) {
        self.convPreWeight = convPreWeight
        self.convPreBias = convPreBias
        self.stages = stages
        self.actPost = actPost
        self.convPostWeight = convPostWeight
        self.applyFinalActivation = applyFinalActivation
    }

    /// mel: (B, T, nMels). Returns waveform (B, T_audio, outChannels).
    public func callAsFunction(_ mel: MLXArray) -> MLXArray {
        var x = MLX.conv1d(mel, convPreWeight, stride: 1, padding: 3) + convPreBias
        for stage in stages {
            x = stage(x)
        }
        x = actPost(x)
        x = MLX.conv1d(x, convPostWeight, stride: 1, padding: 3)
        if applyFinalActivation {
            x = MLX.tanh(x)
        }
        return x
    }
}
