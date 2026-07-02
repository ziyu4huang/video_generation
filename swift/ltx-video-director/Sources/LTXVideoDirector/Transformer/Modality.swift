//
//  Modality.swift
//  LTXVideoDirector
//
//  Native port of ltx_core_mlx.model.transformer.modality.Modality — the
//  input bundle for one of (video, audio) in the LTX-2 DiT: latent, sigma,
//  per-token timesteps, positions, text context, and optional masks. Plain
//  data container (no numerics to verify) with a `split` utility used by
//  guidance code that batches multiple guidance variants (cond/neg/ptb/mod)
//  and needs to break them apart again.
//

import MLX

public struct Modality {
    public var latent: MLXArray           // (B, T, D)
    public var sigma: MLXArray            // (B,)
    public var timesteps: MLXArray        // (B, T)
    public var positions: MLXArray        // (B, 3, T) video / (B, 1, T) audio
    public var context: MLXArray
    public var enabled: Bool = true
    public var contextMask: MLXArray?
    public var attentionMask: MLXArray?

    public init(
        latent: MLXArray, sigma: MLXArray, timesteps: MLXArray, positions: MLXArray,
        context: MLXArray, enabled: Bool = true, contextMask: MLXArray? = nil, attentionMask: MLXArray? = nil
    ) {
        self.latent = latent
        self.sigma = sigma
        self.timesteps = timesteps
        self.positions = positions
        self.context = context
        self.enabled = enabled
        self.contextMask = contextMask
        self.attentionMask = attentionMask
    }

    /// Split along the batch dimension into chunks of the given sizes.
    /// Mirrors upstream's Modality.split — used by guidance code batching
    /// multiple guidance variants (cond/neg/ptb/mod).
    public func split(sizes: [Int]) -> [Modality] {
        var offsets: [Int] = []
        var acc = 0
        for s in sizes {
            offsets.append(acc)
            acc += s
        }

        func slice(_ array: MLXArray, _ offset: Int, _ size: Int) -> MLXArray {
            array[offset..<(offset + size)]
        }
        func sliceOptional(_ array: MLXArray?, _ offset: Int, _ size: Int) -> MLXArray? {
            array.map { slice($0, offset, size) }
        }

        return zip(offsets, sizes).map { offset, size in
            Modality(
                latent: slice(latent, offset, size),
                sigma: slice(sigma, offset, size),
                timesteps: slice(timesteps, offset, size),
                positions: slice(positions, offset, size),
                context: slice(context, offset, size),
                enabled: enabled,
                contextMask: sliceOptional(contextMask, offset, size),
                attentionMask: sliceOptional(attentionMask, offset, size)
            )
        }
    }
}
