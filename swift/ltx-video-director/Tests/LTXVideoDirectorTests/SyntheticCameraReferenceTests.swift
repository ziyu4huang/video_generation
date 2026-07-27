import XCTest
import CoreGraphics
@testable import LTXVideoDirector

/// Fast, no-checkpoint contract tests for the synthetic reference-clip
/// generator — verifies frame count and the direction of the crop-window/
/// scale trajectory, not visual quality (that's a manual real-generation
/// verification step elsewhere in the plan, not part of this task).
final class SyntheticCameraReferenceTests: XCTestCase {
    /// A 64x64 solid-color CGImage — content doesn't matter, only geometry.
    private func makeTestImage(width: Int = 64, height: Int = 64) -> CGImage {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo)!
        ctx.setFillColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage()!
    }

    func testSynthesizeReturnsExactlyRequestedFrameCount() {
        let img = makeTestImage()
        let frames = SyntheticCameraReference.synthesize(
            startImage: img, movement: .dollyIn, frameCount: 25, targetWidth: 64, targetHeight: 64)
        XCTAssertEqual(frames.count, 25)
        for frame in frames {
            XCTAssertEqual(frame.width, 64)
            XCTAssertEqual(frame.height, 64)
        }
    }

    func testSynthesizeSingleFrameReturnsOneFrame() {
        let img = makeTestImage()
        let frames = SyntheticCameraReference.synthesize(
            startImage: img, movement: .tiltUp, frameCount: 1, targetWidth: 64, targetHeight: 64)
        XCTAssertEqual(frames.count, 1)
    }

    /// dolly_in: the drawn image rect must strictly grow (relative to the
    /// target canvas) from frame 0 to the last frame — a zoom-in.
    func testDollyInScaleGrowsMonotonically() {
        let img = makeTestImage()
        let scales = (0..<9).map { SyntheticCameraReference.transformParametersForTesting(movement: .dollyIn, t: Double($0) / 8.0).scale }
        for i in 1..<scales.count {
            XCTAssertGreaterThan(scales[i], scales[i - 1], "scale must strictly increase frame over frame for dolly_in")
        }
        XCTAssertEqual(scales[0], 1.0, accuracy: 1e-9)
    }

    /// tilt_up: the crop-window's vertical offset fraction must move from the
    /// bottom of the frame (1.0) toward the top (0.0) as t increases.
    func testTiltUpOffsetMovesFromBottomToTop() {
        let first = SyntheticCameraReference.transformParametersForTesting(movement: .tiltUp, t: 0.0)
        let last = SyntheticCameraReference.transformParametersForTesting(movement: .tiltUp, t: 1.0)
        XCTAssertEqual(first.offsetYFraction, 1.0, accuracy: 1e-9)
        XCTAssertEqual(last.offsetYFraction, 0.0, accuracy: 1e-9)
    }

    func testIsSupportedRecognizesOnlyV1Movements() {
        XCTAssertTrue(SyntheticCameraReference.isSupported("dolly_in"))
        XCTAssertTrue(SyntheticCameraReference.isSupported("tilt_up"))
        XCTAssertFalse(SyntheticCameraReference.isSupported("pan_right"))
        XCTAssertFalse(SyntheticCameraReference.isSupported("orbital"))
        XCTAssertFalse(SyntheticCameraReference.isSupported("none"))
        XCTAssertFalse(SyntheticCameraReference.isSupported(""))
    }
}
