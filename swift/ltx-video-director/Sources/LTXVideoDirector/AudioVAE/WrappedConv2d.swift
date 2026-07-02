//
//  WrappedConv2d.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.audio_vae.audio_vae.WrappedConv2d —
//  a Conv2d with optional causal (height-axis) padding: the audio VAE
//  treats its (B, 8, T, 16) latent as a 2D spatial tensor in NHWC layout
//  (B, T, 16, 8), upsampling the frequency axis (16) while keeping time
//  (T, mapped to "height") causally padded when enabled.
//
//  Reference: when `causal and kernel_size > 1`, padding is manual/
//  asymmetric (full causal pad on height-top only, symmetric on width,
//  conv itself gets padding=0). Otherwise the conv uses standard
//  symmetric `padding` on BOTH spatial axes (plain nn.Conv2d semantics).
//

import MLX

public struct WrappedConv2d {
    public let weight: MLXArray  // (O, kH, kW, I)
    public let bias: MLXArray
    public let causal: Bool
    public let padHTop: Int
    public let padW: Int
    public let symmetricPadding: Int
    public let stride: (Int, Int)

    public init(weight: MLXArray, bias: MLXArray, kernelSize: Int, padding: Int, causal: Bool, stride: (Int, Int) = (1, 1)) {
        self.weight = weight
        self.bias = bias
        self.causal = causal
        self.stride = stride
        if causal && kernelSize > 1 {
            self.padHTop = kernelSize - 1
            self.padW = padding
            self.symmetricPadding = 0
        } else {
            self.padHTop = 0
            self.padW = 0
            self.symmetricPadding = padding
        }
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        if causal && (padHTop > 0 || padW > 0) {
            let h = MLX.padded(x, widths: [
                IntOrPair([0, 0]), IntOrPair([padHTop, 0]), IntOrPair([padW, padW]), IntOrPair([0, 0]),
            ])
            return MLX.conv2d(h, weight, stride: IntOrPair(stride), padding: 0) + bias
        } else {
            return MLX.conv2d(x, weight, stride: IntOrPair(stride), padding: IntOrPair(symmetricPadding)) + bias
        }
    }
}
