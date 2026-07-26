import XCTest
import MLX
@testable import LTXVideoDirector

final class AudioConditionByReferenceLatentTests: XCTestCase {
    func testAppendsReferenceTokensWithPreservedMask() {
        let latent = MLXArray.zeros([1, 4, 2])
        let state = LatentState(
            latent: latent, cleanLatent: latent,
            denoiseMask: MLXArray.ones([1, 4, 1]),
            positions: MLXArray([Float(0.0), 1.0, 2.0, 3.0], [1, 4, 1]))
        let refLatent = MLXArray.zeros([1, 2, 2])
        let refPositions = MLXArray([Float(10.0), 11.0], [1, 2, 1])

        let conditioner = AudioConditionByReferenceLatent(
            referenceLatent: refLatent, referencePositions: refPositions,
            strength: 1.0, negativePositions: false)
        let newState = conditioner.apply(to: state)
        MLX.eval(newState.latent, newState.cleanLatent, newState.denoiseMask, newState.positions!)

        XCTAssertEqual(newState.latent.shape, [1, 6, 2])
        let mask = newState.denoiseMask.reshaped([-1]).asArray(Float.self)
        // First 4 tokens: original mask (1.0, generate). Last 2 (appended reference): mask = 0 (preserved).
        XCTAssertEqual(mask, [1, 1, 1, 1, 0, 0])
    }

    func testNegativePositionsShiftsReferenceStrictlyBeforeZero() {
        let latent = MLXArray.zeros([1, 4, 2])
        let state = LatentState(
            latent: latent, cleanLatent: latent,
            denoiseMask: MLXArray.ones([1, 4, 1]),
            positions: MLXArray([Float(0.0), 1.0, 2.0, 3.0], [1, 4, 1]))
        let refLatent = MLXArray.zeros([1, 3, 2])
        // Reference's OWN positions span [0, 5] before the shift is applied.
        let refPositions = MLXArray([Float(0.0), 2.5, 5.0], [1, 3, 1])

        let conditioner = AudioConditionByReferenceLatent(
            referenceLatent: refLatent, referencePositions: refPositions,
            strength: 1.0, negativePositions: true)
        let newState = conditioner.apply(to: state)
        MLX.eval(newState.positions!)

        let positions = newState.positions!.reshaped([-1]).asArray(Float.self)
        let appendedPositions = Array(positions[4...])
        // Shifted to end at -0.04 (max(refPositions)=5.0 -> shifted max = 5.0 - (5.0 + 0.04) = -0.04).
        let expectedPositions: [Float] = [-5.04, -2.54, -0.04]
        XCTAssertEqual(appendedPositions.count, expectedPositions.count)
        for (actual, expected) in zip(appendedPositions, expectedPositions) {
            XCTAssertEqual(actual, expected, accuracy: 1e-5)
        }
        for p in appendedPositions {
            XCTAssertLessThan(p, 0.0)
        }
    }

    func testMaskValueReflectsStrength() {
        let latent = MLXArray.zeros([1, 4, 2])
        let state = LatentState(
            latent: latent, cleanLatent: latent, denoiseMask: MLXArray.ones([1, 4, 1]),
            positions: MLXArray([Float(0.0), 1.0, 2.0, 3.0], [1, 4, 1]))
        let refLatent = MLXArray.zeros([1, 2, 2])
        let refPositions = MLXArray([Float(10.0), 11.0], [1, 2, 1])
        let conditioner = AudioConditionByReferenceLatent(
            referenceLatent: refLatent, referencePositions: refPositions,
            strength: 0.25, negativePositions: false)
        let newState = conditioner.apply(to: state)
        MLX.eval(newState.denoiseMask)
        let mask = newState.denoiseMask.reshaped([-1]).asArray(Float.self)
        XCTAssertEqual(mask, [1, 1, 1, 1, 0.75, 0.75])
    }
}
