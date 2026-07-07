import XCTest
import MLX
@testable import LTXVideoDirector

/// Algebraic checks for `CFGGuidance.blend`'s formula against
/// `ltx_core_mlx.components.guiders.MultiModalGuider.calculate` (restricted
/// to the cfg_scale/stg_scale terms — modality guidance is 2c, not
/// implemented). No real checkpoint needed: these are closed-form checks on
/// small synthetic tensors, not parity against a dumped reference.
final class CFGGuidanceTests: XCTestCase {
    func testIsSTGActive() {
        XCTAssertFalse(CFGGuidance.isSTGActive(stgScale: 0.0))
        XCTAssertTrue(CFGGuidance.isSTGActive(stgScale: 1.0))
        XCTAssertTrue(CFGGuidance.isSTGActive(stgScale: -0.5))
    }

    /// stgScale=0 must drop the STG term entirely, including when
    /// `uncondPerturbed` is nil (the caller skips that forward pass) —
    /// matches the 3-arg `blend` overload exactly.
    func testSTGInactiveMatchesCFGOnlyOverload() {
        let cond = MLXArray([1.0, 2.0, 3.0] as [Float])
        let uncond = MLXArray([0.5, 0.5, 0.5] as [Float])
        let cfgOnly = CFGGuidance.blend(cond: cond, uncond: uncond, cfgScale: 5.0, rescaleScale: 0)
        let full = CFGGuidance.blend(cond: cond, uncond: uncond, uncondPerturbed: nil, cfgScale: 5.0, stgScale: 0, rescaleScale: 0)
        MLX.eval(cfgOnly, full)
        XCTAssertEqual(cfgOnly.asArray(Float.self), full.asArray(Float.self))
    }

    /// `cond + (cfgScale-1)*(cond-uncond) + stgScale*(cond-uncondPerturbed)`,
    /// no rescale — checked against manual arithmetic on plain Swift floats.
    func testCFGPlusSTGBlendMatchesManualArithmetic() {
        let condVals: [Float] = [1.0, 2.0, 3.0]
        let uncondVals: [Float] = [0.2, 0.4, 0.6]
        let perturbedVals: [Float] = [0.1, 0.1, 0.1]
        let cfgScale: Float = 5.0
        let stgScale: Float = 1.0

        let expected = zip(zip(condVals, uncondVals), perturbedVals).map { pair, p -> Float in
            let (c, u) = pair
            return c + (cfgScale - 1) * (c - u) + stgScale * (c - p)
        }

        let pred = CFGGuidance.blend(
            cond: MLXArray(condVals), uncond: MLXArray(uncondVals), uncondPerturbed: MLXArray(perturbedVals),
            cfgScale: cfgScale, stgScale: stgScale, rescaleScale: 0)
        MLX.eval(pred)

        for (a, e) in zip(pred.asArray(Float.self), expected) {
            XCTAssertEqual(a, e, accuracy: 1e-5)
        }
    }
}
