import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.conditioning.types.
/// latent_cond's VideoConditionByLatentIndex.apply + apply_denoise_mask —
/// the I2V conditioning mechanism (splice a conditioning image's clean
/// latent into frame 0, preserve it across the denoise loop). See
/// scripts/dump_latentcond_reference.py, PLAN.md Phase 3.
final class LatentConditioningParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/latent_cond")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/latent_cond")
    }

    func testI2VFrame0Conditioning() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("i2v_condition.safetensors"))
        let latent = arrays["latent"]!
        let cleanFull = arrays["clean_full"]!
        let tokensPerFrame = 4  // H*W = 2*2

        let state = LatentState(latent: latent, cleanLatent: latent, denoiseMask: MLXArray.ones([1, latent.dim(1), 1]))
        let frame0Clean = cleanFull[0..., 0..<tokensPerFrame, 0...]
        let conditioner = VideoConditionByLatentIndex(frameIndices: [0], cleanLatent: frame0Clean, strength: 1.0)
        let newState = conditioner.apply(to: state, spatialDims: (3, 2, 2))
        MLX.eval(newState.latent, newState.cleanLatent, newState.denoiseMask)

        func assertClose(_ actual: MLXArray, _ expected: MLXArray, tol: Float = 1e-5, line: UInt = #line) {
            XCTAssertEqual(actual.shape, expected.shape, line: line)
            let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
            XCTAssertLessThan(diff, tol, "max abs diff \(diff)", line: line)
        }

        assertClose(newState.latent, arrays["new_latent"]!)
        assertClose(newState.cleanLatent, arrays["new_clean_latent"]!)
        assertClose(newState.denoiseMask, arrays["new_denoise_mask"]!)

        let x0 = arrays["x0"]!
        let blended = applyDenoiseMask(x0: x0, cleanLatent: newState.cleanLatent, denoiseMask: newState.denoiseMask)
        MLX.eval(blended)
        assertClose(blended, arrays["blended"]!)
    }
}
