import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against `ltx_core_mlx.conditioning.types.
/// reference_video_cond.VideoConditionByReferenceLatent.apply` — the
/// IC-LoRA reference-conditioning mechanism `NativeUpscaleStage.generateHD`
/// uses. See scripts/dump_reference_conditioning.py.
final class VideoConditionByReferenceLatentParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/reference_conditioning")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/reference_conditioning")
    }

    func testAppendWithDownscaledPositions() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("reference_condition.safetensors"))
        let latent = arrays["latent"]!
        let positions = arrays["positions"]!
        let referenceLatent = arrays["reference_latent"]!
        let referencePositions = arrays["reference_positions"]!

        let state = LatentState(
            latent: latent, cleanLatent: latent,
            denoiseMask: MLXArray.ones([1, latent.dim(1), 1]), positions: positions)
        let conditioner = VideoConditionByReferenceLatent(
            referenceLatent: referenceLatent, referencePositions: referencePositions,
            downscaleFactor: 2, strength: 1.0)
        let newState = conditioner.apply(to: state)
        MLX.eval(newState.latent, newState.cleanLatent, newState.denoiseMask, newState.positions!)

        func assertClose(_ actual: MLXArray, _ expected: MLXArray, tol: Float = 1e-5, line: UInt = #line) {
            XCTAssertEqual(actual.shape, expected.shape, line: line)
            let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
            XCTAssertLessThan(diff, tol, "max abs diff \(diff)", line: line)
        }

        assertClose(newState.latent, arrays["new_latent"]!)
        assertClose(newState.cleanLatent, arrays["new_clean_latent"]!)
        assertClose(newState.denoiseMask, arrays["new_denoise_mask"]!)
        assertClose(newState.positions!, arrays["new_positions"]!)
    }

    func testMaskValueReflectsStrength() {
        let latent = MLXArray.zeros([1, 4, 2])
        let state = LatentState(latent: latent, cleanLatent: latent, denoiseMask: MLXArray.ones([1, 4, 1]))
        let refLatent = MLXArray.zeros([1, 2, 2])
        let conditioner = VideoConditionByReferenceLatent(referenceLatent: refLatent, strength: 0.25)
        let newState = conditioner.apply(to: state)
        MLX.eval(newState.denoiseMask)
        // First 4 tokens: original mask (1.0, generate). Last 2 (appended
        // reference): mask = 1 - strength = 0.75.
        let mask = newState.denoiseMask.reshaped([-1]).asArray(Float.self)
        XCTAssertEqual(mask, [1, 1, 1, 1, 0.75, 0.75])
    }

    func testNoPositionsWhenEitherSideMissing() {
        let latent = MLXArray.zeros([1, 4, 2])
        let state = LatentState(latent: latent, cleanLatent: latent, denoiseMask: MLXArray.ones([1, 4, 1]), positions: nil)
        let refLatent = MLXArray.zeros([1, 2, 2])
        let conditioner = VideoConditionByReferenceLatent(referenceLatent: refLatent, referencePositions: MLXArray.zeros([1, 2, 3]))
        let newState = conditioner.apply(to: state)
        XCTAssertNil(newState.positions)
    }
}
