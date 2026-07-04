//
//  Krea2ControlStyle.swift
//  2ImageDirector
//
//  Composition path: ControlNet (Control LoRA) + training-free Style Transfer in
//  ONE engine call. The two features modify orthogonal DiT paths — the LoRA's 224
//  low-rank deltas + control-half input projection (input / block linears) vs.
//  Style Transfer's ref K/V injection (attention in blocks 7..27) — so they
//  stack in a single forward. See docs/controlnet-styletransfer-validation.md
//  (composition addendum).
//
//  Mechanism (merges Krea2ControlNet + Krea2StyleTransfer):
//    1. Load the Control LoRA; inject its 224 pairs into the DiT weight dict
//       (consumed by `lin`) + attach `firstControl`/`firstBias` (input proj).
//    2. Build control tokens from the control image (depth/pose/edge).
//    3. Build the style ref's clean latent + Reference-Forecast cache. The RF
//       cache integrates the ref with the SAME LoRA-injected base model velocity
//       (no control tokens → control off for the ref; the control image is a
//       target-side condition, the ref is a style image).
//    4. Main denoise: 2B batch [target ; ref_noisy_σ]. The DiT carries LoRA +
//       firstControl + style. Control tokens are passed for BOTH batches but the
//       ref batch's row is zeros, so `controlStrength * (zeros @ firstControl.T)`
//       = 0 → the ref is not depth-conditioned (matches the no-control RF cache).
//       Styled attention injects the ref batch's K/V into the target attention.
//

import CoreGraphics
import Foundation
import ImageIO
import MLX
import MLXRandom

public extension Krea2Engine {

