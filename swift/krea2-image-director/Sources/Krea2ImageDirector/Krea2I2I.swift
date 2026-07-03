//
//  Krea2I2I.swift
//  Krea2ImageDirector
//
//  Native Swift img2img (SDEditor-style): VAE-encode input -> rescale to
//  diffusion space -> flow-matching noise to `strength` -> Euler denoise 0.
//  Pure Swift/MLX, no Python.
//

import CoreGraphics
import Foundation
import ImageIO
import MLX
import MLXRandom
#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif

public extension Krea2Engine {

    /// Load a PNG/JPG as (1, H, W, 3) float32 in [-1, 1].
    static func loadImage(_ url: URL) throws -> (MLXArray, Int, Int) {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw NSError(domain: "Krea2Engine", code: 5,
                          userInfo: [NSLocalizedDescriptionKey: "failed to load image \(url.path)"])
        }
        let w = cg.width, h = cg.height
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        let bytesPerRow = w * 4
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &rgba, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: bytesPerRow, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let drawn = ctx.makeImage() else {
            throw NSError(domain: "Krea2Engine", code: 6, userInfo: [NSLocalizedDescriptionKey: "CGContext draw failed"])
        }
        _ = drawn
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        var rgb = [Float](repeating: 0, count: w * h * 3)
        for i in 0..<(w * h) {
            rgb[i * 3 + 0] = Float(rgba[i * 4 + 0]) / 127.5 - 1.0
            rgb[i * 3 + 1] = Float(rgba[i * 4 + 1]) / 127.5 - 1.0
            rgb[i * 3 + 2] = Float(rgba[i * 4 + 2]) / 127.5 - 1.0
        }
        return (MLXArray(rgb).reshaped([1, h, w, 3]), w, h)
    }

    /// Pure-Swift img2img.
    @discardableResult
    static func i2i(inputImage: URL, prompt: String, strength: Float = 0.6,
                    width: Int = 1024, height: Int = 1024, steps: Int = 8,
                    seed: Int = 42, mu: Double = 1.15, out: URL) throws -> Krea2GenerateResult {
        let cfg = Krea2Config()
        let patch = cfg.patch, compression = 8
        let align = compression * patch
        let W = ((width + align - 1) / align) * align
        let H = ((height + align - 1) / align) * align
        let (Hl, Wl) = (H / compression, W / compression)
        print("[krea2] native i2i \(W)x\(H) strength=\(strength) steps=\(steps) seed=\(seed)")

        print("[1/5] text encoder...", terminator: " ")
        let enc = try Krea2TextEncoder(weightsDir: instructDir, tokenizerDir: tokenizerDir)
        let (context, txtmask) = enc.encode([prompt])
        MLX.eval(context, txtmask); print("ok")

        print("[2/5] load + encode input...", terminator: " ")
        let vaeRaw = try loadArrays(url: vaeWeights)
        let (imgArr, iw, ih) = try loadImage(inputImage)
        let nativeLat = Krea2VAE.encode(imgArr, vaeRaw)         // (1,H,W,16) channels-last
        let (m, s) = vaeMeanStd()                               // (1,1,1,16) channels-last
        let zDiffCL = (nativeLat - m) / s                       // diffusion space, channels-last
        let zDiff = zDiffCL.transposed(0, 3, 1, 2)              // (1,16,H,W) channels-first
        MLX.eval(zDiff); print("input \(iw)x\(ih) -> latent \(nativeLat.shape)")

        print("[3/5] DiT weights...", terminator: " ")
        let ditWeights = try loadArrays(url: turboWeights)
        let dit = Krea2DiT(config: cfg, weights: ditWeights); print("ok")

        print("[4/5] denoise (SDEditor)...", terminator: " ")
        let zH = zDiff.dim(2), zW = zDiff.dim(3)
        MLXRandom.seed(UInt64(seed))
        let noise = MLXRandom.normal([1, 16, zH, zW])
        let zT = (1.0 - strength) * zDiff.asType(.float32) + MLXArray(strength) * noise
        var (imgTokens, pos, mask) = Krea2Sampler.prepare(
            noise: zT, txtlen: context.dim(1), patch: patch, txtmask: txtmask)
        let fullTs = Krea2Sampler.timesteps(seqLen: imgTokens.dim(1), steps: steps, mu: mu)
        var startIdx = 0
        for (i, t) in fullTs.enumerated() where t >= strength { startIdx = i }
        for i in startIdx..<(fullTs.count - 1) {
            let tcurr = fullTs[i], tprev = fullTs[i + 1]
            let v = dit(img: imgTokens, context: context, t: MLXArray([tcurr]), pos: pos, mask: mask)
            imgTokens = imgTokens + (tprev - tcurr) * v
            MLX.eval(imgTokens)
        }
        print("done")

        print("[5/5] VAE decode...", terminator: " ")
        let (zHt, zWt) = (zH / patch, zW / patch)
        let latCF = imgTokens.reshaped([1, zHt, zWt, 16, patch, patch])
            .transposed(0, 3, 1, 4, 2, 5).reshaped([1, 16, zH, zW])
        let latCL = latCF.transposed(0, 2, 3, 1) * s + m        // back to native latent, channels-last
        let pixels = Krea2VAE.decode(latCL, vaeRaw)
        try savePNG(pixels, width: zW * compression, height: zH * compression, to: out)
        print("saved \(out.path)")
        return Krea2GenerateResult(imageURL: out, seed: seed)
    }
}
