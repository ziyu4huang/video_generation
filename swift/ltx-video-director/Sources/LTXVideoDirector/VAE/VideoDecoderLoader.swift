//
//  VideoDecoderLoader.swift
//  LTXVideoDirector
//
//  Production loader for VideoDecoder against the real checkpoint at
//  mlx-models/vae/ltx-2.3-vae/vae_decoder.safetensors. Promotes the
//  weight-stripping logic already verified in
//  VideoDecoderRealCheckpointTests.swift out of test code so the CLI can
//  use it directly. Much thinner than AudioVAEDecoderLoader/
//  VocoderWithBWELoader — VideoDecoder already takes a raw
//  `[String: MLXArray]` weights dict rather than pre-wired sub-structs.
//

import Foundation
import MLX

public enum VideoDecoderLoader {
    public enum LoadError: Error, CustomStringConvertible {
        case missingCheckpoint(URL)

        public var description: String {
            switch self {
            case .missingCheckpoint(let url): return "video VAE decoder checkpoint not found at \(url.path)"
            }
        }
    }

    /// Loads the real production video VAE decoder from
    /// `mlx-models/vae/ltx-2.3-vae/vae_decoder.safetensors`. `causal:
    /// false` / `spatialPaddingMode: "zeros"` match LTX-2.3's actual
    /// decoder defaults (see VideoDecoder.swift's header on why `causal`
    /// defaults to false, opposite of the encoder).
    public static func loadReal(checkpointURL: URL, causal: Bool = false, spatialPaddingMode: String = "zeros") throws -> VideoDecoder {
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw LoadError.missingCheckpoint(checkpointURL)
        }
        let raw = try MLX.loadArrays(url: checkpointURL)
        var weights: [String: MLXArray] = [:]
        for (key, value) in raw {
            let strippedKey = key.hasPrefix("vae_decoder.") ? String(key.dropFirst("vae_decoder.".count)) : key
            weights[strippedKey] = value.asType(.float32)
        }
        return VideoDecoder(weights: weights, causal: causal, spatialPaddingMode: spatialPaddingMode)
    }
}
