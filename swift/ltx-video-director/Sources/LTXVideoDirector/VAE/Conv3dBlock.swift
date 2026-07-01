//
//  Conv3dBlock.swift
//  LTXVideoDirector
//
//  Native MLX Swift port of ltx-2-mlx's Conv3dBlock (video_vae/convolution.py)
//  — the causal/non-causal 3D conv building block used throughout the LTX-2.3
//  video VAE (see PLAN.md Phase 1). Ported line-for-line from the Python
//  reference so the two are directly comparable; verified against it in
//  Tests/LTXVideoDirectorTests/Conv3dBlockParityTests.swift using a fixed
//  random weight/input dump (scripts/dump_conv3d_reference.py).
//
//  MLX Conv3d layout (both languages): input (B, D, H, W, C), weight
//  (O, D, H, W, I) — NDHWC / ODHWI, no NCDHW permutation needed unlike the
//  2D ESRGAN port (CommonImageDirector/ESRGAN.swift), which permutes from
//  PyTorch's channels-first layout. ltx-2-mlx's own weights are already
//  MLX-native NDHWC/ODHWI since Python-side mlx.nn.Conv3d uses that layout.
//

import Foundation
import MLX
import MLXNN

public struct Conv3dBlock {
    public let kernelSize: (Int, Int, Int)
    public let stride: (Int, Int, Int)
    public let causal: Bool
    public let spatialPadding: (Int, Int)
    public let spatialPaddingMode: String
    public let weight: MLXArray   // (O, D, H, W, I)
    public let bias: MLXArray     // (O,)

    public init(
        weight: MLXArray, bias: MLXArray,
        kernelSize: (Int, Int, Int) = (3, 3, 3),
        stride: (Int, Int, Int) = (1, 1, 1),
        padding: (Int, Int, Int) = (1, 1, 1),
        causal: Bool = true,
        spatialPaddingMode: String = "zeros"
    ) {
        self.weight = weight
        self.bias = bias
        self.kernelSize = kernelSize
        self.stride = stride
        self.causal = causal
        self.spatialPadding = (padding.1, padding.2)
        self.spatialPaddingMode = spatialPaddingMode
    }

    /// Forward: x is (B, D, H, W, C) — matches the Python reference exactly,
    /// including its temporal/spatial replicate-padding scheme.
    public func callAsFunction(_ x: MLXArray) -> MLXArray {
        var h = x
        let tk = kernelSize.0

        if causal {
            if tk > 1 {
                let firstFrame = MLX.repeated(h[0..., 0..<1, 0..., 0..., 0...], count: tk - 1, axis: 1)
                h = MLX.concatenated([firstFrame, h], axis: 1)
            }
        } else {
            let padSize = (tk - 1) / 2
            if padSize > 0 {
                let firstPad = MLX.repeated(h[0..., 0..<1, 0..., 0..., 0...], count: padSize, axis: 1)
                let d = h.dim(1)
                let lastPad = MLX.repeated(h[0..., (d - 1)..<d, 0..., 0..., 0...], count: padSize, axis: 1)
                h = MLX.concatenated([firstPad, h, lastPad], axis: 1)
            }
        }

        let (spH, spW) = spatialPadding
        if spH > 0 || spW > 0 {
            if spatialPaddingMode == "reflect" {
                if spH > 0 {
                    let height = h.dim(2)
                    let top = h[0..., 0..., 1..<(1 + spH), 0..., 0...]
                    let bottom = h[0..., 0..., (height - 1 - spH)..<(height - 1), 0..., 0...]
                    h = MLX.concatenated([top, h, bottom], axis: 2)
                }
                if spW > 0 {
                    let width = h.dim(3)
                    let left = h[0..., 0..., 0..., 1..<(1 + spW), 0...]
                    let right = h[0..., 0..., 0..., (width - 1 - spW)..<(width - 1), 0...]
                    h = MLX.concatenated([left, h, right], axis: 3)
                }
            } else {
                h = MLX.padded(h, widths: [
                    IntOrPair([0, 0]), IntOrPair([0, 0]), IntOrPair([spH, spH]),
                    IntOrPair([spW, spW]), IntOrPair([0, 0]),
                ])
            }
        }

        return MLX.conv3d(h, weight, stride: IntOrTriple([stride.0, stride.1, stride.2]), padding: 0) + bias
    }
}
