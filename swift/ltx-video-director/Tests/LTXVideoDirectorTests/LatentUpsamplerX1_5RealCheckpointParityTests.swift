import XCTest
import MLX
@testable import LTXVideoDirector

/// Real-checkpoint parity test for LatentUpsampler (spatial_x1_5 variant —
/// the rational resampler used by the 3-stage FFLF workflow's Stage #3, see
/// docs/reference/comfyui_workflows/README.md's second pass), against
/// scripts/dump_latent_upsampler_x1_5_reference.py's saved output. Sibling
/// of LatentUpsamplerRealCheckpointParityTests (spatial_x2) — same fixed
/// seed/input shape, different checkpoint/variant.
final class LatentUpsamplerX1_5RealCheckpointParityTests: XCTestCase {
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

    func testSpatialX1_5MatchesRealCheckpointReference() throws {
        let refURL = refsDir.appendingPathComponent("latent_upsampler_x1_5.safetensors")
        guard FileManager.default.fileExists(atPath: refURL.path) else {
            throw XCTSkip("latent_upsampler_x1_5.safetensors reference not found — run scripts/dump_latent_upsampler_x1_5_reference.py first")
        }
        var arrays = try MLX.loadArrays(url: refURL)
        guard let input = arrays.removeValue(forKey: "input"),
              let expected = arrays.removeValue(forKey: "output") else {
            XCTFail("missing input/output tensors")
            return
        }

        let checkpointURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/spatial_upscaler_x1_5_v1_0.safetensors")
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw XCTSkip("real spatial_upscaler_x1_5_v1_0 checkpoint not found — skipping")
        }
        let raw = try MLX.loadArrays(url: checkpointURL)
        let prefix = "spatial_upscaler_x1_5_v1_0."
        var weights: [String: MLXArray] = [:]
        for (key, value) in raw {
            let stripped = key.hasPrefix(prefix) ? String(key.dropFirst(prefix.count)) : key
            weights[stripped] = value.asType(.float32)
        }

        let upsampler = LatentUpsampler(weights: weights, variant: .spatialX1_5)
        let actual = upsampler(input.asType(.float32))
        MLX.eval(actual)

        XCTAssertEqual(actual.shape, expected.shape, "expected 1.5x spatial upscale: (1,128,2,8,8) -> (1,128,2,12,12)")
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32))
        let maxDiff = diff.max().item(Float.self)
        XCTAssertLessThan(maxDiff, 1e-3, "max abs diff \(maxDiff) exceeds tolerance (same order as the spatial_x2 parity test)")
    }
}