    /// ControlNet + Style Transfer composition. `controlImage` is a preprocessed
    /// conditioning image (depth/pose/edge); `styleImage` is the visual style
    /// reference; generation follows `prompt`. `controlStrength` scales the
    /// control signal at the input projection; `strength` is the style blend.
    @discardableResult
    static func controlStyle(
        prompt: String,
        controlImage: URL, controlLoRA: URL,
        styleImage: URL,
        controlStrength: Float = 1.0,
        grayscale: Bool = true, minmax: Bool = true, invert: Bool = false,
        strength: Float = 1.0,
        width: Int = 1024, height: Int = 1024,
        steps: Int = 8, seed: Int = 42, mu: Double = 1.15,
        knobs: Krea2StyleDefaults = Krea2StyleDefaults(),
        fastRF: Bool = false, out: URL
    ) throws -> Krea2GenerateResult {
        let d = knobs
        let cfg = Krea2Config()
        let patch = cfg.patch, compression = 8
        let align = compression * patch
        let W = ((width + align - 1) / align) * align
        let H = ((height + align - 1) / align) * align
        let (Hl, Wl) = (H / compression, W / compression)
        print("[krea2] native control-style \(W)x\(H) ctrl=\(controlStrength) "
              + "style=\(strength) steps=\(steps) seed=\(seed)")

        print("[1/6] text encoder...", terminator: " ")
        let enc = try Krea2TextEncoder(weightsDir: instructDir, tokenizerDir: tokenizerDir)
        let (context1, txtmask1) = enc.encode([prompt])
        MLX.eval(context1, txtmask1); print("ok")

        // Duplicate context + txtmask to batch=2 ([target ; ref] share the prompt).
        let context = MLX.repeated(context1, count: 2, axis: 0)
        let txtmask = MLX.repeated(txtmask1, count: 2, axis: 0)
        let txtlen = context1.dim(1)

        print("[2/6] control image → tokens + style → ref latent...", terminator: " ")
        let vaeRaw = try loadArrays(url: vaeWeights)
        let (mean, std) = vaeMeanStd()
        // Control tokens (1, N, 64).
        let ctrlTokens = try Krea2ControlImage.tokens(
            controlImage: controlImage, width: W, height: H,
            vaeRaw: vaeRaw, vaeMean: mean, vaeStd: std, patch: patch,
            preprocess: .init(grayscale: grayscale, minmax: minmax, invert: invert))
        MLX.eval(ctrlTokens)
        // Style ref clean latent (resized to target W×H so N matches).
        let (styleArr, sw, sh) = try loadImageResized(styleImage, width: W, height: H)
        let styleNative = Krea2VAE.encode(styleArr, vaeRaw)
        let refCleanCL = (styleNative - mean) / std
        let refClean = refCleanCL.transposed(0, 3, 1, 2)                  // (1,16,Hl,Wl)
        MLX.eval(refClean)
        print("ctrl \(ctrlTokens.shape) style \(sw)x\(sh)")

        print("[3/6] Control LoRA + DiT weights...", terminator: " ")
        let loraRaw = try loadArrays(url: controlLoRA)
        let lora = try Krea2ControlLoRA(weights: loraRaw, layers: cfg.layers, rank: 64)
        var ditWeights = try loadArrays(url: turboWeights)
        ditWeights = lora.injectIntoDiTWeights(ditWeights)
        // Base DiT for the RF cache: LoRA-injected, NO style, firstControl
        // attached but dormant (no controlTokens passed → control off for ref).
        let baseDit = Krea2DiT(config: cfg, weights: ditWeights,
                               firstControl: lora.firstControl, firstControlBias: lora.firstBias)
        print("ok")

        // ── Positions/mask once (target + ref share W×H).
        MLXRandom.seed(UInt64(seed))
        let noiseT = MLXRandom.normal([1, 16, Hl, Wl])
        let (imgTokens1, pos1, mask1) = Krea2Sampler.prepare(
            noise: noiseT, txtlen: txtlen, patch: patch, txtmask: txtmask1)
        let N = imgTokens1.dim(1)
        let pos = MLX.repeated(pos1, count: 2, axis: 0)
        let mask = MLX.repeated(mask1, count: 2, axis: 0)
        let ts = Krea2Sampler.timesteps(seqLen: N, steps: steps, mu: mu)

        // Text path is identical across every denoise step + both batches → ONCE.
        let ctx1Cache = baseDit.textPath(context: context1, mask: mask1)
        MLX.eval(ctx1Cache)
        let ctx2 = MLX.repeated(ctx1Cache, count: 2, axis: 0)

        // ── (1) RF cache: LoRA-injected base velocity, control OFF (ref has no
        //    control image). Mirrors styleTransfer's cache but on the LoRA base.
        print("[4/6] RF cache (Heun PC, γ=\(d.gamma), LoRA base)...", terminator: " ")
        let rfT0 = Date()
        let eps = MLXRandom.normal([1, 16, Hl, Wl])
        var refCache: [Float: MLXArray] = [:]
        refCache[0.0] = refClean
        var lastSigma: Float = 0.0
        let ascending = ts.filter { $0 > 1e-6 }.sorted()
        var z = refClean
        for sigma in ascending {
            let (imgS2, _, _) = Krea2Sampler.prepare(
                noise: z, txtlen: txtlen, patch: patch, txtmask: txtmask1)
            let v0 = baseDit(img: imgS2, context: context1, t: MLXArray([lastSigma]),
                             pos: pos1, mask: mask1, cachedCtx: ctx1Cache)
            let delta = sigma - lastSigma
            let zPred = latentStep(z, v0, imgTokens: imgS2, Hl: Hl, Wl: Wl, patch: patch, delta: delta)
            let zModel: MLXArray
            if fastRF {
                zModel = zPred
            } else {
                let (imgE2, _, _) = Krea2Sampler.prepare(
                    noise: zPred, txtlen: txtlen, patch: patch, txtmask: txtmask1)
                let v1 = baseDit(img: imgE2, context: context1, t: MLXArray([sigma]),
                                 pos: pos1, mask: mask1, cachedCtx: ctx1Cache)
                zModel = latentHeun(z, v0, v1, imgTokens: imgS2, Hl: Hl, Wl: Wl,
                                    patch: patch, delta: delta)
            }
            let zPrior = (1.0 - sigma) * refClean + sigma * eps
            z = MLXArray(d.gamma) * zModel + (1.0 - d.gamma) * zPrior
            MLX.eval(z)
            refCache[sigma] = z
            lastSigma = sigma
        }
        print("cached \(refCache.count) sigmas in \(String(format: "%.1f", Date().timeIntervalSince(rfT0)))s")

        // ── (2)+(3) Main denoise: LoRA + firstControl + styled 2B DiT. Control
        //    tokens are threaded for both batches but the ref row is zeros → the
        //    ref's input projection is unchanged (matches the no-control cache).
        print("[5/6] denoise (LoRA + styled 2B + control)...", terminator: " ")
        let mainT0 = Date()
        let ctrlZeros = MLX.zeros(ctrlTokens.shape)                      // (1, N, 64) ref-row zeros
        let ctrl2 = MLX.concatenated([ctrlTokens, ctrlZeros], axis: 0)   // (2, N, 64)
        MLX.eval(ctrl2)
        MLXRandom.seed(UInt64(seed))                                     // re-seed for target noise
        let targetNoise = MLXRandom.normal([1, 16, Hl, Wl])
        var (imgTokens, _, _) = Krea2Sampler.prepare(
            noise: targetNoise, txtlen: txtlen, patch: patch, txtmask: txtmask1)
        for i in 0..<(ts.count - 1) {
            let tcurr = ts[i], tprev = ts[i + 1]
            let progress = Float(i) / Float(max(ts.count - 2, 1))
            // Upstream rescales the per-frequency scale endpoints by strength
            // (nodes.py:1987-1989). Identity at strength=1.0; only diverges at
            // partial strength. See `effectiveScaleEndpoints` for the gate analysis.
            let (effHighStart, effLowEnd) = effectiveScaleEndpoints(
                highStart: d.highScaleStart, lowEnd: d.lowScaleEnd, strength: strength)
            let scaleVec = styleScaleVec(progress: progress, beta: d.beta,
                                         highStart: effHighStart, highEnd: d.highScaleEnd,
                                         lowStart: d.lowScaleStart, lowEnd: effLowEnd,
                                         headDim: cfg.headDim)
            // Upstream rescales adain by strength (nodes.py effective_adain).
            let mix = max(0, min(1, strength))
            let effAdain = max(0, min(d.adainStrength * min(strength, 1.25), 1.0))
            let styleCfg = Krea2StyleConfig(
                targetB: 1, imgS: txtlen, imgE: txtlen + N,
                activeBlocks: Set(d.activeBlocks),
                scaleVec: scaleVec, refKStrength: d.refKStrength,
                valueAdainStrength: d.valueAdainStrength, refValueMix: d.refValueMix,
                adainStrength: effAdain,
                mix: mix)
            // Per-step DiT: LoRA weights + firstControl + style. (Rebuilding the
            // thin struct per step is cheap — weights are shared by reference.)
            let styledDit = Krea2DiT(config: cfg, weights: ditWeights,
                                     firstControl: lora.firstControl, firstControlBias: lora.firstBias,
                                     style: styleCfg)

            let refNoisy = refCache[nearestSigma(tcurr, in: refCache)] ?? refClean
            let (refTokens, _, _) = Krea2Sampler.prepare(
                noise: refNoisy, txtlen: txtlen, patch: patch, txtmask: txtmask1)
            let img2 = MLX.concatenated([imgTokens, refTokens], axis: 0)  // (2,N,64)
            let t2 = MLXArray([tcurr, tcurr])
            let v2 = styledDit(img: img2, context: context, t: t2, pos: pos, mask: mask,
                               controlTokens: ctrl2, controlStrength: controlStrength, cachedCtx: ctx2)
            let vT = v2[0..<1]                                            // target velocity
            imgTokens = imgTokens + (tprev - tcurr) * vT
            MLX.eval(imgTokens)
            if (i + 1) % 2 == 0 || i == ts.count - 2 { print("\(i+1)/\(ts.count-1)", terminator: " ") }
        }
        print("(\(String(format: "%.1f", Date().timeIntervalSince(mainT0)))s)")

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
}
