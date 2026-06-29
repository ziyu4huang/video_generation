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
    public static func prepare(imagePaths: [URL], vaeEncoder: Flux2VAEEncoder,
                               bn: Flux2BatchNormStats, height: Int, width: Int,
                               batchSize: Int = 1)
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

            // 6. pack to sequence tokens (B, C, H, W) → (B, H*W, C).
            packedList.append(Flux2LatentCreator.packLatents(encoded))

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
