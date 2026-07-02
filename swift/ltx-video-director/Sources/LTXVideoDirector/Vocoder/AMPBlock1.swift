//
//  AMPBlock1.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.audio_vae.vocoder.AMPBlock1 —
//  anti-aliased multi-periodicity residual block: for each dilation d in
//  (1,3,5), act1 -> dilated conv1 -> act2 -> conv2 -> +residual.
//

import MLX

public struct AMPBlock1Layer {
    public let act1: Activation1d
    public let conv1Weight: MLXArray, conv1Bias: MLXArray, conv1Padding: Int, conv1Dilation: Int
    public let act2: Activation1d
    public let conv2Weight: MLXArray, conv2Bias: MLXArray, conv2Padding: Int

    public init(
        act1: Activation1d, conv1Weight: MLXArray, conv1Bias: MLXArray, conv1Padding: Int, conv1Dilation: Int,
        act2: Activation1d, conv2Weight: MLXArray, conv2Bias: MLXArray, conv2Padding: Int
    ) {
        self.act1 = act1
        self.conv1Weight = conv1Weight; self.conv1Bias = conv1Bias
        self.conv1Padding = conv1Padding; self.conv1Dilation = conv1Dilation
        self.act2 = act2
        self.conv2Weight = conv2Weight; self.conv2Bias = conv2Bias
        self.conv2Padding = conv2Padding
    }
}

public struct AMPBlock1 {
    public let layers: [AMPBlock1Layer]

    public init(layers: [AMPBlock1Layer]) {
        self.layers = layers
    }

    /// x: (B, T, C).
    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = x
        for layer in layers {
            let residual = h
            h = layer.act1(h)
            h = MLX.conv1d(h, layer.conv1Weight, stride: 1, padding: layer.conv1Padding, dilation: layer.conv1Dilation) + layer.conv1Bias
            h = layer.act2(h)
            h = MLX.conv1d(h, layer.conv2Weight, stride: 1, padding: layer.conv2Padding, dilation: 1) + layer.conv2Bias
            h = h + residual
        }
        return h
    }
}
