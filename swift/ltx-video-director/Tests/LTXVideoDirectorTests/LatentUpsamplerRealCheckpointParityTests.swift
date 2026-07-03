import XCTest
import MLX
@testable import LTXVideoDirector

/// Real-checkpoint parity test for LatentUpsampler (spatial_x2 variant),
/// against scripts/dump_latent_upsampler_reference.py's saved output — the
/// real production spatial_upscaler_x2_v1_1.safetensors checkpoint run on a
/// fixed-seed (1, 128, 2, 8, 8) latent. Skips gracefully if the reference
/// dump hasn't been generated (checkpoint not present when the dump script
/// last ran).
final class LatentUpsamplerRealCheckpointParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/latent_upsampler")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/latent_upsampler")
    }

    func testSpatialX2MatchesRealCheckpointReference() throws {
        let refURL = refsDir.appendingPathComponent("latent_upsampler.safetensors")
        guard FileManager.default.fileExists(atPath: refURL.path) else {
            throw XCTSkip("latent_upsampler.safetensors reference not found — run scripts/dump_latent_upsampler_reference.py first")
        }
        var arrays = try MLX.loadArrays(url: refURL)
        guard let input = arrays.removeValue(forKey: "input"),
              let expected = arrays.removeValue(forKey: "output") else {
            XCTFail("missing input/output tensors")
            return
        }

        let checkpointURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors")
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw XCTSkip("real spatial_upscaler_x2_v1_1 checkpoint not found — skipping")
        }
        let raw = try MLX.loadArrays(url: checkpointURL)
        let prefix = "spatial_upscaler_x2_v1_1."
        var weights: [String: MLXArray] = [:]
        for (key, value) in raw {
            let stripped = key.hasPrefix(prefix) ? String(key.dropFirst(prefix.count)) : key
            weights[stripped] = value.asType(.float32)
        }

        let upsampler = LatentUpsampler(weights: weights)
        let actual = upsampler(input.asType(.float32))
        MLX.eval(actual)

        XCTAssertEqual(actual.shape, expected.shape, "expected 2x spatial upscale: (1,128,2,8,8) -> (1,128,2,16,16)")
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32))
        let maxDiff = diff.max().item(Float.self)
        XCTAssertLessThan(maxDiff, 1e-3, "max abs diff \(maxDiff) exceeds tolerance (both sides compute in fp32 from the same bf16 checkpoint — 8-stage Conv3d/Conv2d assembly, matches VideoDecoderParityTests' tolerance)")
    }
}
