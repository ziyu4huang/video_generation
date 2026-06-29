//
//  Flux2LatentCreator.swift
//  Flux2Director
//
//  Phase 2.4: Packed-latent creation for Flux2 Klein. Ported from mflux's
//  flux2_latent_creator.py.
//
//  Flux2 packs 4 latent spatial cells into one sequence token: a (H,W) latent
//  of 32 channels becomes a (H/2 * W/2, 128) sequence. The latent ids encode
//  [t, h, w, layer] grid coordinates for RoPE.
//

import Foundation
import MLX
import MLXRandom

public enum Flux2LatentCreator {
    /// Create packed noisy latents + grid ids for a fresh txt2img run.
    /// Returns (packed_latents (1, latent_H*latent_W, 128), latent_ids (1, S, 4),
    ///          latent_height, latent_width).
    public static func preparePackedLatents(seed: UInt64, height: Int, width: Int,
                                            batchSize: Int = 1, numLatentChannels: Int = 32,
                                            vaeScaleFactor: Int = 8)
        -> (MLXArray, MLXArray, Int, Int)
    {
        // Round height/width down to even multiples of (vae_scale*2).
        let h = 2 * (height / (vaeScaleFactor * 2))
        let w = 2 * (width / (vaeScaleFactor * 2))
        let latentH = h / 2
        let latentW = w / 2
        // latents shape: (batch, 32*4=128, latent_H, latent_W). Match Python's
        // key=mx.random.key(seed) for exact reproducibility.
        let key = MLXRandom.key(seed)
        let latents = MLXRandom.normal(
            [batchSize, numLatentChannels * 4, latentH, latentW],
            dtype: .float32, key: key).asType(.bfloat16)
        let latentIds = prepareGridIds(latents: latents, tCoord: 0)
        // Pack: (B, 128, lh, lw) → (B, lh*lw, 128)
        let packed = packLatents(latents)
        return (packed, latentIds, latentH, latentW)
    }

    /// grid ids: (batch, lh*lw, 4) = [t, h, w, layer=0].
    public static func prepareGridIds(latents: MLXArray, tCoord: Int) -> MLXArray {
        let batchSize = latents.dim(0)
        let height = latents.dim(2)
        let width = latents.dim(3)
        let hIds = MLX.arange(0, height, dtype: .int32)              // (H,)
        let wIds = MLX.arange(0, width, dtype: .int32)               // (W,)
        // h_grid: (H, W) via broadcast
        let hGrid = MLX.broadcast(hIds.expandedDimensions(axis: 1), to: [height, width])
        let wGrid = MLX.broadcast(wIds.expandedDimensions(axis: 0), to: [height, width])
        let flatH = hGrid.reshaped([-1])                                  // (H*W,)
        let flatW = wGrid.reshaped([-1])
        let t = MLX.full([flatH.size], values: Int32(tCoord))             // (H*W,)
        let layerIds = MLX.zeros([flatH.size], dtype: .int32)
        let coords = MLX.stacked([t, flatH.asType(.int32), flatW.asType(.int32), layerIds], axis: 1)  // (H*W, 4)
        let coordsB1 = coords.expandedDimensions(axis: 0)                  // (1, H*W, 4)
        return MLX.broadcast(coordsB1, to: [batchSize, coords.dim(0), 4])
    }

    /// (B, C, H, W) → (B, H*W, C).
    public static func packLatents(_ latents: MLXArray) -> MLXArray {
        let (b, c, h, w) = (latents.dim(0), latents.dim(1), latents.dim(2), latents.dim(3))
        return latents.reshaped([b, c, h * w]).transposed(0, 2, 1)
    }

