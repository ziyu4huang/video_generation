//
//  Krea2StyleTransfer.swift
//  Krea2ImageDirector
//
//  Native Swift port of jieg9341-lab/ComfyUI-Krea2-StyleTransfer (training-free).
//  Three mechanisms (see docs/controlnet-styletransfer-port.md Feature B):
//    (1) Reference-Forecast cache — forward-integrate the style image's clean
//        latent along the sampler sigmas with the base model's own velocity
//        (Heun PC, γ=0.5) → {σ : ref_noisy}.
//    (2) 2B batch each step — concat [target ; ref_noisy_σ], run the full DiT,
//        slice [:targetB].
//    (3) K/V injection in blocks 7..27 — extend target attention with the ref
//        batch's image-token K (per-frequency scaled) + V (AdaIN-mixed). Lives
//        in Krea2DiT.styledAttention, activated by Krea2StyleConfig.
//
//  Minimal viable port: single reference, V-AdaIN + K-scale (the core),
//  flowturbo_pc integrator. Q/K AdaIN + dual-ref deferred (see docs).
//

import CoreGraphics
import Foundation
import ImageIO
import MLX
import MLXRandom

/// "recommended" mode baked defaults (ComfyUI-Krea2-StyleTransfer _RECOMMENDED).
public struct Krea2StyleDefaults {
    public let styleStrength: Float = 1.0
    public let valueAdainStrength: Float = 0.65
    public let refValueMix: Float = 1.0
    public let refKStrength: Float = 1.06
    public let gamma: Float = 0.5
    public let beta: Float = 2.5
    public let highScaleStart: Float = 1.04
    public let highScaleEnd: Float = 0.0
    public let lowScaleStart: Float = 1.0
    public let lowScaleEnd: Float = 1.10
    public let activeBlocks: ClosedRange<Int> = 7...27
}

public extension Krea2Engine {

