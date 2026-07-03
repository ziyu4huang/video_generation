//
//  Krea2Engine.swift
//  Krea2ImageDirector
//
//  Native Swift T2I engine — loads the DiT/VAE/encoder weights and runs the
//  full generate loop with NO Python dependency (pure Swift/MLX).
//

import CoreGraphics
import Foundation
import ImageIO
import MLX
import MLXNN
import MLXRandom

public struct Krea2GenerateResult {
    public let imageURL: URL
    public let seed: Int
}

public enum Krea2Engine {
    /// Prefer the Q8-quantized DiT (13.6 GB) over bf16 (24 GB) when present.
    /// `lin()` auto-detects quantized weights via the `.scales` companion key.
    /// Prefer promoted mlx-models locations; fall back to _staging_krea2/ for
    /// the transitional period (pre-promotion) so both layouts work.
    static var turboWeights: URL {
        // Promoted Q8 first, then staging Q8, then staging bf16.
        let promoted = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/krea2-turbo/model.safetensors")
        if FileManager.default.fileExists(atPath: promoted.path) { return promoted }
        let q8 = RepoPaths.krea2Staging.appendingPathComponent("turbo-q8.safetensors")
        if FileManager.default.fileExists(atPath: q8.path) { return q8 }
        return RepoPaths.krea2Staging.appendingPathComponent("turbo.safetensors")
    }
    static var vaeWeights: URL {
        let promoted = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/qwen-image-vae/diffusion_pytorch_model.safetensors")
        if FileManager.default.fileExists(atPath: promoted.path) { return promoted }
        return RepoPaths.krea2Staging.appendingPathComponent("vae/diffusion_pytorch_model.safetensors")
    }
    static var instructDir: URL {
        let promoted = RepoPaths.mlxModelsRoot.appendingPathComponent("text_encoder/qwen3-4b-instruct")
        if FileManager.default.fileExists(atPath: promoted.appendingPathComponent("model.safetensors").path) {
            return promoted
        }
        return RepoPaths.krea2Staging.appendingPathComponent("qwen3-4b-instruct")
    }
    static var tokenizerDir: URL { RepoPaths.mlxModelsRoot.appendingPathComponent("tokenizer/qwen3") }

    /// VAE config.json (latents_mean/std) — co-located with the VAE weights.
    static var vaeConfig: URL {
        vaeWeights.deletingLastPathComponent().appendingPathComponent("config.json")
    }

