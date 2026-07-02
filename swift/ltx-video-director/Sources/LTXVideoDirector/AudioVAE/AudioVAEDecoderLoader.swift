//
//  AudioVAEDecoderLoader.swift
//  LTXVideoDirector
//
//  Production loader for AudioVAEDecoder against the real checkpoint at
//  mlx-models/audio/ltx-2.3-audio/audio_vae.safetensors. Promotes the
//  weight-wiring logic already verified in
//  AudioVAEDecoderRealCheckpointTests.swift out of test code so the CLI
//  can use it directly — this is the load path a genuinely native (no
//  run.py) decode command depends on.
//

import Foundation
import MLX

public enum AudioVAEDecoderLoader {
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

    private static func makeStage(_ weights: [String: MLXArray], prefix: String, numBlocks: Int, causal: Bool, hasUpsample: Bool) throws -> AudioResStage {
        let blocks = try (0..<numBlocks).map { try makeResBlock(weights, prefix: "\(prefix).block.\($0)", causal: causal) }
        var upsample: AudioUpsample?
        if hasUpsample {
            guard let w = weights["\(prefix).upsample.conv.conv.weight"], let b = weights["\(prefix).upsample.conv.conv.bias"] else {
                throw LoadError.missingKey("\(prefix).upsample.conv.conv.weight")
            }
            let conv = WrappedConv2d(weight: w, bias: b, kernelSize: 3, padding: 1, causal: causal)
            upsample = AudioUpsample(conv: conv, causal: causal)
        }
        return AudioResStage(blocks: blocks, upsample: upsample)
    }

    /// Loads the real production audio VAE decoder from
    /// `mlx-models/audio/ltx-2.3-audio/audio_vae.safetensors`. Weights are
    /// upcast to float32 (matches VocoderWithBWE's documented fp32
    /// requirement for the downstream vocoder — keeping the whole audio
    /// path in one precision avoids a bf16/fp32 seam).
    public static func loadReal(checkpointURL: URL) throws -> AudioVAEDecoder {
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw LoadError.missingCheckpoint(checkpointURL)
        }
        let raw = try MLX.loadArrays(url: checkpointURL)
        var weights: [String: MLXArray] = [:]
        let prefix = "audio_vae.decoder."
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
        let midBlock1 = try makeResBlock(weights, prefix: "mid.block_1", causal: causal)
        let midBlock2 = try makeResBlock(weights, prefix: "mid.block_2", causal: causal)
        let up0 = try makeStage(weights, prefix: "up.0", numBlocks: 3, causal: causal, hasUpsample: false)
        let up1 = try makeStage(weights, prefix: "up.1", numBlocks: 3, causal: causal, hasUpsample: true)
        let up2 = try makeStage(weights, prefix: "up.2", numBlocks: 3, causal: causal, hasUpsample: true)

        return AudioVAEDecoder(
            convIn: convIn, midBlock1: midBlock1, midBlock2: midBlock2,
            up0: up0, up1: up1, up2: up2, convOut: convOut,
            meanOfMeans: meanOfMeans, stdOfMeans: stdOfMeans)
    }
}
