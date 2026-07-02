//
//  HannSincResampler.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.audio_vae.bwe.HannSincResampler — a
//  3x upsampler using Hann-windowed sinc interpolation (no learned
//  weights; the kernel is computed deterministically). Used by
//  VocoderWithBWE to resample the base vocoder's 16kHz output before
//  adding the BWE generator's high-frequency residual.
//
//  Zero-insertion (step 2 of the reference) is implemented via reshape,
//  NOT strided assignment (`upsampled[:, ::ratio] = x`) — the vendored
//  Python uses `.at[:, ::ratio].add()`, the SAME confirmed MLX 0.31.2
//  Metal mis-indexing bug already found and worked around in
//  UpSample1d/Activation1d.swift (this project's own memory:
//  "project_mlx_audio_fix" — app/vendor_patches.py's
//  `_patch_hann_sinc_resampler` applies the identical direct-assignment
//  fix at runtime). Avoiding strided writes sidesteps the whole bug class.
//

import Foundation
import MLX

public struct HannSincResampler {
    public let upsampleFactor: Int
    public let kernel: MLXArray  // (K, 1)
    private let width: Int
    private let padLeft: Int
    private let padRight: Int

    public init(upsampleFactor: Int = 3) {
        self.upsampleFactor = upsampleFactor
        let rolloff = 0.99
        let lowpassFilterWidth = 6.0
        let width = Int((lowpassFilterWidth / rolloff).rounded(.up))
        self.width = width

        let kernelSize = 2 * width * upsampleFactor + 1
        var kernelValues = [Float](repeating: 0, count: kernelSize)
        for i in 0..<kernelSize {
            let idx = Double(i)
            let timeAxis = (idx / Double(upsampleFactor) - Double(width)) * rolloff
            let timeClamped = max(-lowpassFilterWidth, min(lowpassFilterWidth, timeAxis))
            let window = Foundation.pow(Foundation.cos(timeClamped * Double.pi / lowpassFilterWidth / 2), 2)
            let sincValue = timeAxis == 0 ? 1.0 : Foundation.sin(Double.pi * timeAxis) / (Double.pi * timeAxis)
            kernelValues[i] = Float(sincValue * window * rolloff / Double(upsampleFactor))
        }
        self.kernel = MLXArray(kernelValues).reshaped([kernelSize, 1])

        self.padLeft = 2 * width * upsampleFactor
        self.padRight = kernelSize - upsampleFactor
    }

    /// x: (B, T) -> (B, T * upsampleFactor).
    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        let b = x.dim(0), t = x.dim(1)
        let ratio = upsampleFactor

        let first = MLX.repeated(x[0..., 0..<1], count: width, axis: 1)
        let last = MLX.repeated(x[0..., (t - 1)..<t], count: width, axis: 1)
        let xPadded = MLX.concatenated([first, x, last], axis: 1)
        let tPadded = xPadded.dim(1)

        // Zero-insert via reshape instead of strided assignment (see header).
        let ziLen = (tPadded - 1) * ratio + 1
        let zeros = MLXArray.zeros([b, tPadded, ratio - 1]).asType(x.dtype)
        let xExpanded = xPadded.expandedDimensions(axis: 2)
        let interleaved = MLX.concatenated([xExpanded, zeros], axis: 2)  // (B, T_padded, ratio)
        var upsampled = interleaved.reshaped([b, tPadded * ratio])
        // Reference length is (T_padded-1)*ratio + 1, i.e. it drops the
        // trailing (ratio-1) zero-columns after the last real sample.
        upsampled = upsampled[0..., 0..<ziLen]

        var h = upsampled.expandedDimensions(axis: 2)  // (B, ziLen, 1)
        let k = kernel.dim(0)
        h = MLX.padded(h, widths: [IntOrPair([0, 0]), IntOrPair([k - 1, k - 1]), IntOrPair([0, 0])])
        let filt = kernel.expandedDimensions(axis: 0)  // (1, K, 1)
        h = MLX.conv1d(h, filt, padding: 0)
        var result = h.squeezed(axis: -1)  // (B, ziLen + K - 1)

        result = result * Float(ratio)
        let end = result.dim(1) - padRight
        result = result[0..., padLeft..<end]
        return result[0..., 0..<(t * ratio)]
    }
}