    /// Patchify: (B, 32, H, W) → (B, 128, H/2, W/2).
    /// Groups 2x2 spatial cells into channels (4x expansion): reshape
    /// (B, 32, H/2, 2, W/2, 2) → transpose (0,1,3,5,2,4) → reshape (B, 128, H/2, W/2).
    /// Port of Flux2LatentCreator.patchify_latents.
    public static func patchifyLatents(_ latents: MLXArray) -> MLXArray {
        var x = latents
        if x.ndim == 5 && x.dim(2) == 1 { x = x[0..., 0..., 0, 0..., 0...] }
        let (b, c, h, w) = (x.dim(0), x.dim(1), x.dim(2), x.dim(3))
        x = x.reshaped([b, c, h / 2, 2, w / 2, 2])
        x = x.transposed(0, 1, 3, 5, 2, 4)
        return x.reshaped([b, c * 4, h / 2, w / 2])
    }

    /// VAE-encode an image into a packed, BN-normalized latent usable as the
    /// **denoise canvas** (SDEdit init latent). This is the SAME encode pipeline
    /// as `Flux2ReferenceConditioning.prepare` steps 1–6 — the denoise loop
    /// operates in BN-normalized latent space (only `decodePackedLatents`
    /// denormalizes at the end), so the init latent must live in that same space
    /// to mix linearly with the flow-match noise. The difference vs a reference
    /// conditioning token is purely how the caller uses the result: this latent
    /// is the denoise `current` (sharing the t=0 noise latent ids), not a
    /// concatenated conditioning token.
    ///
    /// Returns packed (1, latent_H*latent_W, 128) float32, BN-normalized.
    public static func encodeInitLatent(imagePath: URL, vaeEncoder: Flux2VAEEncoder,
                                        bn: Flux2BatchNormStats, height: Int, width: Int)
        -> MLXArray
    {
        // 1. Load + normalize to [-1,1] at the target gen resolution.
        let pixels = try! Flux2ImageLoad.loadArray(
            from: imagePath, targetSize: (width: width, height: height))
        let normalized = Flux2ImageLoad.normalizeForVAE(pixels).asType(.bfloat16)

        // 2. VAE-encode → (1, 32, H/8, W/8).
        var encoded = vaeEncoder(normalized)

        // 3. crop_to_even_spatial (handle odd latent dims).
        if encoded.dim(2) % 2 != 0 { encoded = encoded[0..., 0..., 0..<(encoded.dim(2) - 1), 0...] }
        if encoded.dim(3) % 2 != 0 { encoded = encoded[0..., 0..., 0..., 0..<(encoded.dim(3) - 1)] }

        // 4. patchify (32 → 128ch, 2× spatial downsample).
        encoded = patchifyLatents(encoded)

        // 5. bn-normalize (encode direction: (x-mean)/std) — into denoise space.
        encoded = bnNormalizeEncoded(encoded, mean: bn.runningMean, var_: bn.runningVar, eps: bn.eps)

        // 6. pack to sequence tokens (B, C, H, W) → (B, H*W, C).
        return packLatents(encoded).asType(.float32)
    }

    /// BN-normalize VAE-encoded latents for reference conditioning (encode path):
    ///   (encoded - mean) / sqrt(var + eps)
    /// This is the INVERSE of the decode denorm (packed * std + mean).
    public static func bnNormalizeEncoded(_ encoded: MLXArray, mean: MLXArray, var_: MLXArray,
                                          eps: Float) -> MLXArray {
        let m = mean.reshaped([1, -1, 1, 1]).asType(encoded.dtype)
        let s = MLX.sqrt(var_.reshaped([1, -1, 1, 1]).asType(.float32) + eps).asType(encoded.dtype)
        return (encoded - m) / s
    }

    /// Build text ids: (batch, seq_len, 4) = [t=0, h=0, w=0, token_idx].
    public static func prepareTextIds(seqLen: Int, batchSize: Int = 1) -> MLXArray {
        let tokenIds = MLX.arange(0, seqLen, dtype: .int32)          // (seq,)
        let zeros = MLX.zeros([seqLen], dtype: .int32)
        let coords = MLX.stacked([zeros, zeros, zeros, tokenIds], axis: 1) // (seq, 4)
        let coordsB1 = coords.expandedDimensions(axis: 0)
        return MLX.broadcast(coordsB1, to: [batchSize, seqLen, 4])
    }
}
