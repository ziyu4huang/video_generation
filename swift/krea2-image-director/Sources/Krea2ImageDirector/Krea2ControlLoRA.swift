//
//  Krea2ControlLoRA.swift
//  Krea2ImageDirector
//
//  Pure-Swift/MLX port of facok/comfyui-krea2-controlnet (Patil/Krea-2-depth-
//  controlnet). The "ControlNet" is actually a rank-64 Control LoRA + an
//  expanded input projection. See docs/controlnet-styletransfer-port.md.
//
//  Two parts (both loaded from one safetensors, ~862 MB):
//    (1) firstControl — the control half of the expanded `first` projection,
//        shape (features, controlFeatures) = (6144, 64). Injected ONCE at the
//        DiT input: x = first_base(img) + firstControl(controlTokens).
//    (2) 224 rank-64 LoRA pairs on blocks.0..27 {attn.wq,wk,wv,wo,gate,
//        mlp.gate,up,down}. α = rank = 64 → scale 1.0. Stored as low-rank
//        A(in,r)/B(out,r) and applied inside `lin()` (keeps base Q8 untouched).
//
//  Control-image → control-tokens pipeline mirrors facok `_prepare_control_image`
//  + `_control_tokens_from_latent`: load → (gray/minmax/invert) preprocess →
//  VAE encode → diffusion-space normalize → patchify.
//

import CoreGraphics
import Foundation
import ImageIO
import MLX

/// The 8 LoRA targets per block (facok LORA_TARGETS).
private let krea2ControlLoRATargets = [
    "attn.wq", "attn.wk", "attn.wv", "attn.wo", "attn.gate",
    "mlp.gate", "mlp.up", "mlp.down",
]

/// A parsed Control LoRA: the control-half input projection + 224 low-rank pairs
/// keyed by their DiT path (`blocks.{i}.{target}`).
public struct Krea2ControlLoRA {
    public let firstControl: MLXArray          // (features, controlFeatures) = (6144, 64)
    public let firstBias: MLXArray?             // (features,) optional
    public let pairs: [String: (A: MLXArray, B: MLXArray)]  // base → (A(in,r), B(out,r))
    public let rank: Int

    /// Load + parse a Control LoRA safetensors. Tolerates the 6 LoRA key
    /// conventions facok accepts (A/B, lora_A/lora_B, lora_down/lora_up, …) and
    /// both A/B axis orders (transposes to A(in,r)/B(out,r) with r = rank).
    public init(weights raw: [String: MLXArray], layers: Int = 28, rank: Int = 64) throws {
        self.rank = rank
        // ── firstControl: locate the expanded first.weight (features, 128) and
        //    take the control half [:, features..]. Search every naming variant.
        let firstKey = Krea2ControlLoRA.findFirstKey(in: raw)
        guard let firstW = firstKey.flatMap({ raw[$0] }) else {
            throw NSError(domain: "Krea2ControlLoRA", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "no `first.weight` (expanded input projection) found in Control LoRA",
            ])
        }
        let fst = firstW[0..., (rank)..<(firstW.dim(1))]     // (features, controlFeatures)
        self.firstControl = fst
        self.firstBias = raw["first.bias"] ?? raw["diffusion_model.first.bias"]
            ?? raw["model.diffusion_model.first.bias"]

