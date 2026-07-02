import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.audio_vae.bwe.
/// HannSincResampler (see scripts/dump_hannsincresampler_reference.py,
/// PLAN.md's BWE work). Verifies BOTH the deterministically-computed
/// sinc kernel (no learned weights — recomputed from scratch in Swift,
/// not loaded) and the full forward pass (including the reshape-based
/// zero-insertion that avoids the same `.at[strided].add()` bug class
/// already found in UpSample1d).
final class HannSincResamplerParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/hannsinc")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/hannsinc")
    }

    func testKernelMatchesReference() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("hannsinc.safetensors"))
        let resampler = HannSincResampler(upsampleFactor: 3)
        let diff = MLX.abs(resampler.kernel.asType(.float32) - arrays["kernel"]!.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-5, "kernel max abs diff \(diff)")
    }

    func testForwardMatchesReference() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("hannsinc.safetensors"))
        let resampler = HannSincResampler(upsampleFactor: 3)
        let actual = resampler(arrays["input"]!)
        MLX.eval(actual)

        let expected = arrays["output"]!
        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-4, "max abs diff \(diff)")
    }
}
