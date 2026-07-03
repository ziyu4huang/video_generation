//
//  Krea2VAE.swift
//  Krea2ImageDirector
//
//  Native Swift port of python/mlx-movie-director/app/krea2_vae.py — the
//  qwen_image_vae DECODER. For single-image (T=1) the 3D causal convs collapse
//  to 2D (only the last temporal weight plane contributes). Functional.
//  Parity-validated in python (max-diff 0.0166 vs diffusers oracle).
//

import Foundation
import MLX
import MLXNN

public enum Krea2VAE {
    /// Decode a single-image latent. latent: (B, H/8, W/8, 16) channels-last.
    /// Returns (B, H, W, 3) clamped to [-1, 1].
    public static func decode(_ latent: MLXArray, _ w: [String: MLXArray]) -> MLXArray {
        var x = conv3dAs2d(latent, "post_quant_conv", w, pad: 0)
        let d = "decoder"
        x = conv3dAs2d(x, "\(d).conv_in", w)
        x = resnetBlock(x, w, "\(d).mid_block.resnets.0")
        x = attnBlock(x, w, "\(d).mid_block.attentions.0")
        x = resnetBlock(x, w, "\(d).mid_block.resnets.1")
        let upConfig: [(Int, Bool)] = [(0, true), (1, true), (2, true), (3, false)]
        for (ui, hasResample) in upConfig {
            for ri in 0..<3 { x = resnetBlock(x, w, "\(d).up_blocks.\(ui).resnets.\(ri)") }
            if hasResample { x = upsample(x, w, "\(d).up_blocks.\(ui).upsamplers.0") }
        }
        x = rmsNorm(x, "\(d).norm_out.gamma", w)
        x = silu(x)
        x = conv3dAs2d(x, "\(d).conv_out", w)
        return MLX.maximum(MLX.minimum(x, 1.0), -1.0)
    }

    /// torch Conv3d (out,in,kT,kH,kW) -> last temporal plane -> MLX conv2d (out,kH,kW,in).
    static func conv3dAs2d(_ x: MLXArray, _ prefix: String, _ w: [String: MLXArray], pad: Int = 1) -> MLXArray {
        let w5 = w["\(prefix).weight"]!
        let w2d = w5[0..., 0..., w5.dim(2) - 1, 0..., 0...]   // (out,in,kH,kW)
        let mlx = w2d.transposed(0, 2, 3, 1)                  // (out,kH,kW,in)
        let y = MLX.conv2d(x, mlx, stride: [1, 1], padding: [pad, pad])
        if let b = w["\(prefix).bias"] { return y + b }
        return y
    }

    static func rmsNorm(_ x: MLXArray, _ gammaKey: String, _ w: [String: MLXArray], eps: Float = 1e-12) -> MLXArray {
        let g = w[gammaKey]!.reshaped([-1])
        let scale = Float(x.dim(-1)).squareRoot()
        // QwenImageRMS_norm: F.normalize (L2 = sqrt(SUM(x^2))) * sqrt(dim) * gamma — NOT RMS (mean).
        let sumSq = (x * x).sum(axis: -1)
        let norm = MLX.sqrt(sumSq + MLXArray(eps))
        return (x / norm.expandedDimensions(axis: -1)) * scale * g
    }

    static func silu(_ x: MLXArray) -> MLXArray { x * MLX.sigmoid(x) }

    static func resnetBlock(_ x: MLXArray, _ w: [String: MLXArray], _ prefix: String) -> MLXArray {
        var h = x
        let shortcut: MLXArray = (w["\(prefix).conv_shortcut.weight"] != nil)
            ? conv3dAs2d(h, "\(prefix).conv_shortcut", w, pad: 0) : h
        h = rmsNorm(h, "\(prefix).norm1.gamma", w); h = silu(h)
        h = conv3dAs2d(h, "\(prefix).conv1", w)
        h = rmsNorm(h, "\(prefix).norm2.gamma", w); h = silu(h)
        h = conv3dAs2d(h, "\(prefix).conv2", w)
        return h + shortcut
    }

