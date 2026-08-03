import XCTest
import MLX
@testable import Flux2Director

final class PostProcessFiltersTests: XCTestCase {
    private func flatGray(_ h: Int = 64, _ w: Int = 64, value: Float = 0.5) -> MLXArray {
        let img = MLXArray(Array(repeating: value, count: 3 * h * w), [1, 3, h, w])
        MLX.eval(img)
        return img
    }

    func testFilmGrainIncreasesVariance() {
        let image = flatGray()
        let result = PostProcessFilters.filmGrain(image, intensity: 0.05, seed: 42)
        MLX.eval(result)
        let inputVar = image.variance().item(Float.self)
        let outputVar = result.variance().item(Float.self)
        XCTAssertGreaterThan(outputVar, inputVar, "adding Gaussian noise should raise pixel variance")
        // Mean should stay close to the original flat value (noise is zero-mean).
        let outputMean = MLX.mean(result).item(Float.self)
        XCTAssertEqual(outputMean, 0.5, accuracy: 0.02)
    }

    func testFilmGrainTemperatureShiftsChannelsApart() {
        let image = flatGray()
        let result = PostProcessFilters.filmGrain(image, intensity: 0.0, temperature: 0.1, seed: 42)
        MLX.eval(result)
        let rMean = MLX.mean(result[0..., 0..<1, 0..., 0...]).item(Float.self)
        let bMean = MLX.mean(result[0..., 2..<3, 0..., 0...]).item(Float.self)
        XCTAssertGreaterThan(rMean, bMean, "positive temperature should warm (raise R, lower B)")
    }

    func testFilmGrainVignetteDarkensCorners() {
        let image = flatGray(128, 128, value: 0.8)
        let result = PostProcessFilters.filmGrain(image, intensity: 0.0, vignette: 0.6, seed: 42)
        MLX.eval(result)
        let center = MLX.mean(result[0..., 0..., 60..<68, 60..<68]).item(Float.self)
        let corner = MLX.mean(result[0..., 0..., 0..<8, 0..<8]).item(Float.self)
        XCTAssertLessThan(corner, center, "vignette should darken corners more than the center")
    }

    func testUnsharpMaskIncreasesEdgeContrast() {
        // A soft vertical step edge: left half 0.2, right half 0.8, pre-blurred
        // slightly so there's something for unsharp to sharpen.
        var raw = [Float](repeating: 0, count: 3 * 64 * 64)
        for c in 0..<3 {
            for y in 0..<64 {
                for x in 0..<64 {
                    raw[c * 64 * 64 + y * 64 + x] = x < 32 ? 0.2 : 0.8
                }
            }
        }
        let step = MLXArray(raw, [1, 3, 64, 64])
        MLX.eval(step)
        let blurred = PostProcessFilters.gaussianBlurRGB(step, sigma: 2.0)
        let sharpened = PostProcessFilters.unsharpMask(blurred, radius: 3, amount: 1.0)
        MLX.eval(sharpened)

        // Contrast across the edge (col 30 vs col 33) should be higher after
        // unsharp than in the blurred input.
        let blurredContrast = abs(
            MLX.mean(blurred[0..., 0..., 0..., 30..<31]).item(Float.self)
            - MLX.mean(blurred[0..., 0..., 0..., 33..<34]).item(Float.self))
        let sharpContrast = abs(
            MLX.mean(sharpened[0..., 0..., 0..., 30..<31]).item(Float.self)
            - MLX.mean(sharpened[0..., 0..., 0..., 33..<34]).item(Float.self))
        XCTAssertGreaterThan(sharpContrast, blurredContrast)
    }

    func testSharpeningCASIncreasesLocalContrastAcrossEdge() {
        // Softly blurred step edge (0.3 -> 0.7), like the unsharp test above.
        var raw = [Float](repeating: 0, count: 3 * 32 * 32)
        for c in 0..<3 {
            for y in 0..<32 {
                for x in 0..<32 {
                    let base: Float = x < 16 ? 0.3 : 0.7
                    raw[c * 32 * 32 + y * 32 + x] = base
                }
            }
        }
        let step = MLXArray(raw, [1, 3, 32, 32])
        let blurred = PostProcessFilters.gaussianBlurRGB(step, sigma: 1.5)
        MLX.eval(blurred)

        let sharpened = PostProcessFilters.sharpening(blurred, casStrength: 0.8)
        MLX.eval(sharpened)

        XCTAssertEqual(sharpened.dim(2), blurred.dim(2))
        XCTAssertEqual(sharpened.dim(3), blurred.dim(3))
        let vals = sharpened.asArray(Float.self)
        XCTAssertTrue(vals.allSatisfy { $0 >= 0.0 && $0 <= 1.0 }, "CAS output must stay in [0,1]")

        let blurredContrast = abs(
            MLX.mean(blurred[0..., 0..., 0..., 13..<14]).item(Float.self)
            - MLX.mean(blurred[0..., 0..., 0..., 18..<19]).item(Float.self))
        let sharpContrast = abs(
            MLX.mean(sharpened[0..., 0..., 0..., 13..<14]).item(Float.self)
            - MLX.mean(sharpened[0..., 0..., 0..., 18..<19]).item(Float.self))
        XCTAssertGreaterThan(sharpContrast, blurredContrast)
    }
}
