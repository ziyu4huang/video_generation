//
//  FrameLoad.swift
//  LTXVideoDirector
//
//  CGImage -> MLXArray (1,3,H,W) float32 [0,1], so extracted video frames can
//  be run through the shared CommonImageDirector.ImageGate (same format the
//  image directors save/gate). Also renders CGImage -> PNG for VLM upload.
//

import CoreGraphics
import Foundation
import ImageIO
import MLX
import UniformTypeIdentifiers

public enum FrameLoad {
    /// Load a CGImage from a PNG (or any ImageIO-supported) file on disk.
    public static func loadCGImage(from url: URL) -> CGImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, nil)
    }

    /// Render a CGImage to (1, 3, H, W) float32 [0,1] at the image's native size.
    public static func toArray(_ cgImage: CGImage) -> MLXArray {
        let width = cgImage.width
        let height = cgImage.height
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue
                                     | CGBitmapInfo.byteOrder32Big.rawValue)
        guard let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo
        ) else {
            return MLXArray.zeros([1, 3, 1, 1])
        }
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let ptr = ctx.data?.assumingMemoryBound(to: UInt8.self) else {
            return MLXArray.zeros([1, 3, 1, 1])
        }
        var chw = [Float](repeating: 0, count: 3 * height * width)
        for y in 0..<height {
            for x in 0..<width {
                let p = (y * width + x) * 4
                let dst = y * width + x
                chw[0 * height * width + dst] = Float(ptr[p]) / 255.0
                chw[1 * height * width + dst] = Float(ptr[p + 1]) / 255.0
                chw[2 * height * width + dst] = Float(ptr[p + 2]) / 255.0
            }
        }
        let arr = MLXArray(chw, [1, 3, height, width]).asType(.float32)
        MLX.eval(arr)
        return arr
    }

    /// Grayscale [0,1] buffer at native size — the format ImageMetrics.compute expects.
    public static func toGrayscaleBuffer(_ cgImage: CGImage) -> (buffer: [Float], width: Int, height: Int) {
        let width = cgImage.width
        let height = cgImage.height
        let colorSpace = CGColorSpaceCreateDeviceGray()
        guard let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width, space: colorSpace, bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else {
            return ([Float](repeating: 0, count: width * height), width, height)
        }
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let ptr = ctx.data?.assumingMemoryBound(to: UInt8.self) else {
            return ([Float](repeating: 0, count: width * height), width, height)
        }
        var buf = [Float](repeating: 0, count: width * height)
        for i in 0..<(width * height) {
            buf[i] = Float(ptr[i]) / 255.0
        }
        return (buf, width, height)
    }

    /// Resize + center-crop to exactly `targetWidth`x`targetHeight`, matching
    /// the reference ComfyUI FFLF workflows' `MultiImageLoader` convention
    /// ("keep proportion" resize + center crop, bicubic/lanczos resampling —
    /// see docs/reference/comfyui_workflows/README.md's third-pass finding
    /// 3). Aspect-FILLS the target (scales so the shorter dimension covers
    /// it, crops the overflow on the longer axis) rather than letterboxing,
    /// same behavior as ComfyUI's node. `CGContext.interpolationQuality =
    /// .high` is Core Graphics' bicubic-equivalent resampler.
    public static func resizeAspectFillCenterCrop(_ cgImage: CGImage, targetWidth: Int, targetHeight: Int) -> CGImage {
        let srcW = Double(cgImage.width), srcH = Double(cgImage.height)
        let dstW = Double(targetWidth), dstH = Double(targetHeight)
        let scale = max(dstW / srcW, dstH / srcH)
        let scaledW = srcW * scale, scaledH = srcH * scale
        let originX = (scaledW - dstW) / 2.0
        let originY = (scaledH - dstH) / 2.0

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue
                                     | CGBitmapInfo.byteOrder32Big.rawValue)
        guard let ctx = CGContext(
            data: nil, width: targetWidth, height: targetHeight, bitsPerComponent: 8,
            bytesPerRow: targetWidth * 4, space: colorSpace, bitmapInfo: bitmapInfo
        ) else {
            return cgImage
        }
        ctx.interpolationQuality = .high
        ctx.draw(cgImage, in: CGRect(x: -originX, y: -originY, width: scaledW, height: scaledH))
        return ctx.makeImage() ?? cgImage
    }

    /// Split a single image containing an NxN grid of storyboard panels
    /// into `columns * rows` separate tiles, row-major order (top-left,
    /// top-right, ..., bottom-right) — mirrors the reference ComfyUI
    /// `TD_LTXVAddGuideFromGrid` node's `_split_grid` (see
    /// docs/reference/comfyui_workflows), except done here with plain
    /// CoreGraphics cropping instead of a Python/numpy tensor split.
    /// Any remainder pixels (grid dimensions not evenly divisible by
    /// columns/rows) are dropped from the last row/column's tiles.
    public static func splitGrid(_ cgImage: CGImage, columns: Int, rows: Int) -> [CGImage] {
        precondition(columns > 0 && rows > 0, "splitGrid: columns/rows must be positive")
        let tileWidth = cgImage.width / columns
        let tileHeight = cgImage.height / rows
        var tiles: [CGImage] = []
        for row in 0..<rows {
            for col in 0..<columns {
                let rect = CGRect(x: col * tileWidth, y: row * tileHeight, width: tileWidth, height: tileHeight)
                guard let tile = cgImage.cropping(to: rect) else {
                    preconditionFailure("splitGrid: cropping(to:) failed for tile (row \(row), col \(col))")
                }
                tiles.append(tile)
            }
        }
        return tiles
    }

    /// Save a CGImage as PNG (for VLM upload via CaptionClient, which reads files).
    @discardableResult
    public static func savePNG(_ cgImage: CGImage, to url: URL) -> Bool {
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            return false
        }
        CGImageDestinationAddImage(dest, cgImage, nil)
        return CGImageDestinationFinalize(dest)
    }
}
