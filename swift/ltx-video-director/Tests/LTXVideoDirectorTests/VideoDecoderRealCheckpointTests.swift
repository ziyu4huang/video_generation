import XCTest
import MLX
@testable import LTXVideoDirector

/// Integration smoke test: load the REAL production LTX-2.3 VAE decoder
/// checkpoint (mlx-models/vae/ltx-2.3-vae/vae_decoder.safetensors, bf16,
/// "vae_decoder." key prefix) and run a real forward pass. No reference
/// output to compare against (that would need a full PyTorch/reference
/// decode pipeline) — this only proves the native Swift assembly actually
/// loads real production weights and produces finite, sane output, not
/// just synthetic-weight test data. Skips gracefully if the checkpoint
/// isn't present (e.g. CI without the external model store).
final class VideoDecoderRealCheckpointTests: XCTestCase {
    func testRealCheckpointProducesFiniteOutput() throws {
        let checkpointURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw XCTSkip("real checkpoint not found at \(checkpointURL.path) — skipping integration smoke test")
        }

        let raw = try MLX.loadArrays(url: checkpointURL)
        var weights: [String: MLXArray] = [:]
        for (key, value) in raw {
            let strippedKey = key.hasPrefix("vae_decoder.") ? String(key.dropFirst("vae_decoder.".count)) : key
            weights[strippedKey] = value.asType(.float32)
        }
        XCTAssertEqual(weights.count, 86, "expected 86 tensors in the real checkpoint")

        let decoder = VideoDecoder(weights: weights, causal: false, spatialPaddingMode: "zeros")
        // Tiny synthetic latent (real channel count 128, minimal spatial/temporal
        // extent) — proves the real weights run end-to-end without crashing or
        // producing NaN/Inf, not that the output matches any particular image.
        let latent = MLXArray.zeros([1, 128, 2, 2, 2]).asType(.float32)
        let pixels = decoder(latent)
        MLX.eval(pixels)

        XCTAssertEqual(pixels.dim(0), 1)
        XCTAssertEqual(pixels.dim(1), 3, "RGB output channels")
        XCTAssertEqual(pixels.dim(2), 9, "F=2 latent frames -> 9 pixel frames (matches the synthetic-weight parity test)")
        let flat = pixels.asArray(Float.self)
        XCTAssertTrue(flat.allSatisfy { $0.isFinite }, "real-checkpoint decode produced NaN/Inf")
    }
}
