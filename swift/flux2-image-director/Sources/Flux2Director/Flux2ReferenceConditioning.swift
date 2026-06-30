//
//  Flux2ReferenceConditioning.swift
//  Flux2Director
//
//  Phase 3.1: Flux2KleinEdit reference image conditioning. Ported from mflux's
//  flux2_klein_edit_helpers.prepare_reference_image_conditioning.
//
//  Each reference image is: load → VAE-encode → patchify (32→128ch, 2× spatial)
//  → bn-normalize ((x-mean)/std) → pack to sequence tokens. The reference tokens
//  are concatenated to the noisy latents (along seq axis) and processed jointly
//  by the transformer. Their RoPE ids use t_coord = 10 + 10*i to distinguish
//  them from the noise tokens (t=0).
//
//  The transformer output is sliced to keep only the noise for the actual latents
//  (reference-token outputs are discarded).
//

import Foundation
import MLX

public enum Flux2ReferenceConditioning {
    /// Prepare reference image conditioning from one or more image paths.
    /// Returns (image_latents (1, total_ref_tokens, 128), image_latent_ids (1, S, 4)).
    /// Returns (nil, nil) if no image paths.
    ///
    /// `strengths` (optional, one per image) scales each reference's packed
    /// tokens before concatenation — a per-reference identity weight (WS3).
    /// Missing/extra entries default to 1.0 (no scaling).
    ///
    /// `regionMasks` (optional, one per image, shape (1,1,H/16,W/16) in [0,1])
    /// + `refRegionStrength` spatially ATTENUATE each reference's latent outside
    /// its mask region — binding identity→region. Applied in the patchified
    /// spatial grid (after BN, before pack) using multiplier
    /// `1 - strength·(1 - mask)` (mask=1 → keep, mask=0 → attenuate to
    /// `1-strength`). This keeps the model in its trained global-attention
    /// regime (only input token magnitudes change → in-distribution), unlike
    /// attention masking (OOD). Ported from ComfyUI Flux2Klein Mask-Ref
    /// Controller (capitan01R). WS4.
    public static func prepare(imagePaths: [URL], vaeEncoder: Flux2VAEEncoder,
                               bn: Flux2BatchNormStats, height: Int, width: Int,
                               batchSize: Int = 1, strengths: [Float]? = nil,
                               regionMasks: [MLXArray]? = nil,
                               refRegionStrength: Float = 1.0)
        -> (MLXArray?, MLXArray?)
    {
        guard !imagePaths.isEmpty else { return (nil, nil) }

        var packedList: [MLXArray] = []
        var idsList: [MLXArray] = []
        for (i, path) in imagePaths.enumerated() {
            // 1. Load + normalize to [-1,1] at the target gen resolution.
            let pixels = try! Flux2ImageLoad.loadArray(
                from: path, targetSize: (width: width, height: height))
            let normalized = Flux2ImageLoad.normalizeForVAE(pixels).asType(.bfloat16)

            // 2. VAE-encode → (1, 32, H/8, W/8).
            var encoded = vaeEncoder(normalized)

            // 3. crop_to_even_spatial (handle odd latent dims).
            if encoded.dim(2) % 2 != 0 { encoded = encoded[0..., 0..., 0..<(encoded.dim(2) - 1), 0...] }
            if encoded.dim(3) % 2 != 0 { encoded = encoded[0..., 0..., 0..., 0..<(encoded.dim(3) - 1)] }

            // 4. patchify (32 → 128ch, 2× spatial downsample).
            encoded = Flux2LatentCreator.patchifyLatents(encoded)

            // 5. bn-normalize (encode direction: (x-mean)/std).
            encoded = Flux2LatentCreator.bnNormalizeEncoded(
                encoded, mean: bn.runningMean, var_: bn.runningVar, eps: bn.eps)

            // 5b. WS4 region binding: attenuate this ref's latent OUTSIDE its mask
            // region (spatial grid, broadcasts over the 128 channels). In-distribution
            // spatial token scaling — the mechanism that actually binds (vs the
            // OOD attention-mask path that the distilled model ignores).
            if let masks = regionMasks, i < masks.count, refRegionStrength > 0 {
                let m = masks[i].asType(.float32)
                let mult = (1.0 - MLXArray(refRegionStrength) * (1.0 - m)).asType(encoded.dtype)
                encoded = (encoded * mult).asType(encoded.dtype)
            }

            // 6. pack to sequence tokens (B, C, H, W) → (B, H*W, C).
            //    Apply per-reference strength (WS3): scale this ref's token values.
            var packed = Flux2LatentCreator.packLatents(encoded)
            let s = (strengths?.indices.contains(i) ?? false) ? strengths![i] : 1.0
            if s != 1.0 {
                packed = (packed * MLXArray(s)).asType(packed.dtype)
            }
            packedList.append(packed)

            // 7. grid ids with t_coord = 10 + 10*i.
            idsList.append(Flux2LatentCreator.prepareGridIds(latents: encoded, tCoord: 10 + 10 * i))
        }

        var imageLatents = MLX.concatenated(packedList, axis: 1)
        var imageLatentIds = MLX.concatenated(idsList, axis: 1)
        if imageLatents.dim(0) != batchSize {
            imageLatents = MLX.broadcast(imageLatents,
                                          to: [batchSize, imageLatents.dim(1), imageLatents.dim(2)])
        }
        if imageLatentIds.dim(0) != batchSize {
            imageLatentIds = MLX.broadcast(imageLatentIds,
                                            to: [batchSize, imageLatentIds.dim(1), imageLatentIds.dim(2)])
        }
        return (imageLatents, imageLatentIds)
    }
}
