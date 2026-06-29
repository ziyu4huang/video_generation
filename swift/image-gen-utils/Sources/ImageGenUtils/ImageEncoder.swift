//
//  ImageEncoder.swift
//  ImageGenUtils
//
//  Image → downscale → JPEG → base64 for the OpenAI-compatible vision API.
//  Mirrors python/mlx-movie-director/app/commands/caption.py:_image_to_base64
//  (downscale longest edge to ≤1024 px, JPEG q85, base64).
//

import CoreGraphics
import Foundation
import ImageIO

public enum ImageEncoder {
    /// Load image, downscale to ≤maxSize on the longest edge, JPEG-encode at
    /// quality 85, return base64 string. Mirrors python `_image_to_base64`.
    public static func imageToBase64JPEG(_ url: URL, maxSize: Int = 1024) throws -> String {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw CaptionError.unreadableImage(url.path)
        }
        let sourceWidth = cgImage.width
        let sourceHeight = cgImage.height
        var drawWidth = sourceWidth
        var drawHeight = sourceHeight
        if max(sourceWidth, sourceHeight) > maxSize {
            let scale = Double(maxSize) / Double(max(sourceWidth, sourceHeight))
            drawWidth = max(1, Int(Double(sourceWidth) * scale))
            drawHeight = max(1, Int(Double(sourceHeight) * scale))
        }

        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(
            data: nil, width: drawWidth, height: drawHeight,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { throw CaptionError.encodeFailed }
        ctx.interpolationQuality = .high
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: drawWidth, height: drawHeight))
        guard let drawn = ctx.makeImage() else { throw CaptionError.encodeFailed }

        let mutable = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            mutable as CFMutableData, "public.jpeg" as CFString, 1, nil
        ) else { throw CaptionError.encodeFailed }
        CGImageDestinationAddImage(dest, drawn, [
            kCGImageDestinationLossyCompressionQuality: 0.85,
        ] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw CaptionError.encodeFailed }
        return mutable.base64EncodedString()
    }
}
