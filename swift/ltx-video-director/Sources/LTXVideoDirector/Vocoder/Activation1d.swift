//
//  Activation1d.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.audio_vae.vocoder's anti-aliased
//  activation wrapper: DownSample1d, UpSample1d, Activation1d
//  (upsample -> SnakeBeta -> downsample). Used throughout BigVGAN's
//  resblocks/upsample stages to avoid aliasing artifacts around the
//  periodic SnakeBeta nonlinearity.
//
//  UpSample1d's zero-interleaving is implemented via reshape (write x into
//  the even slot of a (B,T,2,C) buffer, reshape to (B,T*2,C)) rather than
//  strided assignment (`x[:, ::2, :] = x`) — this project's own memory
//  notes a real MLX 0.31.2 Metal bug in `.at[strided].add()` that caused
//  audio silence; avoiding strided writes sidesteps that class of bug
//  entirely rather than relying on a version-specific fix.
//

import MLX

public struct LowPassKernel {
    public let filter: MLXArray  // (1, K, 1) MLX Conv1d format (O, K, I)
    public init(filter: MLXArray) { self.filter = filter }
}

public struct DownSample1d {
    public let lowpass: LowPassKernel

    public init(lowpass: LowPassKernel) {
        self.lowpass = lowpass
    }

    /// x: (B, T, C) -> (B, T//2, C).
    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        let b = x.dim(0), t = x.dim(1), c = x.dim(2)
        var h = x.transposed(0, 2, 1).reshaped([b * c, t, 1])

        let k = lowpass.filter.dim(1)
        let even = k % 2 == 0 ? 1 : 0
        let padLeft = k / 2 - even
        let padRight = k / 2
        let leftEdge = MLX.repeated(h[0..., 0..<1, 0...], count: padLeft, axis: 1)
        let rightEdge = MLX.repeated(h[0..., (t - 1)..<t, 0...], count: padRight, axis: 1)
        h = MLX.concatenated([leftEdge, h, rightEdge], axis: 1)

        h = MLX.conv1d(h, lowpass.filter, stride: 2)

        let tOut = h.dim(1)
        return h.reshaped([b, c, tOut]).transposed(0, 2, 1)
    }
}

public struct UpSample1d {
    public let filter: MLXArray  // (1, K, 1)

    public init(filter: MLXArray) {
        self.filter = filter
    }

    /// x: (B, T, C) -> (B, T*2, C).
    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        let b = x.dim(0), t = x.dim(1), c = x.dim(2)

        // Interleave zeros via reshape instead of strided assignment
        // (`x[:, ::2, :] = x`) — see file header.
        let zeros = MLXArray.zeros([b, t, 1, c]).asType(x.dtype)
        let xExpanded = x.expandedDimensions(axis: 2)  // (B, T, 1, C)
        let interleaved = MLX.concatenated([xExpanded, zeros], axis: 2)  // (B, T, 2, C)
        var xUp = interleaved.reshaped([b, t * 2, c])

        xUp = xUp.transposed(0, 2, 1).reshaped([b * c, t * 2, 1])

        let k = filter.dim(1)
        let pad = k / 2
        let leftEdge = MLX.repeated(xUp[0..., 0..<1, 0...], count: pad, axis: 1)
        let rightEdge = MLX.repeated(xUp[0..., (t * 2 - 1)..<(t * 2), 0...], count: pad - 1, axis: 1)
        xUp = MLX.concatenated([leftEdge, xUp, rightEdge], axis: 1)

        xUp = MLX.conv1d(xUp, filter, stride: 1)

        let tOut = xUp.dim(1)
        return xUp.reshaped([b, c, tOut]).transposed(0, 2, 1) * 2.0
    }
}

public struct Activation1d {
    public let act: SnakeBeta
    public let upsample: UpSample1d
    public let downsample: DownSample1d

    public init(act: SnakeBeta, upsample: UpSample1d, downsample: DownSample1d) {
        self.act = act
        self.upsample = upsample
        self.downsample = downsample
    }

    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = upsample(x)
        h = act(h)
        h = downsample(h)
        return h
    }
}