    /// Pure-Swift T2I. Returns the saved image URL.
    @discardableResult
    public static func t2i(prompt: String, width: Int = 1024, height: Int = 1024,
                           steps: Int = 8, seed: Int = 42, mu: Double = 1.15,
                           out: URL) throws -> Krea2GenerateResult {
        let cfg = Krea2Config()
        let patch = cfg.patch, compression = 8
        let align = compression * patch
        let W = ((width + align - 1) / align) * align
        let H = ((height + align - 1) / align) * align
        let (Hl, Wl) = (H / compression, W / compression)
        print("[krea2] native \(W)x\(H) (latent \(Wl)x\(Hl)) steps=\(steps) mu=\(mu) seed=\(seed)")

        print("[1/4] text encoder (native)...", terminator: " ")
        let enc = try Krea2TextEncoder(weightsDir: instructDir, tokenizerDir: tokenizerDir)
        let (context, txtmask) = enc.encode([prompt])
        MLX.eval(context, txtmask)
        print("ctx \(context.shape)")

        let qLabel = turboWeights.lastPathComponent.contains("q8") ? "q8" : "bf16"
        print("[2/4] DiT weights (\(qLabel))...", terminator: " ")
        let ditWeights = try loadArrays(url: turboWeights)
        let dit = Krea2DiT(config: cfg, weights: ditWeights)
        print("loaded (\(ditWeights.count) tensors)")

        print("[3/4] denoise...", terminator: " ")
        MLXRandom.seed(UInt64(seed))
        let noise = MLXRandom.normal([1, 16, Hl, Wl])
        var (imgTokens, pos, mask) = Krea2Sampler.prepare(
            noise: noise, txtlen: context.dim(1), patch: patch, txtmask: txtmask)
        let ts = Krea2Sampler.timesteps(seqLen: imgTokens.dim(1), steps: steps, mu: mu)
        for i in 0..<(ts.count - 1) {
            let tcurr = ts[i], tprev = ts[i + 1]
            let t = MLXArray([tcurr])
            let v = dit(img: imgTokens, context: context, t: t, pos: pos, mask: mask)
            imgTokens = imgTokens + (tprev - tcurr) * v
            MLX.eval(imgTokens)
            if (i + 1) % 2 == 0 || i == ts.count - 2 { print("\(i+1)/\(ts.count-1)", terminator: " ") }
        }
        print()

        let (Ht, Wt) = (Hl / patch, Wl / patch)
        var lat = imgTokens.reshaped([1, Ht, Wt, 16, patch, patch])
            .transposed(0, 3, 1, 4, 2, 5).reshaped([1, 16, Hl, Wl])
        lat = lat.transposed(0, 2, 3, 1)                          // (1,Hl,Wl,16) channels-last
        let vaeRaw = try loadArrays(url: vaeWeights)
        let (mean, std) = vaeMeanStd()
        lat = lat * std + mean

        print("[4/4] VAE decode (native)...", terminator: " ")
        MLX.eval(lat)
        let latArr = lat.asArray(Float.self)
        print("\n  latent stats: min \(latArr.min() ?? 0) max \(latArr.max() ?? 0) mean \(latArr.reduce(0,+)/Float(latArr.count))")
        let pixels = Krea2VAE.decode(lat, vaeRaw)                 // (1,H,W,3) [-1,1]
        MLX.eval(pixels)
        let pixArr = pixels.asArray(Float.self)
        print("  pixel stats: min \(pixArr.min() ?? 0) max \(pixArr.max() ?? 0) mean \(pixArr.reduce(0,+)/Float(pixArr.count))")
        try savePNG(pixels, width: W, height: H, to: out)
        print("saved \(out.path)")
        return Krea2GenerateResult(imageURL: out, seed: seed)
    }

    static func vaeMeanStd() -> (MLXArray, MLXArray) {
        let cfgURL = vaeConfig
        let data = try! Data(contentsOf: cfgURL)
        let json = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let mean = (json["latents_mean"] as! [Double]).map { Float($0) }
        let std = (json["latents_std"] as! [Double]).map { Float($0) }
        return (MLXArray(mean).reshaped([1, 1, 1, 16]), MLXArray(std).reshaped([1, 1, 1, 16]))
    }

    /// Save (1,H,W,3) [-1,1] MLXArray as PNG (CGContext + ImageIO, mirrors PNGFrameWriter).
    static func savePNG(_ pixels: MLXArray, width: Int, height: Int, to url: URL) throws {
        let rescaled = ((MLX.clip(pixels, min: -1.0, max: 1.0) + 1.0) * 127.5).asType(.float32)
        let frame = rescaled[0]                                   // (H,W,3)
        MLX.eval(frame)
        let floats = frame.asArray(Float.self)
        var rgba = [UInt8](repeating: 255, count: width * height * 4)
        let n = width * height
        for i in 0..<n {
            rgba[i * 4 + 0] = UInt8(max(0, min(255, floats[i * 3 + 0])))
            rgba[i * 4 + 1] = UInt8(max(0, min(255, floats[i * 3 + 1])))
            rgba[i * 4 + 2] = UInt8(max(0, min(255, floats[i * 3 + 2])))
        }
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: &rgba, width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: width * 4, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue),
              let cgImage = ctx.makeImage() else {
            throw NSError(domain: "Krea2Engine", code: 2, userInfo: [NSLocalizedDescriptionKey: "CGContext failed"])
        }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw NSError(domain: "Krea2Engine", code: 3, userInfo: [NSLocalizedDescriptionKey: "CGImageDestination failed"])
        }
        CGImageDestinationAddImage(dest, cgImage, nil)
        if !CGImageDestinationFinalize(dest) {
            throw NSError(domain: "Krea2Engine", code: 4, userInfo: [NSLocalizedDescriptionKey: "PNG write failed"])
        }
    }
}

#if canImport(UniformTypeIdentifiers)
import UniformTypeIdentifiers
#endif
