import XCTest
@testable import LTXVideoDirector

final class ResolutionResolverTests: XCTestCase {
    func testAlreadyAlignedIsUnchanged() {
        let r = ResolutionResolver.optimize(width: 640, height: 960)
        XCTAssertEqual(r.width, 640)
        XCTAssertEqual(r.height, 960)
    }

    func testRoundsDownWhenCloserToLowerMultiple() {
        // 641 is 1 above 640 (nearest) vs 32 below 672 — rounds down.
        let r = ResolutionResolver.optimize(width: 641, height: 950)
        XCTAssertEqual(r.width, 640)
        XCTAssertEqual(r.height, 960)
    }

    func testRoundsUpWhenCloserToUpperMultiple() {
        // 657 is 17 above 640 and 15 below 672 — rounds up.
        let r = ResolutionResolver.optimize(width: 657, height: 977)
        XCTAssertEqual(r.width, 672)
        XCTAssertEqual(r.height, 992)
    }

    func testBelowValidatedAreaScalesUpPreservingAspectRatio() {
        // 656x656 (area 430336) is below minimumValidatedArea (614400) —
        // gets scaled up (preserving 1:1 aspect) before snapping, instead of
        // just snapping in place.
        let r = ResolutionResolver.optimize(width: 656, height: 656)
        XCTAssertEqual(r.width, r.height, "1:1 input should stay 1:1 after aspect-preserving scale-up")
        XCTAssertGreaterThan(r.width * r.height, ResolutionResolver.minimumValidatedArea)
    }

    func testWellBelowValidatedAreaScalesUpNotJustSnapped() {
        // Regression test for the real-world native-i2v finding (2026-07-03):
        // 384x576 (same 2:3 aspect as modelOptimalDefault, just smaller)
        // produced frames that progressively corrupted over a multi-frame
        // streaming denoise run, while 640x960 stayed clean. optimize() must
        // scale this up to at least the validated area, not just snap it to
        // the nearest 32-multiple of the original (too-small) request.
        let r = ResolutionResolver.optimize(width: 384, height: 576)
        XCTAssertGreaterThanOrEqual(r.width * r.height, ResolutionResolver.minimumValidatedArea)
        XCTAssertGreaterThan(r.width, 384)
        XCTAssertGreaterThan(r.height, 576)
        // 2:3 aspect ratio preserved within one snap step's rounding error.
        let aspect = Double(r.width) / Double(r.height)
        XCTAssertEqual(aspect, 2.0 / 3.0, accuracy: 0.05)
    }

    func testMinimumValidatedAreaMatchesModelOptimalDefault() {
        XCTAssertEqual(
            ResolutionResolver.minimumValidatedArea,
            ResolutionResolver.modelOptimalDefault.width * ResolutionResolver.modelOptimalDefault.height)
    }

    func testTinyInputScalesUpToValidatedArea() {
        let r = ResolutionResolver.optimize(width: 10, height: 5)
        // Post-scale-up area can land a hair under minimumValidatedArea after
        // snapping down to the nearest 32-multiple — allow that rounding slack.
        XCTAssertGreaterThan(Double(r.width * r.height), Double(ResolutionResolver.minimumValidatedArea) * 0.98)
        XCTAssertGreaterThan(r.width, r.height, "2:1 input should stay wider than tall after scale-up")
    }

    func testResultAlwaysDivisibleBySpatialScale() {
        for w in stride(from: 33, through: 2000, by: 47) {
            for h in stride(from: 33, through: 2000, by: 53) {
                let r = ResolutionResolver.optimize(width: w, height: h)
                XCTAssertEqual(r.width % ResolutionResolver.spatialScale, 0, "width \(w) -> \(r.width)")
                XCTAssertEqual(r.height % ResolutionResolver.spatialScale, 0, "height \(h) -> \(r.height)")
            }
        }
    }
}
