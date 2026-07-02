import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.transformer.adaln.
/// AdaLayerNormSingle (see scripts/dump_adaln_reference.py, PLAN.md Phase 2).
final class AdaLayerNormSingleParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/adaln")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/adaln")
    }

    func testAdaLayerNormSingle() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("adaln.safetensors"))
        guard let timestepEmb = arrays["timestep_emb"],
              let expectedParams = arrays["params"], let expectedEmbedded = arrays["embedded"] else {
            XCTFail("missing tensors")
            return
        }

        let embedder = TimestepEmbedder(
            linear1Weight: arrays["emb.timestep_embedder.linear1.weight"]!,
            linear1Bias: arrays["emb.timestep_embedder.linear1.bias"]!,
            linear2Weight: arrays["emb.timestep_embedder.linear2.weight"]!,
            linear2Bias: arrays["emb.timestep_embedder.linear2.bias"]!)
        let adaln = AdaLayerNormSingle(
            emb: embedder, linearWeight: arrays["linear.weight"]!, linearBias: arrays["linear.bias"]!)

        let (params, embedded) = adaln(timestepEmb)
        MLX.eval(params, embedded)

        XCTAssertEqual(params.shape, expectedParams.shape)
        let paramsDiff = MLX.abs(params.asType(.float32) - expectedParams.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(paramsDiff, 1e-4, "params max abs diff \(paramsDiff)")

        XCTAssertEqual(embedded.shape, expectedEmbedded.shape)
        let embeddedDiff = MLX.abs(embedded.asType(.float32) - expectedEmbedded.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(embeddedDiff, 1e-4, "embedded max abs diff \(embeddedDiff)")
    }
}