    static func attnBlock(_ x: MLXArray, _ w: [String: MLXArray], _ prefix: String) -> MLXArray {
        let (N, H, Wd, C) = (x.dim(0), x.dim(1), x.dim(2), x.dim(3))
        let identity = x
        var h = rmsNorm(x, "\(prefix).norm.gamma", w)
        let qkvW = w["\(prefix).to_qkv.weight"]![0..., 0..., 0, 0]   // (3C, C)
        let qkv = MLX.matmul(h, qkvW.transposed(1, 0)) + w["\(prefix).to_qkv.bias"]!
        let parts = qkv.reshaped([N, H * Wd, 3 * C]).split(parts: 3, axis: -1)
        let q = parts[0].reshaped([N, 1, H * Wd, C])
        let k = parts[1].reshaped([N, 1, H * Wd, C])
        let v = parts[2].reshaped([N, 1, H * Wd, C])
        let scale = Float(Foundation.pow(Double(C), -0.5))
        let a = MLXFast.scaledDotProductAttention(queries: q, keys: k, values: v, scale: scale, mask: nil).reshaped([N, H, Wd, C])
        let projW = w["\(prefix).proj.weight"]![0..., 0..., 0, 0]
        let out = MLX.matmul(a, projW.transposed(1, 0)) + w["\(prefix).proj.bias"]!
        _ = h
        return out + identity
    }

    static func upsample(_ x: MLXArray, _ w: [String: MLXArray], _ prefix: String) -> MLXArray {
        let (N, H, Wd, C) = (x.dim(0), x.dim(1), x.dim(2), x.dim(3))
        let up = x.expandedDimensions(axis: 2).expandedDimensions(axis: 4)
        let tiled = MLX.broadcast(up, to: [N, H, 2, Wd, 2, C]).reshaped([N, H * 2, Wd * 2, C])
        let cw = w["\(prefix).resample.1.weight"]!            // (out, in, 3, 3)
        let mlx = cw.transposed(0, 2, 3, 1)                    // (out,3,3,in)
        var y = MLX.conv2d(tiled, mlx, stride: [1, 1], padding: [1, 1])
        if let b = w["\(prefix).resample.1.bias"] { y = y + b }
        return y
    }

    // MARK: - Encoder (for i2i)

    /// Downsample (encoder): ZeroPad right/bottom by 1, conv2d stride 2 -> H/2.
    static func downsample(_ x: MLXArray, _ w: [String: MLXArray], _ prefix: String) -> MLXArray {
        // torch downsample2d: Sequential(ZeroPad2d((0,1,0,1)), Conv2d(dim,dim,3,stride=(2,2)))
        let padded = MLX.padded(x, widths: [[0, 0], [0, 1], [0, 1], [0, 0]])
        let cw = w["\(prefix).resample.1.weight"]!            // Conv2d weight (ZeroPad is resample.0, no params)
        let mlx = cw.transposed(0, 2, 3, 1)
        var y = MLX.conv2d(padded, mlx, stride: [2, 2], padding: [0, 0])
        if let b = w["\(prefix).resample.1.bias"] { y = y + b }
        return y
    }

    /// Encode a single image. image: (B, H, W, 3) in [-1,1] -> latent (B, H/8, W/8, 16).
    /// (mode of the diagonal gaussian; quant_conv applied; NO mean/std rescale —
    /// caller rescales to diffusion space via (latent - mean)/std if needed.)
    public static func encode(_ image: MLXArray, _ w: [String: MLXArray]) -> MLXArray {
        var x = conv3dAs2d(image, "encoder.conv_in", w)
        // Flat down_blocks: [R,R,D, R,R,D, R,R,D, R,R] (R=resnet, D=downsample)
        // stages: (96→96,96→96,ds), (96→192,192→192,ds), (192→384,384→384,ds), (384→384,384→384)
        let flat = [(0,false),(1,false),(2,true),(3,false),(4,false),(5,true),
                    (6,false),(7,false),(8,true),(9,false),(10,false)]
        for (idx, isDown) in flat {
            if isDown { x = downsample(x, w, "encoder.down_blocks.\(idx)") }
            else { x = resnetBlock(x, w, "encoder.down_blocks.\(idx)") }
        }
        x = resnetBlock(x, w, "encoder.mid_block.resnets.0")
        x = attnBlock(x, w, "encoder.mid_block.attentions.0")
        x = resnetBlock(x, w, "encoder.mid_block.resnets.1")
        x = rmsNorm(x, "encoder.norm_out.gamma", w)
        x = silu(x)
        x = conv3dAs2d(x, "encoder.conv_out", w)              // (B,H/8,W/8, 32)
        x = conv3dAs2d(x, "quant_conv", w, pad: 0)            // 32 -> 32
        // DiagonalGaussian mode: split into mean/logvar, take mean (first half).
        let (B, H, Wd, _) = (x.dim(0), x.dim(1), x.dim(2), x.dim(3))
        let halves = x.split(parts: 2, axis: -1)              // each (B,H,W,16)
        _ = (B, H, Wd)
        return halves[0]                                      // mean (mode)
    }
}
