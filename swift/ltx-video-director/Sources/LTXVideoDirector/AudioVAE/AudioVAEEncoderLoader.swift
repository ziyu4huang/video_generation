//
//  AudioVAEEncoderLoader.swift
//  LTXVideoDirector
//
//  Production loader for AudioVAEEncoder against the same checkpoint
//  AudioVAEDecoderLoader already uses — mlx-models/audio/ltx-2.3-audio/
//  audio_vae.safetensors contains both `audio_vae.decoder.*` and
//  `audio_vae.encoder.*` prefixes in one file (confirmed by direct
//  inspection), so no separate download is needed for the encode
//  direction. Mirrors AudioVAEDecoderLoader's wiring approach.
//

import Foundation
import MLX

public enum AudioVAEEncoderLoader {
    public enum LoadError: Error, CustomStringConvertible {
        case missingCheckpoint(URL)
        case missingKey(String)

        public var description: String {
            switch self {
            case .missingCheckpoint(let url): return "audio VAE checkpoint not found at \(url.path)"
            case .missingKey(let key): return "audio VAE checkpoint missing expected key: \(key)"
            }
        }
    }

    private static func makeResBlock(_ weights: [String: MLXArray], prefix: String, causal: Bool) throws -> AudioResBlock {
        func need(_ key: String) throws -> MLXArray {
            guard let v = weights[key] else { throw LoadError.missingKey(key) }
            return v
        }
        let conv1 = WrappedConv2d(weight: try need("\(prefix).conv1.conv.weight"), bias: try need("\(prefix).conv1.conv.bias"), kernelSize: 3, padding: 1, causal: causal)
        let conv2 = WrappedConv2d(weight: try need("\(prefix).conv2.conv.weight"), bias: try need("\(prefix).conv2.conv.bias"), kernelSize: 3, padding: 1, causal: causal)
        var ninShortcut: WrappedConv2d?
        if let w = weights["\(prefix).nin_shortcut.conv.weight"], let b = weights["\(prefix).nin_shortcut.conv.bias"] {
            ninShortcut = WrappedConv2d(weight: w, bias: b, kernelSize: 1, padding: 0, causal: false)
        }
        return AudioResBlock(conv1: conv1, conv2: conv2, ninShortcut: ninShortcut)
    }

    private static func makeStage(_ weights: [String: MLXArray], prefix: String, numBlocks: Int, causal: Bool, hasDownsample: Bool) throws -> AudioDownStage {
        let blocks = try (0..<numBlocks).map { try makeResBlock(weights, prefix: "\(prefix).block.\($0)", causal: causal) }
        var downsample: AudioDownsample?
        if hasDownsample {
            guard let w = weights["\(prefix).downsample.conv.weight"], let b = weights["\(prefix).downsample.conv.bias"] else {
                throw LoadError.missingKey("\(prefix).downsample.conv.weight")
            }
            // stride-2, padding=0 (causal manual-pad handled by AudioDownsample itself).
            let conv = WrappedConv2d(weight: w, bias: b, kernelSize: 3, padding: 0, causal: false, stride: (2, 2))
            downsample = AudioDownsample(conv: conv, causal: causal)
        }
        return AudioDownStage(blocks: blocks, downsample: downsample)
    }

    /// Loads the real production audio VAE encoder from
    /// `mlx-models/audio/ltx-2.3-audio/audio_vae.safetensors`. Weights are
    /// upcast to float32, matching AudioVAEDecoderLoader's precision choice
    /// so the encode/decode roundtrip stays in one precision.
    public static func loadReal(checkpointURL: URL) throws -> AudioVAEEncoder {
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw LoadError.missingCheckpoint(checkpointURL)
        }
        let raw = try MLX.loadArrays(url: checkpointURL)
        var weights: [String: MLXArray] = [:]
        let prefix = "audio_vae.encoder."
        for (key, value) in raw {
            guard key.hasPrefix(prefix) else { continue }
            weights[String(key.dropFirst(prefix.count))] = value.asType(.float32)
        }
        for (key, value) in raw {
            if key == "audio_vae.per_channel_statistics._mean_of_means" {
                weights["per_channel_statistics.mean_of_means"] = value.asType(.float32)
            } else if key == "audio_vae.per_channel_statistics._std_of_means" {
                weights["per_channel_statistics.std_of_means"] = value.asType(.float32)
            }
        }
        guard let meanOfMeans = weights["per_channel_statistics.mean_of_means"] else {
            throw LoadError.missingKey("audio_vae.per_channel_statistics._mean_of_means")
        }
        guard let stdOfMeans = weights["per_channel_statistics.std_of_means"] else {
            throw LoadError.missingKey("audio_vae.per_channel_statistics._std_of_means")
        }

        let causal = true
        func need(_ key: String) throws -> MLXArray {
            guard let v = weights[key] else { throw LoadError.missingKey(key) }
            return v
        }
        let convIn = WrappedConv2d(weight: try need("conv_in.conv.weight"), bias: try need("conv_in.conv.bias"), kernelSize: 3, padding: 1, causal: causal)
        let convOut = WrappedConv2d(weight: try need("conv_out.conv.weight"), bias: try need("conv_out.conv.bias"), kernelSize: 3, padding: 1, causal: causal)
        let down0 = try makeStage(weights, prefix: "down.0", numBlocks: 2, causal: causal, hasDownsample: true)
        let down1 = try makeStage(weights, prefix: "down.1", numBlocks: 2, causal: causal, hasDownsample: true)
        let down2 = try makeStage(weights, prefix: "down.2", numBlocks: 2, causal: causal, hasDownsample: false)
        let midBlock1 = try makeResBlock(weights, prefix: "mid.block_1", causal: causal)
        let midBlock2 = try makeResBlock(weights, prefix: "mid.block_2", causal: causal)

        return AudioVAEEncoder(
            convIn: convIn, down0: down0, down1: down1, down2: down2,
            midBlock1: midBlock1, midBlock2: midBlock2, convOut: convOut,
            meanOfMeans: meanOfMeans, stdOfMeans: stdOfMeans)
    }
}
