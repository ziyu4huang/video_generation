import XCTest
import MLX
import MLXRandom
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

    func testSharpeningCASEdgePaddingAvoidsZeroFillBorderArtifact() {
        // A flat image: every interior pixel's 4 neighbors equal itself, so
        // CAS is a no-op everywhere the padding doesn't matter. At the
        // border, edge-replicated padding keeps the out-of-bounds "neighbor"
        // equal to the flat value too, so CAS must still be a no-op there.
        // Zero-fill padding would instead read 0 for the missing neighbor,
        // inflating local contrast and visibly darkening every border pixel
        // away from 0.6 — this test would fail under that regression.
        let image = flatGray(16, 16, value: 0.6)
        let sharpened = PostProcessFilters.sharpening(image, casStrength: 0.8)
        MLX.eval(sharpened)
        let vals = sharpened.asArray(Float.self)
        for v in vals {
            XCTAssertEqual(
                v, 0.6, accuracy: 1e-4,
                "CAS with edge-replicated padding must not perturb a flat image, including the outermost border")
        }
    }

    func testNoiseCleanerReducesFlatRegionVarianceButPreservesEdge() {
        // Left half 0.2 + noise, right half 0.8 + noise, hard edge at x=32.
        MLXRandom.seed(7)
        let h = 48, w = 64
        var raw = [Float](repeating: 0, count: 3 * h * w)
        for c in 0..<3 {
            for y in 0..<h {
                for x in 0..<w {
                    raw[c * h * w + y * w + x] = x < 32 ? 0.2 : 0.8
                }
            }
        }
        let clean = MLXArray(raw, [1, 3, h, w])
        let noise = MLXRandom.normal([1, 3, h, w]) * 0.08
        let noisy = MLX.clip(clean + noise, min: 0.0, max: 1.0)
        MLX.eval(noisy)

        let denoised = PostProcessFilters.noiseCleaner(noisy, bilateralRadius: 3, jpegScrub: false)
        MLX.eval(denoised)

        // Flat-region variance (within the left half, away from the edge)
        // should drop after denoising.
        let noisyVar = noisy[0..., 0..., 0..., 0..<20].variance().item(Float.self)
        let denoisedVar = denoised[0..., 0..., 0..., 0..<20].variance().item(Float.self)
        XCTAssertLessThan(denoisedVar, noisyVar, "bilateral filter should reduce flat-region noise variance")

        // The edge should still be there: left-half mean clearly below
        // right-half mean, not smeared into a uniform gray.
        let leftMean = MLX.mean(denoised[0..., 0..., 0..., 0..<20]).item(Float.self)
        let rightMean = MLX.mean(denoised[0..., 0..., 0..., 44..<64]).item(Float.self)
        XCTAssertLessThan(leftMean, 0.4)
        XCTAssertGreaterThan(rightMean, 0.6)
    }

    func testSkinMaskDetectsSkinToneAndExcludesSaturatedBlue() {
        let h = 32, w = 64
        var raw = [Float](repeating: 0, count: 3 * h * w)
        // Left half: a mid skin tone (R=0.85,G=0.62,B=0.48 ~ typical skin RGB).
        // Right half: saturated blue (R=0.0,G=0.0,B=0.9) ~ clearly non-skin.
        for y in 0..<h {
            for x in 0..<w {
                let (r, g, b): (Float, Float, Float) = x < 32 ? (0.85, 0.62, 0.48) : (0.0, 0.0, 0.9)
                raw[0 * h * w + y * w + x] = r
                raw[1 * h * w + y * w + x] = g
                raw[2 * h * w + y * w + x] = b
            }
        }
        let image = MLXArray(raw, [1, 3, h, w])
        MLX.eval(image)

        let mask = PostProcessFilters.skinMask(image)
        MLX.eval(mask)
        let skinRegion = MLX.mean(mask[0..., 0..., 0..., 0..<32]).item(Float.self)
        let blueRegion = MLX.mean(mask[0..., 0..., 0..., 32..<64]).item(Float.self)
        XCTAssertGreaterThan(skinRegion, 0.5, "skin-tone patch should be classified as skin")
        XCTAssertLessThan(blueRegion, 0.5, "saturated blue patch should NOT be classified as skin")
    }

    func testLABRoundTripIsNearIdentity() {
        var raw = [Float](repeating: 0, count: 3 * 16 * 16)
        for y in 0..<16 {
            for x in 0..<16 {
                raw[0 * 16 * 16 + y * 16 + x] = Float(x) / 15.0
                raw[1 * 16 * 16 + y * 16 + x] = Float(y) / 15.0
                raw[2 * 16 * 16 + y * 16 + x] = 0.5
            }
        }
        let image = MLXArray(raw, [1, 3, 16, 16])
        MLX.eval(image)

        let lab = PostProcessFilters.rgbToLAB(image)
        let roundTrip = PostProcessFilters.labToRGB(lab)
        MLX.eval(roundTrip)

        let diff = MLX.mean(MLX.abs(roundTrip - image)).item(Float.self)
        XCTAssertLessThan(diff, 0.01, "RGB->LAB->RGB should be near-identity")
    }

    func testCLAHEIncreasesLowContrastRegionSpread() {
        // A 64x64 L-channel-like single-plane image: values clustered
        // tightly around 0.5 (low contrast) in the left half, full [0,1]
        // range in the right half.
        let h = 64, w = 64
        var raw = [Float](repeating: 0, count: h * w)
        for y in 0..<h {
            for x in 0..<w {
                if x < 32 {
                    raw[y * w + x] = 0.48 + 0.04 * (Float(y) / Float(h))   // tight cluster [0.48,0.52]
                } else {
                    raw[y * w + x] = Float(y) / Float(h)                   // full spread [0,1)
                }
            }
        }
        let l = MLXArray(raw, [1, 1, h, w])
        MLX.eval(l)

        let eq = PostProcessFilters.clahe(l, clipLimit: 2.0, tileGridSize: 8)
        MLX.eval(eq)

        let leftVarBefore = l[0..., 0..., 0..., 0..<32].variance().item(Float.self)
        let leftVarAfter = eq[0..., 0..., 0..., 0..<32].variance().item(Float.self)
        XCTAssertGreaterThan(leftVarAfter, leftVarBefore, "CLAHE should spread a tightly-clustered region's contrast")

        let vals = eq.asArray(Float.self)
        XCTAssertTrue(vals.allSatisfy { $0 >= 0.0 && $0 <= 1.0 })
    }

    func testSkinContrastLeavesNonSkinRegionNearUnchanged() {
        let h = 32, w = 64
        var raw = [Float](repeating: 0, count: 3 * h * w)
        for y in 0..<h {
            for x in 0..<w {
                let (r, g, b): (Float, Float, Float) = x < 32
                    ? (0.85, 0.62, 0.48)   // skin tone, tightly clustered per-row for CLAHE to act on
                    : (0.0, 0.0, 0.9)      // saturated blue, clearly non-skin
                raw[0 * h * w + y * w + x] = r
                raw[1 * h * w + y * w + x] = g
                raw[2 * h * w + y * w + x] = b
            }
        }
        let image = MLXArray(raw, [1, 3, h, w])
        MLX.eval(image)

        let result = PostProcessFilters.skinContrast(image)
        MLX.eval(result)

        let blueDiff = MLX.mean(MLX.abs(
            result[0..., 0..., 0..., 32..<64] - image[0..., 0..., 0..., 32..<64]
        )).item(Float.self)
        XCTAssertLessThan(blueDiff, 0.02, "non-skin region should stay near-unchanged")
    }
}