    /// Pure-Swift training-free style transfer. `styleImage` is the visual
    /// style reference; generation follows `prompt`. `strength` is style_strength.
    @discardableResult
    static func styleTransfer(
        prompt: String, styleImage: URL, strength: Float = 1.0,
        width: Int = 1024, height: Int = 1024,
        steps: Int = 8, seed: Int = 42, mu: Double = 1.15, out: URL
    ) throws -> Krea2GenerateResult {
        let d = Krea2StyleDefaults()
        let cfg = Krea2Config()
        let patch = cfg.patch, compression = 8
        let align = compression * patch
        let W = ((width + align - 1) / align) * align
        let H = ((height + align - 1) / align) * align
        let (Hl, Wl) = (H / compression, W / compression)
        print("[krea2] native style-transfer \(W)x\(H) strength=\(strength) steps=\(steps) seed=\(seed)")

        print("[1/6] text encoder...", terminator: " ")
        let enc = try Krea2TextEncoder(weightsDir: instructDir, tokenizerDir: tokenizerDir)
        let (context1, txtmask1) = enc.encode([prompt])
        MLX.eval(context1, txtmask1); print("ok")

        // Duplicate context + txtmask to batch=2 ([target ; ref] share the prompt).
        let context = MLX.repeated(context1, count: 2, axis: 0)
        let txtmask = MLX.repeated(txtmask1, count: 2, axis: 0)
        let txtlen = context1.dim(1)

        print("[2/6] style image → ref_clean latent...", terminator: " ")
        let vaeRaw = try loadArrays(url: vaeWeights)
        let (mean, std) = vaeMeanStd()
        // Resize the style image to the TARGET W×H so its latent spatial dims
        // match the target's (the ref and target share positions/mask in the
        // 2B batch — their token count N must be identical). loadImage returns
        // native resolution; a 1024² ref into a 512² gen otherwise mismatches.
        let (styleArr, sw, sh) = try loadImageResized(styleImage, width: W, height: H)
        let styleNative = Krea2VAE.encode(styleArr, vaeRaw)              // (1,H,W,16) CL
        let refCleanCL = (styleNative - mean) / std                       // diffusion space, CL
        let refClean = refCleanCL.transposed(0, 3, 1, 2)                  // (1,16,Hl,Wl)
        MLX.eval(refClean); print("style \(sw)x\(sh) -> latent \(refClean.shape)")

        print("[3/6] DiT weights (base, no LoRA)...", terminator: " ")
        let ditWeights = try loadArrays(url: turboWeights)
        let baseDit = Krea2DiT(config: cfg, weights: ditWeights)
        print("ok")

        // ── Build positions/mask once (same for target + ref at same W×H).
        MLXRandom.seed(UInt64(seed))
        let noiseT = MLXRandom.normal([1, 16, Hl, Wl])
        let (imgTokens1, pos1, mask1) = Krea2Sampler.prepare(
            noise: noiseT, txtlen: txtlen, patch: patch, txtmask: txtmask1)
        let N = imgTokens1.dim(1)
        let pos = MLX.repeated(pos1, count: 2, axis: 0)
        let mask = MLX.repeated(mask1, count: 2, axis: 0)
        let ts = Krea2Sampler.timesteps(seqLen: N, steps: steps, mu: mu)

        // ── (1) Reference-Forecast cache: integrate refClean forward through
        //    each sigma with the base model velocity (Heun PC, γ=0.5).
        print("[4/6] RF cache (Heun PC, γ=\(d.gamma))...", terminator: " ")
        let eps = MLXRandom.normal([1, 16, Hl, Wl])                       // fixed noise for the prior
        var refCache: [Float: MLXArray] = [:]
        let prevSigma: Float = 0.0
        var z = refClean
        // Walk sigmas ascending from 0 → each ts (ts is descending 1→0; iterate
        // the ascending reversed list, dropping the trailing 0).
        let ascending = ts.filter { $0 > 1e-6 }.sorted()
        refCache[0.0] = refClean
        var lastSigma = prevSigma
        for sigma in ascending {
            let (imgS2, _, _) = Krea2Sampler.prepare(
                noise: z, txtlen: txtlen, patch: patch, txtmask: txtmask1)
            let v0 = baseDit(img: imgS2, context: context1, t: MLXArray([lastSigma]),
                             pos: pos1, mask: mask1)
            // Euler step from lastSigma → sigma (delta = sigma - lastSigma).
            let delta = sigma - lastSigma
            // Predict z at sigma via the model velocity (latent-space Euler).
            // v0 is a token-space velocity; unpatchify → latent → step.
            let zPred = latentStep(z, v0, imgTokens: imgS2, Hl: Hl, Wl: Wl, patch: patch,
                                    delta: delta)
            let (imgE2, _, _) = Krea2Sampler.prepare(
                noise: zPred, txtlen: txtlen, patch: patch, txtmask: txtmask1)
            let v1 = baseDit(img: imgE2, context: context1, t: MLXArray([sigma]),
                             pos: pos1, mask: mask1)
            let zModel = latentHeun(z, v0, v1, imgTokens: imgS2, Hl: Hl, Wl: Wl,
                                    patch: patch, delta: delta)
            let zPrior = (1.0 - sigma) * refClean + sigma * eps
            z = MLXArray(d.gamma) * zModel + (1.0 - d.gamma) * zPrior
            MLX.eval(z)
            refCache[sigma] = z
            lastSigma = sigma
        }
        print("cached \(refCache.count) sigmas")

        // ── (2)+(3) Main denoise: 2B batch [target ; ref_noisy_σ], styled DiT.
        print("[5/6] denoise (styled 2B)...", terminator: " ")
        MLXRandom.seed(UInt64(seed))                                     // re-seed for the target noise
        let targetNoise = MLXRandom.normal([1, 16, Hl, Wl])
        var (imgTokens, _, _) = Krea2Sampler.prepare(
            noise: targetNoise, txtlen: txtlen, patch: patch, txtmask: txtmask1)
        for i in 0..<(ts.count - 1) {
            let tcurr = ts[i], tprev = ts[i + 1]
            // progress: 0 at noise start (tcurr≈1), 1 at clean (tcurr≈0).
            let progress = Float(i) / Float(max(ts.count - 2, 1))
            let scaleVec = styleScaleVec(progress: progress, beta: d.beta,
                                         highStart: d.highScaleStart, highEnd: d.highScaleEnd,
                                         lowStart: d.lowScaleStart, lowEnd: d.lowScaleEnd,
                                         headDim: cfg.headDim)
            let styleCfg = Krea2StyleConfig(
                targetB: 1, imgS: txtlen, imgE: txtlen + N,
                activeBlocks: Set(d.activeBlocks),
                scaleVec: scaleVec, refKStrength: d.refKStrength,
                valueAdainStrength: d.valueAdainStrength, refValueMix: d.refValueMix,
                mix: max(0, min(1, strength)))
            let styledDit = Krea2DiT(config: cfg, weights: ditWeights, style: styleCfg)

            // ref_noisy at tcurr (closest cached sigma).
            let refNoisy = refCache[nearestSigma(tcurr, in: refCache)] ?? refClean
            let (refTokens, _, _) = Krea2Sampler.prepare(
                noise: refNoisy, txtlen: txtlen, patch: patch, txtmask: txtmask1)
            let img2 = MLX.concatenated([imgTokens, refTokens], axis: 0)  // (2,N,64)
            let t2 = MLXArray([tcurr, tcurr])
            let v2 = styledDit(img: img2, context: context, t: t2, pos: pos, mask: mask)
            let vT = v2[0..<1]                                            // target velocity
            imgTokens = imgTokens + (tprev - tcurr) * vT
            MLX.eval(imgTokens)
            if (i + 1) % 2 == 0 || i == ts.count - 2 { print("\(i+1)/\(ts.count-1)", terminator: " ") }
        }
        print()

        print("[6/6] VAE decode...", terminator: " ")
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

    // MARK: - helpers

    /// Token-velocity → latent-space Euler step. v is (1,N,64); unpatchify to
    /// (1,16,Hl,Wl), then z + delta*v.
    static func latentStep(_ z: MLXArray, _ v: MLXArray, imgTokens: MLXArray,
                           Hl: Int, Wl: Int, patch: Int, delta: Float) -> MLXArray {
        let (Ht, Wt) = (Hl / patch, Wl / patch)
        let vLat = v.reshaped([1, Ht, Wt, 16, patch, patch])
            .transposed(0, 3, 1, 4, 2, 5).reshaped([1, 16, Hl, Wl])
        return z + MLXArray(delta) * vLat
    }
    /// Heun (trapezoid): z + 0.5·delta·(v0 + v1). v0/v1 are token velocities.
    static func latentHeun(_ z: MLXArray, _ v0: MLXArray, _ v1: MLXArray,
                           imgTokens: MLXArray, Hl: Int, Wl: Int, patch: Int,
                           delta: Float) -> MLXArray {
        let (Ht, Wt) = (Hl / patch, Wl / patch)
        let unpatch: (MLXArray) -> MLXArray = { v in
            v.reshaped([1, Ht, Wt, 16, patch, patch])
                .transposed(0, 3, 1, 4, 2, 5).reshaped([1, 16, Hl, Wl])
        }
        return z + MLXArray(0.5 * delta) * (unpatch(v0) + unpatch(v1))
    }

    /// Per-frequency K scale vector over headDim. axes_dims = [hd-12*(hd/16),
    /// 6*(hd/16), 6*(hd/16)] = [32,48,48] for hd=128. Axis 0 flat = low_scale;
    /// axes ≥1: scale = high_scale + (low_scale - high_scale)·linspace^beta.
    static func styleScaleVec(progress: Float, beta: Float,
                              highStart: Float, highEnd: Float,
                              lowStart: Float, lowEnd: Float,
                              headDim: Int) -> MLXArray {
        let h = headDim / 16
        let axes = [headDim - 12 * h, 6 * h, 6 * h]            // [32,48,48]
        let high = highStart + (highEnd - highStart) * progress
        let low = lowStart + (lowEnd - lowStart) * progress
        var vec: [Float] = []
        for (ai, dim) in axes.enumerated() {
            let pairs = dim / 2
            for j in 0..<pairs {
                let t = pairs > 1 ? Float(j) / Float(pairs - 1) : 0
                let s = ai == 0 ? low : (high + (low - high) * Foundation.pow(t, beta))
                vec.append(s); vec.append(s)
            }
        }
        return MLXArray(vec)                                    // (headDim,)
    }

    /// Load + resize a PNG/JPG to (1, H, W, 3) float32 in [-1,1] at target dims
    /// (CGContext high-quality interpolation). Used for the style reference so
    /// its latent matches the target generation's spatial shape.
    static func loadImageResized(_ url: URL, width w: Int, height h: Int) throws -> (MLXArray, Int, Int) {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cg0 = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw NSError(domain: "Krea2StyleTransfer", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "failed to load style image \(url.path)",
            ])
        }
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &rgba, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: w * 4, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw NSError(domain: "Krea2StyleTransfer", code: 2, userInfo: [NSLocalizedDescriptionKey: "CGContext failed"])
        }
        ctx.interpolationQuality = .high
        ctx.draw(cg0, in: CGRect(x: 0, y: 0, width: w, height: h))
        var rgb = [Float](repeating: 0, count: w * h * 3)
        for i in 0..<(w * h) {
            rgb[i * 3 + 0] = Float(rgba[i * 4 + 0]) / 127.5 - 1.0
            rgb[i * 3 + 1] = Float(rgba[i * 4 + 1]) / 127.5 - 1.0
            rgb[i * 3 + 2] = Float(rgba[i * 4 + 2]) / 127.5 - 1.0
        }
        return (MLXArray(rgb).reshaped([1, h, w, 3]), w, h)
    }

    /// Closest cached sigma key to the query (sample sigmas may not be exact).
    static func nearestSigma(_ target: Float, in cache: [Float: MLXArray]) -> Float {
        guard !cache.isEmpty else { return 0.0 }
        var best = cache.keys.first!
        var bestD = abs(best - target)
        for k in cache.keys {
            let dd = abs(k - target)
            if dd < bestD { best = k; bestD = dd }
        }
        return best
    }
}