        // ── LoRA pairs: scan all keys, classify A/B by suffix, group by base,
        //    keep bases that resolve to `blocks.{i}.{target}`.
        var grouped: [String: [String: MLXArray]] = [:]      // base → {"A":..,"B":..}
        for (k, v) in raw {
            guard let (base, role) = Krea2ControlLoRA.classifyLoRAKey(k) else { continue }
            grouped[base, default: [:]][role] = v
        }
        var pairs: [String: (MLXArray, MLXArray)] = [:]
        for i in 0..<layers {
            for t in krea2ControlLoRATargets {
                let p = "blocks.\(i).\(t)"
                // Try the base with and without the common diffusion_model. prefix.
                if let g = grouped[p] ?? grouped["diffusion_model.\(p)"]
                    ?? grouped["model.diffusion_model.\(p)"]
                    ?? grouped["transformer.\(p)"],
                   let a = g["A"], let b = g["B"] {
                    pairs[p] = Krea2ControlLoRA.normalizePair(a: a, b: b, rank: rank)
                }
            }
        }
        self.pairs = pairs
        if pairs.isEmpty {
            print("[control-lora] WARNING: 0 LoRA pairs matched (expected \(layers * 8)); "
                  + "control half only will be applied. Check key conventions.")
        } else {
            print("[control-lora] loaded \(pairs.count)/\(layers * 8) LoRA pairs + control half "
                  + "(rank \(rank), first from \"\(firstKey ?? "?")\")")
        }
    }

    /// Merge the LoRA A/B pairs into a DiT weight dict under `<prefix>.lora.A`
    /// and `<prefix>.lora.B` keys (consumed by `Krea2DiT.lin`). `firstControl`
    /// is returned separately (the DiT stores it on itself).
    public func injectIntoDiTWeights(_ w: [String: MLXArray]) -> [String: MLXArray] {
        var out = w
        for (p, pair) in pairs {
            out["\(p).lora.A"] = pair.A   // (in, r)
            out["\(p).lora.B"] = pair.B   // (out, r)
        }
        return out
    }

    // MARK: - key parsing helpers

    /// Match `first.weight` / `diffusion_model.first.weight` / … / any key
    /// ending in `first.weight` or `img_in.weight` whose 2nd dim == 2*rank.
    static func findFirstKey(in w: [String: MLXArray]) -> String? {
        let preferred = ["first.weight", "diffusion_model.first.weight",
                         "model.diffusion_model.first.weight", "transformer.first.weight"]
        for k in preferred where w[k] != nil { return k }
        for (k, v) in w {
            if (k.hasSuffix("first.weight") || k.hasSuffix("img_in.weight"))
                && v.dim(0) == 6144 && v.dim(1) == 2 * 64 {
                return k
            }
        }
        return nil
    }

    /// Classify a safetensors key as a LoRA A or B weight; return (base, role).
    /// Tolerates the conventions: `.A`/`.B`, `.lora_A[.weight]`/`.lora_B[.weight]`,
    /// `.lora_down[.weight]`/`.lora_up[.weight]`, `_lora.down[.weight]`/`_lora.up[.weight]`.
    static func classifyLoRAKey(_ k: String) -> (base: String, role: String)? {
        // Order matters: longest suffixes first.
        let aSuffixes = ["lora_A.weight", "lora_A", "lora_down.weight", "lora_down",
                         "_lora.down.weight", "_lora.down", ".A"]
        let bSuffixes = ["lora_B.weight", "lora_B", "lora_up.weight", "lora_up",
                         "_lora.up.weight", "_lora.up", ".B"]
        for s in aSuffixes where k.hasSuffix(s) {
            return (String(k.dropLast(s.count)), "A")
        }
        for s in bSuffixes where k.hasSuffix(s) {
            return (String(k.dropLast(s.count)), "B")
        }
        return nil
    }

    /// Normalize a LoRA pair to A(in,r) / B(out,r), tolerating either axis order.
    /// r is detected as the dim of size `rank` (shared between A and B).
    static func normalizePair(a: MLXArray, b: MLXArray, rank: Int) -> (A: MLXArray, B: MLXArray) {
        // A: one dim is `rank` (→ r); the other is `in`. Make it (in, r).
        let aN = (a.dim(0) == rank) ? a.transposed(1, 0) : a   // assume (rank,in)→(in,rank)
        let bN = (b.dim(1) == rank) ? b : b.transposed(1, 0)   // assume (rank,out)→(out,rank)
        return (aN, bN)
    }
}

// MARK: - Control-image → control tokens

public enum Krea2ControlImage {

