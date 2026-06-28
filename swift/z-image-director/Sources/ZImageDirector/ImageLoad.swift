//
//  ImageLoad.swift
//  ZImageDirector
//
//  i2i support: load a PNG/JPEG to (1, 3, H, W) float32 MLX array.
//  Mirrors ImageSave conventions — RGB, CHW layout, [0,1] range.
//

import CommonImageDirector
import Foundation
import MLX
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers

public enum ImageLoad {

    /// Load an image file to (1, 3, H, W) float32 in [0,1].
    /// Optionally resize to (targetW, targetH). The VAE requires H,W divisible
    /// by 64 (encoder downsamples ×8, then the transformer patchifies ×2).
    public static func loadArray(
        from url: URL, targetSize: (width: Int, height: Int)? = nil
    ) throws -> MLXArray {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw NSError(domain: "ImageLoad", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Could not read image at \(url.path)"])
        }

        let width: Int
        let height: Int
        if let target = targetSize {
            width = target.width
            height = target.height
        } else {
            width = cgImage.width
            height = cgImage.height
        }

        // Render into an RGBX uint8 bitmap via CGContext.
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let alphaInfo = CGImageAlphaInfo.noneSkipLast.rawValue   // RGBX
        let orderInfo = CGBitmapInfo.byteOrder32Big.rawValue
        let bitmapInfo = CGBitmapInfo(rawValue: alphaInfo | orderInfo)
        guard let ctx = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: width * 4,
            space: colorSpace, bitmapInfo: bitmapInfo
        ) else {
            throw NSError(domain: "ImageLoad", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "CGContext creation failed"])
        }
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let dataPtr = ctx.data?.assumingMemoryBound(to: UInt8.self) else {
            throw NSError(domain: "ImageLoad", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "CGContext bitmap unavailable"])
        }

        // Interleaved RGBX → planar CHW float32 [0,1].
        // CGContext renders the bitmap top-down (row 0 = top) in this config,
        // matching PIL/Python's top-left origin — so no row flip is needed.
        var chw = [Float](repeating: 0, count: 3 * height * width)
        for y in 0..<height {
            for x in 0..<width {
                let p = (y * width + x) * 4
                let dst = (y * width + x)
                chw[0 * height * width + dst] = Float(dataPtr[p])     / 255.0
                chw[1 * height * width + dst] = Float(dataPtr[p + 1]) / 255.0
                chw[2 * height * width + dst] = Float(dataPtr[p + 2]) / 255.0
            }
        }

        let arr = MLXArray(chw, [1, 3, height, width]).asType(.float32)
        MLX.eval(arr)
        return arr
    }

    /// Normalize a [0,1] image array to [-1,1] for VAE encoding.
    public static func normalizeForVAE(_ image: MLXArray) -> MLXArray {
        return image * 2.0 - 1.0
    }

    /// Load a mask image to a single-channel (1, 1, H, W) float32 array in [0,1].
    /// White (255) → 1.0 = LOCK to init latent (keep original), black → 0.0 = free
    /// to re-denoise. The mask is loaded at the TARGET latent resolution
    /// (H/8 × W/8) directly via CGContext downscaling, so no separate resize step
    /// is needed. Pass `latentWidth = pixelWidth/8`, `latentHeight = pixelHeight/8`.
    public static func loadMask(
        from url: URL, latentWidth: Int, latentHeight: Int
    ) throws -> MLXArray {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw NSError(domain: "ImageLoad", code: 4,
                          userInfo: [NSLocalizedDescriptionKey: "Could not read mask at \(url.path)"])
        }
        let w = latentWidth, h = latentHeight
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        guard let ctx = CGContext(
            data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
            space: colorSpace, bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo)
        ) else {
            throw NSError(domain: "ImageLoad", code: 5,
                          userInfo: [NSLocalizedDescriptionKey: "CGContext creation failed (mask)"])
        }
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let dataPtr = ctx.data?.assumingMemoryBound(to: UInt8.self) else {
            throw NSError(domain: "ImageLoad", code: 6,
                          userInfo: [NSLocalizedDescriptionKey: "Mask bitmap unavailable"])
        }
        // Average RGB → luminance, top-down (matches loadArray orientation).
        var lum = [Float](repeating: 0, count: h * w)
        for y in 0..<h {
            for x in 0..<w {
                let p = (y * w + x) * 4
                lum[y * w + x] = (Float(dataPtr[p]) + Float(dataPtr[p + 1]) + Float(dataPtr[p + 2])) / (3.0 * 255.0)
            }
        }
        let arr = MLXArray(lum, [1, 1, h, w]).asType(.float32)
        MLX.eval(arr)
        return arr
    }
}
