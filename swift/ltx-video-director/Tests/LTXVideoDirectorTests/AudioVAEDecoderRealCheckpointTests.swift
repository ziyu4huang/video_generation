import XCTest
import MLX
@testable import LTXVideoDirector

/// Integration smoke test: load the REAL production LTX-2.3 audio VAE
/// decoder checkpoint (mlx-models/audio/ltx-2.3-audio/audio_vae.safetensors,
/// "audio_vae.decoder." prefix, underscore-prefixed per_channel_statistics
/// keys — same quirk as the video VAE encoder) and run a real forward
/// pass. No reference output to diff against — proves the native Swift
/// assembly loads real production weights (confirmed: no attention blocks
/// in this checkpoint, matching AudioVAEDecoder.swift's scope) and
/// produces finite, sane, correctly-shaped output. Skips gracefully if
/// the checkpoint isn't present.
final class AudioVAEDecoderRealCheckpointTests: XCTestCase {
    private func makeResBlock(_ arrays: [String: MLXArray], prefix: String, causal: Bool) -> AudioResBlock {
        let conv1 = WrappedConv2d(weight: arrays["\(prefix).conv1.conv.weight"]!, bias: arrays["\(prefix).conv1.conv.bias"]!, kernelSize: 3, padding: 1, causal: causal)
        let conv2 = WrappedConv2d(weight: arrays["\(prefix).conv2.conv.weight"]!, bias: arrays["\(prefix).conv2.conv.bias"]!, kernelSize: 3, padding: 1, causal: causal)
        var ninShortcut: WrappedConv2d?
        if let w = arrays["\(prefix).nin_shortcut.conv.weight"], let b = arrays["\(prefix).nin_shortcut.conv.bias"] {
            ninShortcut = WrappedConv2d(weight: w, bias: b, kernelSize: 1, padding: 0, causal: false)
        }
        return AudioResBlock(conv1: conv1, conv2: conv2, ninShortcut: ninShortcut)
    }

    private func makeStage(_ arrays: [String: MLXArray], prefix: String, numBlocks: Int, causal: Bool, hasUpsample: Bool) -> AudioResStage {
        let blocks = (0..<numBlocks).map { makeResBlock(arrays, prefix: "\(prefix).block.\($0)", causal: causal) }
        var upsample: AudioUpsample?
        if hasUpsample {
            let conv = WrappedConv2d(weight: arrays["\(prefix).upsample.conv.conv.weight"]!, bias: arrays["\(prefix).upsample.conv.conv.bias"]!, kernelSize: 3, padding: 1, causal: causal)
            upsample = AudioUpsample(conv: conv, causal: causal)
        }
        return AudioResStage(blocks: blocks, upsample: upsample)
    }

    func testRealCheckpointProducesFiniteOutput() throws {
        let checkpointURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw XCTSkip("real checkpoint not found at \(checkpointURL.path) — skipping integration smoke test")
        }

        let raw = try MLX.loadArrays(url: checkpointURL)
        var weights: [String: MLXArray] = [:]
        for (key, value) in raw {
            let prefix = "audio_vae.decoder."
            guard key.hasPrefix(prefix) else { continue }
            weights[String(key.dropFirst(prefix.count))] = value.asType(.float32)
        }
        // Top-level per_channel_statistics lives under "audio_vae." (not
        // "audio_vae.decoder."), with the same underscore-prefix quirk as
        // the video VAE encoder.
        for (key, value) in raw {
            if key == "audio_vae.per_channel_statistics._mean_of_means" {
                weights["per_channel_statistics.mean_of_means"] = value.asType(.float32)
            } else if key == "audio_vae.per_channel_statistics._std_of_means" {
                weights["per_channel_statistics.std_of_means"] = value.asType(.float32)
            }
        }
        XCTAssertNotNil(weights["per_channel_statistics.mean_of_means"])
        XCTAssertNotNil(weights["per_channel_statistics.std_of_means"])

        let causal = true
        let convIn = WrappedConv2d(weight: weights["conv_in.conv.weight"]!, bias: weights["conv_in.conv.bias"]!, kernelSize: 3, padding: 1, causal: causal)
        let convOut = WrappedConv2d(weight: weights["conv_out.conv.weight"]!, bias: weights["conv_out.conv.bias"]!, kernelSize: 3, padding: 1, causal: causal)
        let midBlock1 = makeResBlock(weights, prefix: "mid.block_1", causal: causal)
        let midBlock2 = makeResBlock(weights, prefix: "mid.block_2", causal: causal)
        let up0 = makeStage(weights, prefix: "up.0", numBlocks: 3, causal: causal, hasUpsample: false)
        let up1 = makeStage(weights, prefix: "up.1", numBlocks: 3, causal: causal, hasUpsample: true)
        let up2 = makeStage(weights, prefix: "up.2", numBlocks: 3, causal: causal, hasUpsample: true)

        let decoder = AudioVAEDecoder(
            convIn: convIn, midBlock1: midBlock1, midBlock2: midBlock2,
            up0: up0, up1: up1, up2: up2, convOut: convOut,
            meanOfMeans: weights["per_channel_statistics.mean_of_means"]!,
            stdOfMeans: weights["per_channel_statistics.std_of_means"]!)

        // Tiny synthetic latent: real channel layout (8, 16), minimal
        // temporal extent.
        let latent = MLXArray.zeros([1, 8, 3, 16]).asType(.float32)
        let mel = decoder(latent)
        MLX.eval(mel)

        XCTAssertEqual(mel.dim(0), 1)
        XCTAssertEqual(mel.dim(1), 2, "mel channel count")
        XCTAssertEqual(mel.dim(3), 64, "mel frequency bins")
        let flat = mel.asArray(Float.self)
        XCTAssertTrue(flat.allSatisfy { $0.isFinite }, "real-checkpoint audio decode produced NaN/Inf")
    }
}
