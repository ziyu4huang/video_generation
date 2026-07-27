//
//  SyntheticCameraReference.swift
//  LTXVideoDirector
//
//  Synthesizes a per-segment reference frame sequence for camera-control-LoRA
//  conditioning natively (CoreGraphics affine crop/scale — no ffmpeg), from a
//  single starting frame.
//
//  v1 supports exactly two movements — dolly_in and tilt_up. Every other
//  shot_language.camera_movement value is a no-op at the call site (callers
//  fall back to plain generation) — see isSupported().
//

import CoreGraphics

public enum CameraMovementType: String {
    case dollyIn = "dolly_in"
    case tiltUp = "tilt_up"
}

public enum SyntheticCameraReference {
    /// True for exactly the v1-supported movement strings (scene_plan's raw
    /// shot_language.camera_movement values, e.g. "dolly_in"). Callers should
    /// treat every other value (including "none", "", and any other
    /// CAMERA_MOVEMENTS entry) as "no camera-control conditioning."
    public static func isSupported(_ rawMovement: String) -> Bool {
        CameraMovementType(rawValue: rawMovement) != nil
    }

    /// Synthesize `frameCount` frames depicting `movement` applied to
    /// `startImage`, each exactly `targetWidth` x `targetHeight`. Frame 0 is
    /// the unmodified start image (aspect-fill-center-cropped to target
    /// size); the last frame is the movement's maximum extent. `frameCount`
    /// must equal the segment's own LTX frame count (8k+1) — the IC-LoRA
    /// reference-conditioning path this feeds derives the generation's
    /// output length directly from the reference clip's own frame count.
    public static func synthesize(
        startImage: CGImage, movement: CameraMovementType,
        frameCount: Int, targetWidth: Int, targetHeight: Int
    ) -> [CGImage] {
        let base = FrameLoad.resizeAspectFillCenterCrop(startImage, targetWidth: targetWidth, targetHeight: targetHeight)
        guard frameCount > 1 else { return [base] }
        return (0..<frameCount).map { i in
            let t = Double(i) / Double(frameCount - 1)
            return renderFrame(base, movement: movement, t: t, targetWidth: targetWidth, targetHeight: targetHeight)
        }
    }

    /// Exposed for tests only — the (scale, offsetXFraction, offsetYFraction)
    /// trajectory at progress `t` in [0, 1]. offsetXFraction/offsetYFraction
    /// of 0.5 = a centered crop window; 0.0/1.0 = the crop window pinned to
    /// the start/end edge of the scaled source.
    static func transformParametersForTesting(movement: CameraMovementType, t: Double) -> (scale: Double, offsetXFraction: Double, offsetYFraction: Double) {
        transformParameters(movement: movement, t: t)
    }

    private static func transformParameters(movement: CameraMovementType, t: Double) -> (scale: Double, offsetXFraction: Double, offsetYFraction: Double) {
        switch movement {
        case .dollyIn:
            // Progressive zoom-in: 1.0x -> 1.25x scale, crop window stays centered.
            return (scale: 1.0 + 0.25 * t, offsetXFraction: 0.5, offsetYFraction: 0.5)
        case .tiltUp:
            // Fixed 1.2x scale (headroom for the crop window to slide within),
            // crop window slides from the bottom of the frame toward the top.
            return (scale: 1.2, offsetXFraction: 0.5, offsetYFraction: 1.0 - t)
        }
    }

    /// Same CGContext draw-into-an-offset-rect technique as
    /// FrameLoad.resizeAspectFillCenterCrop, parameterized by `t`.
    private static func renderFrame(_ base: CGImage, movement: CameraMovementType, t: Double, targetWidth: Int, targetHeight: Int) -> CGImage {
        let (scale, offsetXFraction, offsetYFraction) = transformParameters(movement: movement, t: t)
        let dstW = Double(targetWidth), dstH = Double(targetHeight)
        let scaledW = dstW * scale, scaledH = dstH * scale
        let originX = (scaledW - dstW) * offsetXFraction
        let originY = (scaledH - dstH) * offsetYFraction

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        guard let ctx = CGContext(
            data: nil, width: targetWidth, height: targetHeight, bitsPerComponent: 8,
            bytesPerRow: targetWidth * 4, space: colorSpace, bitmapInfo: bitmapInfo
        ) else { return base }
        ctx.interpolationQuality = .high
        ctx.draw(base, in: CGRect(x: -originX, y: -originY, width: scaledW, height: scaledH))
        return ctx.makeImage() ?? base
    }
}
