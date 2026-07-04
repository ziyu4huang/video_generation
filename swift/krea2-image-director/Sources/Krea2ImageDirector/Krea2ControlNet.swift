//
//  Krea2ControlNet.swift
//  Krea2ImageDirector
//
//  Native Swift ControlNet (= Control LoRA) generation. Mirrors `t2i` but:
//    1. loads the Control LoRA + injects its 224 low-rank pairs into the DiT
//       weight dict (consumed by `Krea2DiT.lin`),
//    2. builds control tokens from a control image (depth/pose/edge),
//    3. threads the control tokens into every denoise step's DiT call.
//  See Krea2ControlLoRA.swift + docs/controlnet-styletransfer-port.md.
//

import CoreGraphics
import Foundation
import ImageIO
import MLX
import MLXRandom

public extension Krea2Engine {

    /// Control LoRA weights: promoted mlx-models path first, staging fallback.
    static var controlLoRAWeights: URL {
        let promoted = RepoPaths.mlxModelsRoot
            .appendingPathComponent("transformer/krea2-depth-control-lora/model.safetensors")
        if FileManager.default.fileExists(atPath: promoted.path) { return promoted }
        return RepoPaths.krea2Staging.appendingPathComponent("depth-control-lora.safetensors")
    }

    /// Pure-Swift ControlNet generation. `controlImage` is a pre-processed
    /// conditioning image (e.g. a depth map). `strength` scales the control
    /// signal at the input projection (0 = no control, 1 = full).
    @discardableResult
    static func controlnet(
        prompt: String, controlImage: URL, controlLoRA: URL,
        strength: Float = 1.0,
        grayscale: Bool = true, minmax: Bool = true, invert: Bool = false,
        width: Int = 1024, height: Int = 1024,
        steps: Int = 8, seed: Int = 42, mu: Double = 1.15, out: URL
    ) throws -> Krea2GenerateResult {
        let cfg = Krea2Config()
        let patch = cfg.patch, compression = 8
        let align = compression * patch
        let W = ((width + align - 1) / align) * align
        let H = ((height + align - 1) / align) * align
        let (Hl, Wl) = (H / compression, W / compression)
        print("[krea2] native controlnet \(W)x\(H) strength=\(strength) steps=\(steps) seed=\(seed)")

        print("[1/5] text encoder...", terminator: " ")
        let enc = try Krea2TextEncoder(weightsDir: instructDir, tokenizerDir: tokenizerDir)
        let (context, txtmask) = enc.encode([prompt])
        MLX.eval(context, txtmask); print("ok")

        print("[2/5] control image → tokens...", terminator: " ")
        let vaeRaw = try loadArrays(url: vaeWeights)
        let (mean, std) = vaeMeanStd()
        let ctrlTokens = try Krea2ControlImage.tokens(
            controlImage: controlImage, width: W, height: H,
            vaeRaw: vaeRaw, vaeMean: mean, vaeStd: std, patch: patch,
            preprocess: .init(grayscale: grayscale, minmax: minmax, invert: invert))
        MLX.eval(ctrlTokens); print("ctrl \(ctrlTokens.shape)")

        print("[3/5] Control LoRA + DiT weights...", terminator: " ")
        let loraRaw = try loadArrays(url: controlLoRA)
        let lora = try Krea2ControlLoRA(weights: loraRaw, layers: cfg.layers, rank: 64)
        var ditWeights = try loadArrays(url: turboWeights)
        ditWeights = lora.injectIntoDiTWeights(ditWeights)
        let dit = Krea2DiT(config: cfg, weights: ditWeights,
                           firstControl: lora.firstControl, firstControlBias: lora.firstBias)
        print("ok")

        print("[4/5] denoise (control)...", terminator: " ")
        MLXRandom.seed(UInt64(seed))
        let noise = MLXRandom.normal([1, 16, Hl, Wl])
        var (imgTokens, pos, mask) = Krea2Sampler.prepare(
            noise: noise, txtlen: context.dim(1), patch: patch, txtmask: txtmask)
        let ts = Krea2Sampler.timesteps(seqLen: imgTokens.dim(1), steps: steps, mu: mu)
        for i in 0..<(ts.count - 1) {
            let tcurr = ts[i], tprev = ts[i + 1]
            let v = dit(img: imgTokens, context: context, t: MLXArray([tcurr]),
                        pos: pos, mask: mask, controlTokens: ctrlTokens, controlStrength: strength)
            imgTokens = imgTokens + (tprev - tcurr) * v
            MLX.eval(imgTokens)
            if (i + 1) % 2 == 0 || i == ts.count - 2 { print("\(i+1)/\(ts.count-1)", terminator: " ") }
        }
        print()

        print("[5/5] VAE decode...", terminator: " ")
        let (Ht, Wt) = (Hl / patch, Wl / patch)
        var lat = imgTokens.reshaped([1, Ht, Wt, 16, patch, patch])
            .transposed(0, 3, 1, 4, 2, 5).reshaped([1, 16, Hl, Wl])
        lat = lat.transposed(0, 2, 3, 1) * std + mean
        MLX.eval(lat)
        let pixels = Krea2VAE.decode(lat, vaeRaw)
        try savePNG(pixels, width: W, height: H, to: out)
        print("saved \(out.path)")
        return Krea2GenerateResult(imageURL: out, seed: seed)
    }
}
