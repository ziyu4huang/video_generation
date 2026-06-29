//
//  Flux2Composite.swift
//  Flux2Director
//
//  Phase 4.2: Mask-based image compositing (swap). Pure Swift image processing —
//  paste a reference image into a masked region of the source with feathered
//  alpha-blend. Ported from sam3_predictor.composite_images (legacy path).
//

import Foundation
import MLX
import CoreGraphics
import ImageIO

public enum Flux2Composite {
    /// Composite reference content onto source using a feathered mask.
    /// The reference is resized to fill the mask's bounding box, then alpha-blended.
    /// All inputs are (1, 3, H, W) float32 in [0,1]; mask is (1, 1, H, W) float32 [0,1].
    public static func composite(source: MLXArray, reference: MLXArray, mask: MLXArray,
                                  featherRadius: Int = 10) -> MLXArray {
        let h = source.dim(2), w = source.dim(3)
        // Find the mask bounding box (rows/cols with any non-zero value).
        let maskFlat = mask.reshaped([h, w]).asType(.float32)
        MLX.eval(maskFlat)
        let maskArr = maskFlat.asArray(Float.self)
        var minY = h, maxY = -1, minX = w, maxX = -1
        for y in 0..<h {
            for x in 0..<w {
                if maskArr[y * w + x] > 0.01 {
                    if y < minY { minY = y }
                    if y > maxY { maxY = y }
                    if x < minX { minX = x }
                    if x > maxX { maxX = x }
                }
            }
        }
        // No mask region → return source unchanged.
        guard maxY >= 0 else { return source }

        let boxH = maxY - minY + 1, boxW = maxX - minX + 1
        // Resize the reference to the box size via CGContext (simple bilinear).
        let refResized = resizeBilinear(reference, targetW: boxW, targetH: boxH)
        // Place the resized reference into a full-size canvas.
        var refCanvas = MLX.zeros([1, 3, h, w])
        refCanvas[0..., 0..., minY..<(minY + boxH), minX..<(minX + boxW)] = refResized[0..., 0..., 0..<boxH, 0..<boxW]

        // Feather the mask (gaussian-ish via repeated box blur approximation).
        let feathered = featherMask(maskFlat, radius: featherRadius)
        let maskB = feathered.reshaped([1, 1, h, w])
        // Alpha blend: result = source * (1 - mask) + ref * mask
        return source * (1.0 - maskB) + refCanvas * maskB
    }

    /// Resize a (1,3,H,W) image to (1,3,targetH,targetW) via CGContext bilinear.
    static func resizeBilinear(_ image: MLXArray, targetW: Int, targetH: Int) -> MLXArray {
        let srcH = image.dim(2), srcW = image.dim(3)
        MLX.eval(image)
        let arr = image.reshaped([3, srcH, srcW]).asArray(Float.self)
        // Build a uint8 bitmap from the source.
        var srcBytes = [UInt8](repeating: 0, count: srcW * srcH * 4)
        for y in 0..<srcH {
            for x in 0..<srcW {
                let p = (y * srcW + x) * 4
                srcBytes[p] = UInt8(max(0, min(255, arr[0 * srcH * srcW + y * srcW + x] * 255)))
                srcBytes[p + 1] = UInt8(max(0, min(255, arr[1 * srcH * srcW + y * srcW + x] * 255)))
                srcBytes[p + 2] = UInt8(max(0, min(255, arr[2 * srcH * srcW + y * srcW + x] * 255)))
                srcBytes[p + 3] = 255
            }
        }
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        let provider = CGDataProvider(data: Data(srcBytes) as CFData)!
        guard let cgSrc = CGImage(
            width: srcW, height: srcH, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: srcW * 4, space: colorSpace, bitmapInfo: bitmapInfo,
            provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent
        ) else { return MLX.zeros([1, 3, targetH, targetW]) }
        guard let ctx = CGContext(
            data: nil, width: targetW, height: targetH, bitsPerComponent: 8,
            bytesPerRow: targetW * 4, space: colorSpace, bitmapInfo: bitmapInfo
        ) else { return MLX.zeros([1, 3, targetH, targetW]) }
        ctx.draw(cgSrc, in: CGRect(x: 0, y: 0, width: targetW, height: targetH))
        guard let ptr = ctx.data?.assumingMemoryBound(to: UInt8.self) else {
            return MLX.zeros([1, 3, targetH, targetW])
        }
        var out = [Float](repeating: 0, count: 3 * targetH * targetW)
        for y in 0..<targetH {
            for x in 0..<targetW {
                let p = (y * targetW + x) * 4
                out[0 * targetH * targetW + y * targetW + x] = Float(ptr[p]) / 255.0
                out[1 * targetH * targetW + y * targetW + x] = Float(ptr[p + 1]) / 255.0
                out[2 * targetH * targetW + y * targetW + x] = Float(ptr[p + 2]) / 255.0
            }
        }
        let result = MLXArray(out, [1, 3, targetH, targetW]).asType(.float32)
        MLX.eval(result)
        return result
    }

    /// Simple separable box-blur feathering of a (H,W) mask.
    static func featherMask(_ mask: MLXArray, radius: Int) -> MLXArray {
        guard radius > 0 else { return mask }
        // Approximate gaussian via 3 passes of box blur (radius each).
        var m = mask.asType(.float32)
        for _ in 0..<3 { m = boxBlur(m, radius: radius) }
        return m
    }

    /// Separable box blur on (H,W) float32.
    static func boxBlur(_ mask: MLXArray, radius: Int) -> MLXArray {
        let h = mask.dim(0), w = mask.dim(1)
        let horiz = blurAxis(mask, axis: 1, length: w, other: h, radius: radius)
        return blurAxis(horiz, axis: 0, length: h, other: w, radius: radius)
    }

    static func blurAxis(_ x: MLXArray, axis: Int, length: Int, other: Int, radius: Int) -> MLXArray {
        // Box blur via cumulative sum: (cumsum[i+r] - cumsum[i-r-1]) / window
        let window = 2 * radius + 1
        let xEval = x.asType(.float32)
        MLX.eval(xEval)
        let arr = xEval.asArray(Float.self)
        var out = [Float](repeating: 0, count: length * other)
        for o in 0..<other {
            var line = [Float](repeating: 0, count: length + 1)
            for i in 0..<length {
                let idx = axis == 0 ? i * other + o : o * length + i
                line[i + 1] = line[i] + arr[idx]
            }
            for i in 0..<length {
                let lo = max(0, i - radius), hi = min(length, i + radius + 1)
                let val = (line[hi] - line[lo]) / Float(hi - lo)
                let idx = axis == 0 ? i * other + o : o * length + i
                out[idx] = val
            }
        }
        let result = MLXArray(out, x.shape).asType(.float32)
        MLX.eval(result)
        return result
    }
}
