import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.audio_vae.vocoder.
/// SnakeBeta (see scripts/dump_snakebeta_reference.py, PLAN.md's vocoder work).
final class SnakeBetaParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/snakebeta")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/snakebeta")
    }

    func testSnakeBeta() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("snakebeta.safetensors"))
        let act = SnakeBeta(alpha: arrays["alpha"]!, beta: arrays["beta"]!)
        let actual = act(arrays["input"]!)
        MLX.eval(actual)

        let expected = arrays["output"]!
        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-5, "max abs diff \(diff)")
    }
}
