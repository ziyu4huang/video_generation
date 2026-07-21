//
//  CLIPImagePreprocess.swift
//  ClipDirector
//
//  Ports HF CLIPProcessor's image transform for openai/clip-vit-base-patch32:
//  resize so the SHORTEST side = 224 (preserve aspect), center-crop 224×224,
//  normalize per-channel with CLIP's mean/std. Returns (1, 3, 224, 224)
//  float32. CGContext does the resize (bilinear); the center-crop + per-pixel
//  normalize mirrors `transforms.CenterCrop` + `transforms.Normalize` exactly.
//

import Foundation
import CoreGraphics
import ImageIO
import MLX

public enum CLIPImagePreprocess {
    public static let size = 224
    static let mean: [Float] = [0.48145466, 0.4578275, 0.40821073]
    static let std: [Float] = [0.26862954, 0.26130258, 0.27577711]

    /// Load an image to (1, 3, 224, 224) normalized per CLIPProcessor.
    public static func load(_ url: URL) throws -> MLXArray {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw NSError(domain: "CLIPImagePreprocess", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "could not read image at \(url.path)"])
        }
        let ow = cg.width, oh = cg.height
        // resize shortest side → 224, preserve aspect (matches HF Resize(shortest_edge=224)).
        let scale = Float(size) / Float(min(ow, oh))
        let rw = max(size, Int((Float(ow) * scale).rounded()))
        let rh = max(size, Int((Float(oh) * scale).rounded()))
        let rgba = try render(cg, width: rw, height: rh)
        // center-crop offsets into the resized bitmap.
        let xoff = (rw - size) / 2
        let yoff = (rh - size) / 2
        return normalize(rgba, srcWidth: rw, xoff: xoff, yoff: yoff)
    }

    /// Render the source image into an RGBA bitmap at (width, height).
    private static func render(_ cg: CGImage, width: Int, height: Int) throws -> [UInt8] {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                  bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo) else {
            throw NSError(domain: "CLIPImagePreprocess", code: 2, userInfo: [NSLocalizedDescriptionKey: "resize failed"])
        }
        // High-quality (Lanczos) resampling to approach PIL's bicubic resize used
        // by HF CLIPProcessor (not bit-exact, but close — the model itself is
        // parity-verified to <3e-5 on identical pixels).
        ctx.interpolationQuality = .high
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let ptr = ctx.data?.assumingMemoryBound(to: UInt8.self) else {
            throw NSError(domain: "CLIPImagePreprocess", code: 3, userInfo: [NSLocalizedDescriptionKey: "bitmap unavailable"])
        }
        return Array(UnsafeBufferPointer(start: ptr, count: width * height * 4))
    }

    /// Read the 224×224 center crop from `rgba` (a srcWidth×H bitmap) and
    /// normalize → (1, 3, 224, 224) float32 per CLIP mean/std.
    private static func normalize(_ rgba: [UInt8], srcWidth: Int, xoff: Int, yoff: Int) -> MLXArray {
        var chw = [Float](repeating: 0, count: 3 * size * size)
        for y in 0..<size {
            for x in 0..<size {
                let p = ((y + yoff) * srcWidth + (x + xoff)) * 4
                let dst = y * size + x
                chw[0 * size * size + dst] = (Float(rgba[p]) / 255.0 - mean[0]) / std[0]
                chw[1 * size * size + dst] = (Float(rgba[p + 1]) / 255.0 - mean[1]) / std[1]
                chw[2 * size * size + dst] = (Float(rgba[p + 2]) / 255.0 - mean[2]) / std[2]
            }
        }
        let arr = MLXArray(chw, [1, 3, size, size]).asType(.float32)
        MLX.eval(arr)
        return arr
    }
}
