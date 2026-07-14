//
//  KontextConditioning.swift
//  Flux2Director
//
//  Part of the `kontext` (FLUX.1-Kontext-dev) native-port epic — see
//  output/next-goal-20260714_063909.md, phase 3. Ported directly from
//  mflux's `FluxLatentCreator.pack_latents`/`unpack_latents`
//  (`../mflux/src/mflux/models/flux/latent_creator/flux_latent_creator.py`)
//  and `KontextUtil.create_image_conditioning_latents`/`_create_image_ids`
//  (`../mflux/src/mflux/models/flux/variants/kontext/kontext_util.py`).
//
//  This is the STANDARD base-FLUX.1 2x2-patchify sequence packing — distinct
//  from Flux2 Klein's `Flux2LatentCreator.packLatents`, which operates on
//  already-32ch-patchified (Flux2-specific) latents and produces 4-tuple
//  grid ids. Kontext uses 16-channel VAE latents (no pre-patchify) and
//  3-tuple ids (matches the transformer's axes_dims_rope=[16,56,56]).
//  Neither this packing math nor the Kontext image-id leading-dim=1 marker
//  existed anywhere in this repo before this file — the transformer itself
//  (phase 2 of the epic) is not yet ported, so nothing calls this file yet.
//

import Foundation
import MLX

public enum KontextLatentCreator {
    /// (1, C, H, W) → (1, (H/16)*(W/16), C*4). Groups each 2x2 spatial cell
    /// into the channel dim (matches `FluxLatentCreator.pack_latents`).
    /// `height`/`width` are the PIXEL dimensions (not latent); the VAE's 8x
    /// downsample means `latents` is already (1, C, height/8, width/8), and
    /// this further folds 2x2 latent cells → so `height/16`/`width/16` match
    /// `latents.dim(2)/2`, `latents.dim(3)/2`.
    public static func packLatents(_ latents: MLXArray, height: Int, width: Int,
                                   numChannelsLatents: Int = 16) -> MLXArray {
        let lh = height / 16
        let lw = width / 16
        var x = latents.reshaped([1, numChannelsLatents, lh, 2, lw, 2])
        x = x.transposed(0, 2, 4, 1, 3, 5)
        return x.reshaped([1, lw * lh, numChannelsLatents * 4])
    }

    /// Inverse of `packLatents`: (1, (H/16)*(W/16), 64) → (1, 16, H/8, W/8).
    public static func unpackLatents(_ latents: MLXArray, height: Int, width: Int) -> MLXArray {
        let lh = height / 16
        let lw = width / 16
        var x = latents.reshaped([1, lh, lw, 16, 2, 2])
        x = x.transposed(0, 3, 1, 4, 2, 5)
        return x.reshaped([1, 16, lh * 2, lw * 2])
    }
}

public enum KontextUtil {
    /// Encode a reference ("hero") image and pack it into conditioning
    /// tokens + RoPE ids, mirroring
    /// `KontextUtil.create_image_conditioning_latents`. `vaeEncode` takes a
    /// normalized ([-1,1], NCHW, bfloat16) pixel array and returns the raw
    /// VAE-encoded latent (1, 16, H/8, W/8) — callers supply the actual
    /// Kontext VAE encoder (phase 4 of the epic; not required to exist for
    /// this function to compile/test in isolation).
    /// Returns (image_latents (1, (H/16)*(W/16), 64), image_ids (1, (H/16)*(W/16), 3)).
    public static func createImageConditioningLatents(
        normalizedPixels: MLXArray, height: Int, width: Int,
        vaeEncode: (MLXArray) -> MLXArray
    ) -> (MLXArray, MLXArray) {
        let encoded = vaeEncode(normalizedPixels)
        let imageLatents = KontextLatentCreator.packLatents(encoded, height: height, width: width)
        let imageIds = createImageIds(height: height, width: width)
        return (imageLatents, imageIds)
    }

    /// Coordinate-grid RoPE ids for reference-image tokens: (1, latent_h*latent_w, 3)
    /// = [1, row, col] — the leading `1` (vs `0` for the actual noise/generation
    /// latents) is what tells the transformer's joint attention "this token is
    /// a reference, not something being denoised." Mirrors
    /// `KontextUtil._create_image_ids` exactly (including its odd
    /// build-then-overwrite-column-0 shape, reproduced here directly instead).
    public static func createImageIds(height: Int, width: Int) -> MLXArray {
        let latentHeight = height / 16
        let latentWidth = width / 16
        let rowIds = MLX.arange(0, latentHeight, dtype: .int32)
            .expandedDimensions(axis: 1)
        let rowGrid = MLX.broadcast(rowIds, to: [latentHeight, latentWidth])
        let colIds = MLX.arange(0, latentWidth, dtype: .int32)
            .expandedDimensions(axis: 0)
        let colGrid = MLX.broadcast(colIds, to: [latentHeight, latentWidth])
        let flatRow = rowGrid.reshaped([-1])
        let flatCol = colGrid.reshaped([-1])
        let ones = MLX.ones([flatRow.size], dtype: .int32)
        let coords = MLX.stacked([ones, flatRow, flatCol], axis: 1)  // (latent_h*latent_w, 3)
        return coords.expandedDimensions(axis: 0)                     // (1, latent_h*latent_w, 3)
    }

    /// Coordinate-grid RoPE ids for the actual noise/generation latents being
    /// denoised: (1, latent_h*latent_w, 3) = [0, row, col] — leading `0`,
    /// NOT `1` (that marker is `createImageIds`, reserved for reference-image
    /// tokens only). Mirrors `Transformer._prepare_latent_image_ids` exactly.
    /// Found missing 2026-07-14: `KontextTransformer.shapeSelfTest` had been
    /// passing `createImageIds`'s leading-`1` reference marker as if it were
    /// the base generation ids — harmless for a shape-only check (same shape
    /// either way) but wrong for numeric parity, so added and wired in here.
    public static func createGenerationImageIds(height: Int, width: Int) -> MLXArray {
        let latentHeight = height / 16
        let latentWidth = width / 16
        let rowIds = MLX.arange(0, latentHeight, dtype: .int32)
            .expandedDimensions(axis: 1)
        let rowGrid = MLX.broadcast(rowIds, to: [latentHeight, latentWidth])
        let colIds = MLX.arange(0, latentWidth, dtype: .int32)
            .expandedDimensions(axis: 0)
        let colGrid = MLX.broadcast(colIds, to: [latentHeight, latentWidth])
        let flatRow = rowGrid.reshaped([-1])
        let flatCol = colGrid.reshaped([-1])
        let zeros = MLX.zeros([flatRow.size], dtype: .int32)
        let coords = MLX.stacked([zeros, flatRow, flatCol], axis: 1)  // (latent_h*latent_w, 3)
        return coords.expandedDimensions(axis: 0)                      // (1, latent_h*latent_w, 3)
    }
}