    public struct Preprocess {
        public let grayscale: Bool       // R·.299+G·.587+B·.114, replicated to 3ch
        public let minmax: Bool          // per-image min-max to [0,1]
        public let invert: Bool          // 1 - x
        public init(grayscale: Bool = false, minmax: Bool = false, invert: Bool = false) {
            self.grayscale = grayscale; self.minmax = minmax; self.invert = invert
        }
    }

    /// Load + resize a control image to (1,H,W,3) in [-1,1]. `w`/`h` are the
    /// TARGET pixel dims (must match the generation, so the VAE latent aligns).
    static func loadResized(_ url: URL, width w: Int, height h: Int) throws -> MLXArray {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let cg0 = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            throw NSError(domain: "Krea2ControlImage", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "failed to load control image \(url.path)",
            ])
        }
        // CGContext draw resizes (lanczos-equivalent via CG interpolation).
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &rgba, width: w, height: h, bitsPerComponent: 8,
                                  bytesPerRow: w * 4, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw NSError(domain: "Krea2ControlImage", code: 2, userInfo: [NSLocalizedDescriptionKey: "CGContext failed"])
        }
        ctx.interpolationQuality = .high
        ctx.draw(cg0, in: CGRect(x: 0, y: 0, width: w, height: h))
        var rgb = [Float](repeating: 0, count: w * h * 3)
        for i in 0..<(w * h) {
            rgb[i * 3 + 0] = Float(rgba[i * 4 + 0]) / 255.0
            rgb[i * 3 + 1] = Float(rgba[i * 4 + 1]) / 255.0
            rgb[i * 3 + 2] = Float(rgba[i * 4 + 2]) / 255.0
        }
        return MLXArray(rgb).reshaped([1, h, w, 3])            // (1,H,W,3) in [0,1]
    }

    /// Build control tokens (1, Ht*Wt, controlFeatures=64) from a control image.
    /// Mirrors facok `_prepare_control_image` + `_control_tokens_from_latent`:
    /// preprocess → rescale [-1,1] → VAE encode → diffusion normalize → patchify.
    public static func tokens(controlImage: URL, width: Int, height: Int,
                              vaeRaw: [String: MLXArray], vaeMean: MLXArray, vaeStd: MLXArray,
                              patch: Int, preprocess: Preprocess) throws -> MLXArray {
        var img = try loadResized(controlImage, width: width, height: height)   // (1,H,W,3) [0,1]
        if preprocess.grayscale {
            let r = img[0..., 0..., 0..., 0], g = img[0..., 0..., 0..., 1], b = img[0..., 0..., 0..., 2]
            let gray = r * 0.299 + g * 0.587 + b * 0.114                    // (1,H,W,1)
            img = MLX.stacked([gray, gray, gray], axis: -1)                  // (1,H,W,3)
        }
        if preprocess.minmax {
            let mn = img.min(), mx = img.max()
            let denom = MLX.maximum(mx - mn, MLXArray(1e-6))
            img = (img - mn) / denom
        }
        if preprocess.invert { img = MLXArray(1.0) - img }
        // Rescale [0,1] → [-1,1] (matches ref `depth_rgb * 2 - 1` before VAE encode).
        let pix = img * 2.0 - 1.0

        // VAE encode (channels-last native latent) → diffusion normalize → NCHW.
        var lat = Krea2VAE.encode(pix, vaeRaw)                              // (1,H,W,16) CL
        lat = (lat - vaeMean) / vaeStd                                      // diffusion space
        let latCF = lat.transposed(0, 3, 1, 2)                              // (1,16,Hl,Wl)

        // Patchify to (1, Ht*Wt, 16*patch*patch) — same permute as Krea2Sampler.prepare.
        let (B, C, Hl, Wl) = (latCF.dim(0), latCF.dim(1), latCF.dim(2), latCF.dim(3))
        let (Ht, Wt) = (Hl / patch, Wl / patch)
        var tok = latCF.reshaped([B, C, Ht, patch, Wt, patch])
        tok = tok.transposed(0, 2, 4, 1, 3, 5).reshaped([B, Ht * Wt, C * patch * patch])
        return tok
    }
}
