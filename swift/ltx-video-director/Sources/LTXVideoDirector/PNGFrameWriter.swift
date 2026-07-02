//
//  PNGFrameWriter.swift
//  LTXVideoDirector
//
//  Writes VAE-decoded video frames to a PNG sequence using CoreGraphics +
//  ImageIO — native macOS frameworks, no external dependency (mirrors
//  WAVWriter.swift's "no external deps" approach for audio). Pixel
//  convention: VideoDecoder outputs [-1, 1]-range RGB (confirmed by
//  reading VideoEncoder/decode_and_stream's own `mx.clip(frame, -1, 1)`
//  in the reference, not assumed) — remapped to [0, 255] here.
//
//  A PNG sequence, not an MP4, because encoding H.264/HEVC needs
//  AVAssetWriter's more involved pixel-buffer-pool plumbing; a frame
//  sequence is sufficient to prove the native VAE decode path produces
//  real, viewable images end-to-end without run.py. MP4 muxing can reuse
//  this same RGB-frame source later.
//

import CoreGraphics
import Foundation
import ImageIO
import MLX
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

public enum PNGFrameWriter {
    public enum WriteError: Error, CustomStringConvertible {
        case invalidShape(String)
        case contextCreationFailed
        case pngEncodingFailed(Int)

        public var description: String {
            switch self {
            case .invalidShape(let msg): return "PNGFrameWriter: \(msg)"
            case .contextCreationFailed: return "PNGFrameWriter: failed to create CGContext"
            case .pngEncodingFailed(let frame): return "PNGFrameWriter: failed to encode frame \(frame)"
            }
        }
    }

    /// `pixels`: (1, 3, T, H, W), values in [-1, 1] (VideoDecoder's raw
    /// output convention). Writes `frame_0000.png`, `frame_0001.png`, ...
    /// into `directory` (created if needed). Returns the frame count.
    @discardableResult
    public static func writeFrames(_ pixels: MLXArray, to directory: URL) throws -> Int {
        guard pixels.ndim == 5, pixels.dim(0) == 1, pixels.dim(1) == 3 else {
            throw WriteError.invalidShape("expected (1, 3, T, H, W), got \(pixels.shape)")
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let clipped = MLX.clip(pixels, min: -1.0, max: 1.0)
        let rescaled = ((clipped + 1.0) * 127.5).asType(.float32)  // [-1,1] -> [0,255]
        // (1,3,T,H,W) -> (T,H,W,3) for row-major RGB pixel extraction.
        let hwc = rescaled[0].transposed(1, 2, 3, 0)
        MLX.eval(hwc)

        let frameCount = hwc.dim(0)
        let height = hwc.dim(1)
        let width = hwc.dim(2)

        for t in 0..<frameCount {
            let frame = hwc[t]  // (H, W, 3), float32
            let floats = frame.asArray(Float.self)
            var rgba = [UInt8](repeating: 255, count: width * height * 4)
            for i in 0..<(width * height) {
                rgba[i * 4 + 0] = UInt8(max(0, min(255, floats[i * 3 + 0])))
                rgba[i * 4 + 1] = UInt8(max(0, min(255, floats[i * 3 + 1])))
                rgba[i * 4 + 2] = UInt8(max(0, min(255, floats[i * 3 + 2])))
                rgba[i * 4 + 3] = 255
            }

            guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
                  let context = CGContext(
                    data: &rgba, width: width, height: height, bitsPerComponent: 8,
                    bytesPerRow: width * 4, space: colorSpace,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
                  let cgImage = context.makeImage()
            else {
                throw WriteError.contextCreationFailed
            }

            let frameURL = directory.appendingPathComponent(String(format: "frame_%04d.png", t))
            let pngType: CFString
            if #available(macOS 11.0, *) {
                pngType = UTType.png.identifier as CFString
            } else {
                pngType = "public.png" as CFString
            }
            guard let destination = CGImageDestinationCreateWithURL(frameURL as CFURL, pngType, 1, nil) else {
                throw WriteError.pngEncodingFailed(t)
            }
            CGImageDestinationAddImage(destination, cgImage, nil)
            guard CGImageDestinationFinalize(destination) else {
                throw WriteError.pngEncodingFailed(t)
            }
        }

        return frameCount
    }
}
