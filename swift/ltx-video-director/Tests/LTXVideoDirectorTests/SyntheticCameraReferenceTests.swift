import XCTest
import CoreGraphics
import MLX
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

    /// A 64x64 image split into a black top half and a white bottom half —
    /// unlike `makeTestImage`'s uniform solid color, this has content that
    /// actually differs across the vertical crop window tilt_up slides
    /// through, so a pixel comparison can distinguish "movement's own t=0
    /// transform was applied" from "the plain centered base frame was
    /// returned untransformed."
    private func makeVerticalSplitTestImage(width: Int = 64, height: Int = 64) -> CGImage {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo)!
        ctx.setFillColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: height / 2, width: width, height: height - height / 2))
        ctx.setFillColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height / 2))
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

    /// Regression test: a frameCount<=1 request must still apply the
    /// movement's own t=0 transform, not silently fall back to the plain
    /// centered base frame. tilt_up's t=0 is scale=1.2/offsetYFraction=1.0
    /// (bottom-anchored), which is NOT pixel-identical to a plain
    /// aspect-fill-center-crop (scale=1.0/centered) of the same source —
    /// so a real geometric difference is a reliable signal here (dolly_in's
    /// t=0 happens to equal the plain center crop exactly, which is why this
    /// test must use tilt_up, not dolly_in, to catch the bug).
    func testSynthesizeSingleFrameAppliesMovementOwnTransformNotPlainCenterCrop() {
        let img = makeVerticalSplitTestImage()
        let frames = SyntheticCameraReference.synthesize(
            startImage: img, movement: .tiltUp, frameCount: 1, targetWidth: 64, targetHeight: 64)
        XCTAssertEqual(frames.count, 1)

        let synthesizedArr = FrameLoad.toArray(frames[0])
        let plainCenterCropArr = FrameLoad.toArray(
            FrameLoad.resizeAspectFillCenterCrop(img, targetWidth: 64, targetHeight: 64))
        let diff = MLX.mean(MLX.abs(synthesizedArr - plainCenterCropArr)).item(Float.self)
        XCTAssertGreaterThan(
            diff, 0.01,
            "tilt_up frameCount=1 must render the movement's own bottom-anchored, " +
            "1.2x-scaled t=0 frame, not the plain centered base frame (mean abs diff \(diff))")
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
