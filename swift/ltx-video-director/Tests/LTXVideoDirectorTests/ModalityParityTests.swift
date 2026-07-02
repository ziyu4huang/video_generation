import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.transformer.modality.
/// Modality.split — batch-offset slicing used by guidance code (cond/neg/
/// ptb/mod batching). See scripts/dump_modality_reference.py, PLAN.md Phase 2.
final class ModalityParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/modality")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/modality")
    }

    func testSplitIntoGuidanceBatches() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("split.safetensors"))
        let modality = Modality(
            latent: arrays["latent"]!, sigma: arrays["sigma"]!, timesteps: arrays["timesteps"]!,
            positions: arrays["positions"]!, context: arrays["context"]!)

        let parts = modality.split(sizes: [2, 3, 1])
        XCTAssertEqual(parts.count, 3)

        for (i, part) in parts.enumerated() {
            MLX.eval(part.latent, part.sigma, part.timesteps, part.positions, part.context)
            for (field, actual) in [
                ("latent", part.latent), ("sigma", part.sigma), ("timesteps", part.timesteps),
                ("positions", part.positions), ("context", part.context),
            ] {
                let expected = arrays["part\(i)_\(field)"]!
                XCTAssertEqual(actual.shape, expected.shape, "part\(i).\(field) shape")
                let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
                XCTAssertEqual(diff, 0, accuracy: 1e-6, "part\(i).\(field) max abs diff \(diff)")
            }
        }
    }
}
