//
//  Upscaler.swift
//  ImageGenUtils
//
//  Basic image upscaler using CoreImage's Lanczos resampling (high-quality,
//  no model weights, ~instant). This is the Swift counterpart of python's
//  ESRGAN "fast pixel" path — useful for clean results without loading a
//  diffusion or ESRGAN model.
//
//  Scope note: python `run.py upscale` also offers SeedVR2 (AI diffusion
//  upscale that synthesizes realistic detail) and an ESRGAN RealPLKSR model
//  (learned 4× upscale). Those require MLX model weights and are deferred —
//  this Lanczos upscaler is the always-available baseline. A future MLX
//  RealPLKSR implementation can slot in behind the same `Upscaler.scale()`
//  interface with a `method: .realplksr` case.
//

import CoreGraphics
import CoreImage
import Foundation
import ImageIO

public enum UpscaleMethod: String, Sendable {
    /// CoreImage Lanczos — no weights, instant, good for clean sources.
    case lanczos
}

public enum Upscaler {

    /// Upscale an image by an integer factor (e.g. 4 → 4×).
    /// Output is written as PNG next to the input (or at `output`).
    ///
    /// - Parameters:
    ///   - input: source image path.
    ///   - factor: scale factor (2, 3, 4, ...).
    ///   - output: optional explicit output path.
    ///   - method: upscaling method (currently `.lanczos` only).
    /// - Returns: the output path written.
    @discardableResult
    public static func scale(
        input: URL, factor: Double, output: URL? = nil,
        method: UpscaleMethod = .lanczos
    ) throws -> URL {
        precondition(factor > 1.0, "factor must be > 1.0")
        let cgImage = try loadCGImage(input)
        let scaled = applyLanczos(
            cgImage,
            targetWidth: Int(Double(cgImage.width) * factor),
            targetHeight: Int(Double(cgImage.height) * factor)
        )
        return try writePNG(scaled, input: input, output: output, suffix: "_\(Int(factor))x")
    }

    /// Upsscale an image to an explicit target dimension (longest edge).
    @discardableResult
    public static func scaleToLongestEdge(
        input: URL, longestEdge: Int, output: URL? = nil,
        method: UpscaleMethod = .lanczos
    ) throws -> URL {
        precondition(longestEdge > 0, "longestEdge must be > 0")
        let cgImage = try loadCGImage(input)
        let srcW = cgImage.width
        let srcH = cgImage.height
        let srcLongest = max(srcW, srcH)
        let factor = Double(longestEdge) / Double(srcLongest)
        // Only upscale; if the source already meets/exceeds the target, copy.
        guard factor > 1.0 else {
            return try writePNG(cgImage, input: input, output: output, suffix: "_\(longestEdge)px")
        }
        let scaled = applyLanczos(
            cgImage,
            targetWidth: Int(Double(srcW) * factor),
            targetHeight: Int(Double(srcH) * factor)
        )
        return try writePNG(scaled, input: input, output: output, suffix: "_\(longestEdge)px")
    }

    // MARK: - Internals

    /// Load an image file as a CGImage.
    private static func loadCGImage(_ url: URL) throws -> CGImage {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw UpscaleError.unreadableImage(url.path)
        }
        return cg
    }

    /// Apply CILanczosScaleTransform to reach an exact target size.
    private static func applyLanczos(
        _ image: CGImage, targetWidth: Int, targetHeight: Int
    ) -> CGImage {
        let ci = CIImage(cgImage: image)
        // CILanczosScaleTransform takes a single scale + aspect ratio; compute
        // the scale from width and let aspect ratio correct height.
        let scale = Double(targetWidth) / Double(image.width)
        let aspectRatio = Double(targetHeight) / Double(targetWidth) * Double(image.width) / Double(image.height)
        let filter = CIFilter(name: "CILanczosScaleTransform")!
        filter.setValue(ci, forKey: kCIInputImageKey)
        filter.setValue(scale, forKey: kCIInputScaleKey)
        filter.setValue(aspectRatio, forKey: kCIInputAspectRatioKey)
        guard let output = filter.outputImage else {
            // Fallback: CGContext redraw if Lanczos is unavailable.
            return redraw(image, width: targetWidth, height: targetHeight)
        }
        let context = CIContext()
        guard let rendered = context.createCGImage(output, from: output.extent) else {
            return redraw(image, width: targetWidth, height: targetHeight)
        }
        return rendered
    }

    /// CGContext fallback (bicubic-equivalent) if the Lanczos filter is missing.
    private static func redraw(_ image: CGImage, width: Int, height: Int) -> CGImage {
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: cs,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return image
        }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage() ?? image
    }

    /// Write a CGImage as PNG, deriving a default output path from the input
    /// when none is supplied (mirrors python's `<base>_4x<ext>` convention).
    private static func writePNG(
        _ image: CGImage, input: URL, output: URL?, suffix: String
    ) throws -> URL {
        let dest = output ?? defaultOutput(input: input, suffix: suffix)
        try FileManager.default.createDirectory(
            at: dest.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        guard let imageDest = CGImageDestinationCreateWithURL(
            dest as CFURL, "public.png" as CFString, 1, nil
        ) else {
            throw UpscaleError.encodeFailed
        }
        CGImageDestinationAddImage(imageDest, image, nil)
        guard CGImageDestinationFinalize(imageDest) else {
            throw UpscaleError.encodeFailed
        }
        return dest
    }

    /// `<input>_<suffix>.png` in the SAME directory as the input — drop the
    /// original extension, force PNG output. Mirrors python's `<base>_4x<ext>`.
    private static func defaultOutput(input: URL, suffix: String) -> URL {
        let baseName = input.deletingPathExtension().lastPathComponent
        let dir = input.deletingLastPathComponent()
        return dir.appendingPathComponent("\(baseName)\(suffix).png")
    }
}

public enum UpscaleError: Error, CustomStringConvertible {
    case unreadableImage(String)
    case encodeFailed

    public var description: String {
        switch self {
        case .unreadableImage(let path): return "cannot read image: \(path)"
        case .encodeFailed: return "failed to PNG-encode the upscaled image"
        }
    }
}
