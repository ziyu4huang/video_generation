import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.audio_vae.vocoder's
/// DownSample1d/UpSample1d/Activation1d (see
/// scripts/dump_activation1d_reference.py, PLAN.md's vocoder work). The
/// UpSample1d test specifically exercises the reshape-based zero-
/// interleaving (see Activation1d.swift's header on why it avoids strided
/// assignment).
final class Activation1dParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/activation1d")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/activation1d")
    }

    private func assertClose(_ actual: MLXArray, _ expected: MLXArray, tol: Float = 1e-4, line: UInt = #line) {
        XCTAssertEqual(actual.shape, expected.shape, line: line)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, tol, "max abs diff \(diff)", line: line)
    }

    func testDownSample1d() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("downsample.safetensors"))
        let down = DownSample1d(lowpass: LowPassKernel(filter: arrays["filter"]!))
        let actual = down(arrays["input"]!)
        MLX.eval(actual)
        assertClose(actual, arrays["output"]!)
    }

    func testUpSample1d() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("upsample.safetensors"))
        let up = UpSample1d(filter: arrays["filter"]!)
        let actual = up(arrays["input"]!)
        MLX.eval(actual)
        assertClose(actual, arrays["output"]!)
    }

    func testFullActivation1d() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("activation1d.safetensors"))
        let act1d = Activation1d(
            act: SnakeBeta(alpha: arrays["act.alpha"]!, beta: arrays["act.beta"]!),
            upsample: UpSample1d(filter: arrays["upsample.filter"]!),
            downsample: DownSample1d(lowpass: LowPassKernel(filter: arrays["downsample.lowpass.filter"]!)))
        let actual = act1d(arrays["input"]!)
        MLX.eval(actual)
        assertClose(actual, arrays["output"]!)
    }
}
