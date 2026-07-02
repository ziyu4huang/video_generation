import XCTest
import MLX
@testable import LTXVideoDirector

/// Integration smoke test: load the REAL production LTX-2.3 VAE encoder
/// checkpoint (mlx-models/vae/ltx-2.3-vae/vae_encoder.safetensors, bf16,
/// "vae_encoder." key prefix, underscore-prefixed per_channel_statistics
/// keys) and run a real forward pass. Mirrors VideoDecoderRealCheckpointTests.
/// No reference output to diff against — proves the native Swift assembly
/// loads real production weights and produces finite, sane, correctly-
/// shaped output. Skips gracefully if the checkpoint isn't present.
final class VideoEncoderRealCheckpointTests: XCTestCase {
    func testRealCheckpointProducesFiniteOutput() throws {
        let checkpointURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw XCTSkip("real checkpoint not found at \(checkpointURL.path) — skipping integration smoke test")
        }

        let raw = try MLX.loadArrays(url: checkpointURL)
        var weights: [String: MLXArray] = [:]
        for (key, value) in raw {
            let strippedKey = key.hasPrefix("vae_encoder.") ? String(key.dropFirst("vae_encoder.".count)) : key
            weights[strippedKey] = value.asType(.float32)
        }
        XCTAssertEqual(weights.count, 86, "expected 86 tensors in the real checkpoint")

        let encoder = VideoEncoder(weights: weights)
        // Tiny synthetic pixel input: real channel count (3, RGB), minimal
        // spatial/temporal extent large enough to survive 4x spatial
        // patchify + further 16x spatial / 8x temporal downsampling
        // (4 stride-2 stages) without collapsing to zero.
        let pixels = MLXArray.zeros([1, 3, 9, 64, 64]).asType(.float32)
        let latent = encoder(pixels)
        MLX.eval(latent)

        XCTAssertEqual(latent.dim(0), 1)
        XCTAssertEqual(latent.dim(1), 128, "latent channel count")
        let flat = latent.asArray(Float.self)
        XCTAssertTrue(flat.allSatisfy { $0.isFinite }, "real-checkpoint encode produced NaN/Inf")
    }
}
