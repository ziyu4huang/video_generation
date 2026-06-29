//
//  Flux2ImageLoad.swift
//  Flux2Director
//
//  Phase 3.1: Load a PNG/JPEG to (1, 3, H, W) float32 in [0,1] for VAE encoding
//  (reference image conditioning). Mirrors z-image ImageLoad conventions.
//

import Foundation
import MLX
import ImageIO
import CoreGraphics

public enum Flux2ImageLoad {
    /// Load an image file to (1, 3, H, W) float32 in [0,1], resized to targetSize.
    public static func loadArray(from url: URL, targetSize: (width: Int, height: Int)) throws -> MLXArray {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw NSError(domain: "Flux2ImageLoad", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Could not read image at \(url.path)"])
        }
        let width = targetSize.width, height = targetSize.height
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue
                                     | CGBitmapInfo.byteOrder32Big.rawValue)
        guard let ctx = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: width * 4,
            space: colorSpace, bitmapInfo: bitmapInfo
        ) else {
            throw NSError(domain: "Flux2ImageLoad", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "CGContext creation failed"])
        }
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let dataPtr = ctx.data?.assumingMemoryBound(to: UInt8.self) else {
            throw NSError(domain: "Flux2ImageLoad", code: 3,
                          userInfo: [NSLocalizedDescriptionKey: "Bitmap unavailable"])
        }
        // Interleaved RGBX → planar CHW float32 [0,1]. CGContext renders top-down
        // (row 0 = top), matching PIL — no row flip needed.
        var chw = [Float](repeating: 0, count: 3 * height * width)
        for y in 0..<height {
            for x in 0..<width {
                let p = (y * width + x) * 4
                let dst = y * width + x
                chw[0 * height * width + dst] = Float(dataPtr[p])     / 255.0
                chw[1 * height * width + dst] = Float(dataPtr[p + 1]) / 255.0
                chw[2 * height * width + dst] = Float(dataPtr[p + 2]) / 255.0
            }
        }
        let arr = MLXArray(chw, [1, 3, height, width]).asType(.float32)
        MLX.eval(arr)
        return arr
    }

    /// Normalize [0,1] → [-1,1] for VAE encoding.
    public static func normalizeForVAE(_ image: MLXArray) -> MLXArray {
        image * 2.0 - 1.0
    }
}
