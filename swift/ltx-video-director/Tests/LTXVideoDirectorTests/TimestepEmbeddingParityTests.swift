import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against mlx_arsenal.diffusion's
/// get_timestep_embedding + TimestepEmbedding MLP (re-exported by
/// ltx_core_mlx.model.transformer.timestep_embedding). See
/// scripts/dump_timestep_embedding_reference.py, PLAN.md Phase 2.
final class TimestepEmbeddingParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/timestep_embedding")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/timestep_embedding")
    }

    func testSinusoidalAndMLP() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("timestep_embedding.safetensors"))
        guard let timesteps = arrays["timesteps"], let expectedSinusoidal = arrays["sinusoidal"],
              let expectedMLPOut = arrays["mlp_output"] else {
            XCTFail("missing tensors")
            return
        }

        let sinusoidal = TimestepEmbedding.sinusoidal(timesteps: timesteps, embeddingDim: 16)
        MLX.eval(sinusoidal)
        XCTAssertEqual(sinusoidal.shape, expectedSinusoidal.shape)
        let sinDiff = MLX.abs(sinusoidal.asType(.float32) - expectedSinusoidal.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(sinDiff, 1e-4, "sinusoidal max abs diff \(sinDiff)")

        let embedder = TimestepEmbedder(
            linear1Weight: arrays["linear1.weight"]!, linear1Bias: arrays["linear1.bias"]!,
            linear2Weight: arrays["linear2.weight"]!, linear2Bias: arrays["linear2.bias"]!)
        let mlpOut = embedder(sinusoidal)
        MLX.eval(mlpOut)
        XCTAssertEqual(mlpOut.shape, expectedMLPOut.shape)
        let mlpDiff = MLX.abs(mlpOut.asType(.float32) - expectedMLPOut.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(mlpDiff, 1e-4, "mlp output max abs diff \(mlpDiff)")
    }
}
