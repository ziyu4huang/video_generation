//
//  ImageSave.swift
//  ZImageDirector
//
//  Phase 5: save a (1, 3, H, W) float32 [0,1] MLX array to PNG via CoreGraphics.
//

import Foundation
import MLX
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers

public enum ImageSave {

    /// Save `image` (1, 3, H, W) float32 in [0,1] to a PNG file.
    public static func savePNG(_ image: MLXArray, to url: URL) throws {
        let dims = image.shape
        precondition(dims.count == 4 && dims[0] == 1 && dims[1] == 3,
                     "expected (1, 3, H, W), got \(dims)")
        let height = dims[2]
        let width = dims[3]

        // Build RGBA uint8 bitmap (CHW → interleaved RGBA).
        let flat = image.reshaped([3, height, width]).asType(.float32)
        MLX.eval(flat)
        let rArr = flat[0].asArray(Float.self)
        let gArr = flat[1].asArray(Float.self)
        let bArr = flat[2].asArray(Float.self)

        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        for idx in 0..<(width * height) {
            let outIdx = idx * 4
            rgba[outIdx]     = UInt8(max(0, min(255, rArr[idx] * 255)))
            rgba[outIdx + 1] = UInt8(max(0, min(255, gArr[idx] * 255)))
            rgba[outIdx + 2] = UInt8(max(0, min(255, bArr[idx] * 255)))
            rgba[outIdx + 3] = 255
        }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        // kCGImageAlphaNoneSkipLast = RGBX (RGB + ignored byte) → .noneSkipLast
        let alphaInfo = CGImageAlphaInfo.noneSkipLast.rawValue
        let orderInfo = CGBitmapInfo.byteOrder32Big.rawValue
        let bitmapInfo = CGBitmapInfo(rawValue: alphaInfo | orderInfo)
        let provider = CGDataProvider(data: Data(rgba) as CFData)!
        guard let cgImage = CGImage(
            width: width, height: height,
            bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
            space: colorSpace, bitmapInfo: bitmapInfo,
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        ) else {
            throw NSError(domain: "ImageSave", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "CGImage creation failed"])
        }

        var fileURL = url
        if fileURL.pathExtension.lowercased() != "png" {
            fileURL = fileURL.appendingPathExtension("png")
        }
        guard let dest = CGImageDestinationCreateWithURL(
            fileURL as CFURL, UTType.png.identifier as CFString, 1, nil
        ) else {
            throw NSError(domain: "ImageSave", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "CGImageDestination creation failed"])
        }
        CGImageDestinationAddImage(dest, cgImage, nil)
        guard CGImageDestinationFinalize(dest) else {
            throw NSError(domain: "ImageSave", code: 3, userInfo: [NSLocalizedDescriptionKey: "PNG write failed"])
        }
    }

    /// Save `rgb` (1, 3, H, W) float32 [0,1] + `alpha` (1, 1, H, W) float32
    /// [0,1] to a real RGBA PNG file. Unlike `savePNG` (always opaque,
    /// `.noneSkipLast`), this writes `.last` — a genuine alpha channel.
    public static func savePNGRGBA(rgb: MLXArray, alpha: MLXArray, to url: URL) throws {
        let dims = rgb.shape
        precondition(dims.count == 4 && dims[0] == 1 && dims[1] == 3,
                     "expected rgb (1, 3, H, W), got \(dims)")
        let height = dims[2]
        let width = dims[3]
        precondition(alpha.shape == [1, 1, height, width],
                     "expected alpha (1, 1, \(height), \(width)), got \(alpha.shape)")

        let flatRGB = rgb.reshaped([3, height, width]).asType(.float32)
        let flatA = alpha.reshaped([height, width]).asType(.float32)
        MLX.eval(flatRGB, flatA)
        let rArr = flatRGB[0].asArray(Float.self)
        let gArr = flatRGB[1].asArray(Float.self)
        let bArr = flatRGB[2].asArray(Float.self)
        let aArr = flatA.asArray(Float.self)

        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        for idx in 0..<(width * height) {
            let outIdx = idx * 4
            rgba[outIdx]     = UInt8(max(0, min(255, rArr[idx] * 255)))
            rgba[outIdx + 1] = UInt8(max(0, min(255, gArr[idx] * 255)))
            rgba[outIdx + 2] = UInt8(max(0, min(255, bArr[idx] * 255)))
            rgba[outIdx + 3] = UInt8(max(0, min(255, aArr[idx] * 255)))
        }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        // kCGImageAlphaLast = real RGBA (unlike savePNG's opaque .noneSkipLast).
        let alphaInfo = CGImageAlphaInfo.last.rawValue
        let orderInfo = CGBitmapInfo.byteOrder32Big.rawValue
        let bitmapInfo = CGBitmapInfo(rawValue: alphaInfo | orderInfo)
        let provider = CGDataProvider(data: Data(rgba) as CFData)!
        guard let cgImage = CGImage(
            width: width, height: height,
            bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: width * 4,
            space: colorSpace, bitmapInfo: bitmapInfo,
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
        ) else {
            throw NSError(domain: "ImageSave", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "CGImage creation failed"])
        }

        var fileURL = url
        if fileURL.pathExtension.lowercased() != "png" {
            fileURL = fileURL.appendingPathExtension("png")
        }
        guard let dest = CGImageDestinationCreateWithURL(
            fileURL as CFURL, UTType.png.identifier as CFString, 1, nil
        ) else {
            throw NSError(domain: "ImageSave", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "CGImageDestination creation failed"])
        }
        CGImageDestinationAddImage(dest, cgImage, nil)
        guard CGImageDestinationFinalize(dest) else {
            throw NSError(domain: "ImageSave", code: 3, userInfo: [NSLocalizedDescriptionKey: "PNG write failed"])
        }
    }
}
