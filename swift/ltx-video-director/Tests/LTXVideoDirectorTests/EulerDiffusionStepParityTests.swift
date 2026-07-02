import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.components.diffusion_steps.
/// EulerDiffusionStep — replays a 4-step chain (typical distilled/dasiwa
/// sampler shape) exactly as a real denoise loop would call it: each
/// step's output becomes the next step's input sample. See
/// scripts/dump_euler_step_reference.py, PLAN.md Phase 3.
final class EulerDiffusionStepParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/euler_step")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/euler_step")
    }

    func testFourStepChain() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("chain.safetensors"))
        let sigmasArray = arrays["sigmas"]!.asType(.float32)
        MLX.eval(sigmasArray)
        let sigmas = sigmasArray.asArray(Float.self)
        let numSteps = sigmas.count - 1

        var sample = arrays["initial_sample"]!

        for stepIndex in 0..<numSteps {
            let denoised = arrays["denoised_for_step\(stepIndex)"]!
            let actual = EulerDiffusionStep.step(sample: sample, denoisedSample: denoised, sigmas: sigmas, stepIndex: stepIndex)
            MLX.eval(actual)

            let expected = arrays["output_step\(stepIndex)"]!
            XCTAssertEqual(actual.shape, expected.shape)
            let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
            XCTAssertLessThan(diff, 1e-5, "step \(stepIndex) max abs diff \(diff)")

            sample = actual
        }
    }
}
