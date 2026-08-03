//
//  PostProcessFilters.swift
//  Flux2Director
//
//  Pure-MLXArray reimplementation of app/postprocess.py's PostProcessChain
//  (4 of 5 filters — LUT grading deferred, see
//  .planning/specs/2026-08-03-postprocess-swift-native-port-design.md).
//  Every function is (1,3,H,W) float32 [0,1] MLXArray -> MLXArray, matching
//  every other stage in the workflow chain — no image-codec or
//  Accelerate/vImage dependency.
//
//  Fidelity note: these are algorithmic ports (matching each filter's math),
//  not bit-exact reproductions of Python's numpy/cv2 output — same bar the
//  existing XDoG/scribble ControlNet preprocessor port already established
//  for classical-CV code in this repo. FilmGrain's RNG will never match
//  Python's np.random.default_rng bit-for-bit either way.
//

import Foundation
import MLX
import MLXRandom

public enum PostProcessFilters {
    /// Direct port of FilmGrain.apply (postprocess.py): Gaussian noise +
    /// optional warm/cool temperature shift + optional vignette falloff.
    public static func filmGrain(
        _ image: MLXArray, intensity: Float = 0.02, temperature: Float = 0.0,
        vignette: Float = 0.0, seed: UInt64? = nil
    ) -> MLXArray {
        let h = image.dim(2), w = image.dim(3)
        if let seed { MLXRandom.seed(seed) }
        let noise = MLXRandom.normal([1, 3, h, w]) * intensity
        var out = MLX.clip(image + noise, min: 0.0, max: 1.0)

        if temperature != 0 {
            let temp = MLXArray([temperature, Float(0.0), -temperature], [1, 3, 1, 1])
            out = MLX.clip(out + temp, min: 0.0, max: 1.0)
        }
        if vignette > 0 {
            let falloff = vignetteFalloff(h: h, w: w, strength: vignette)
            out = MLX.clip(out * falloff.reshaped([1, 1, h, w]), min: 0.0, max: 1.0)
        }
        return out
    }

    /// Radial falloff: 1 at center, (1 - strength) at the farthest corner.
    /// Direct port of FilmGrain.apply's vignette block (postprocess.py).
    static func vignetteFalloff(h: Int, w: Int, strength: Float) -> MLXArray {
        let cy = Float(h) / 2.0, cx = Float(w) / 2.0
        let ys = MLX.arange(0, h).asType(.float32).reshaped([h, 1])
        let xs = MLX.arange(0, w).asType(.float32).reshaped([1, w])
        let dy = ys - cy, dx = xs - cx
        let dist = MLX.sqrt(MLX.square(dy) + MLX.square(dx))       // (h,w), broadcasts
        let maxDist = sqrtf(cx * cx + cy * cy)
        let normalized = dist / maxDist
        let falloff = 1.0 - strength * MLX.square(normalized)
        return MLX.clip(falloff, min: 0.0, max: 1.0)
    }
}

extension PostProcessFilters {
    /// 3-channel wrapper over Flux2Composite.boxBlur (3 box-blur passes ≈
    /// gaussian, the SAME technique Flux2Composite.featherMask already uses
    /// for mask feathering) — no new blur primitive, just per-channel reuse.
    ///
    /// `sigma` -> `radius` conversion is derived (and empirically verified
    /// against this repo's actual cumulative-sum `boxBlur`, not assumed)
    /// from the variance of 3 independent box-filter passes at the same
    /// radius: each box pass of window `2r+1` has variance `((2r+1)^2-1)/12`;
    /// summing 3 independent passes gives `sigma^2 = ((2r+1)^2-1)/4`, so
    /// `r = (sqrt(4*sigma^2+1) - 1) / 2`. An impulse-response probe against
    /// `Flux2Composite.boxBlur` confirmed this to 5-6 significant figures at
    /// r=1..10 (e.g. r=4 measures sigma=4.4721, formula predicts 4.4721 —
    /// NOT the previous `sigma*1.88` guess, which was ~2x too strong).
    static func gaussianBlurRGB(_ image: MLXArray, sigma: Float) -> MLXArray {
        let radius = max(1, Int((((4 * sigma * sigma + 1).squareRoot() - 1) / 2).rounded()))
        let h = image.dim(2), w = image.dim(3)
        var channels: [MLXArray] = []
        for c in 0..<3 {
            var plane = image[0..., c..<(c + 1), 0..., 0...].reshaped([h, w])
            // 3 passes of box blur (same radius each) ≈ gaussian — matches
            // Flux2Composite.featherMask's own technique exactly.
            for _ in 0..<3 { plane = Flux2Composite.boxBlur(plane, radius: radius) }
            channels.append(plane)
        }
        return MLX.stacked(channels, axis: 0).reshaped([1, 3, h, w])
    }

    /// Unsharp mask: original + amount * (original - blurred). Direct port
    /// of Sharpening._unsharp (postprocess.py), radius given in PIXELS
    /// (matches Python's PIL GaussianBlur radius). PIL's `radius` parameter
    /// IS the gaussian standard deviation directly (confirmed against
    /// Pillow's own docstring and empirical measurement on Pillow 11.3.0 and
    /// this repo's venv 12.2.0: radius=3 measures sigma≈3.03, radius=6
    /// measures sigma≈5.48) — no /2 conversion.
    static func unsharpMask(_ image: MLXArray, radius: Int, amount: Float) -> MLXArray {
        let blurred = gaussianBlurRGB(image, sigma: Float(radius))
        return image + amount * (image - blurred)
    }
}

extension PostProcessFilters {
    /// AMD FidelityFX Contrast Adaptive Sharpening. Direct port of
    /// Sharpening._cas (postprocess.py): for each pixel, blend it with its
    /// 4-neighbor (up/down/left/right) average, weighted by local contrast
    /// (low local contrast -> more sharpening, matching the Python's
    /// `weight = min(0.125 / (diff + 0.001), 1.0) * strength`).
    static func cas(_ image: MLXArray, strength: Float) -> MLXArray {
        let h = image.dim(2), w = image.dim(3)
        let padded = MLX.padded(image, widths: [[0, 0], [0, 0], [1, 1], [1, 1]])
        let center = padded[0..., 0..., 1..<(h + 1), 1..<(w + 1)]
        let up     = padded[0..., 0..., 0..<h,       1..<(w + 1)]
        let down   = padded[0..., 0..., 2..<(h + 2),  1..<(w + 1)]
        let left   = padded[0..., 0..., 1..<(h + 1),  0..<w]
        let right  = padded[0..., 0..., 1..<(h + 1),  2..<(w + 2)]

        let crossMax = MLX.maximum(MLX.maximum(up, down), MLX.maximum(left, right))
        let crossMin = MLX.minimum(MLX.minimum(up, down), MLX.minimum(left, right))
        let diff = crossMax - crossMin
        let weight = MLX.where(
            diff .> 0.001,
            MLX.minimum(MLXArray(Float(0.125)) / (diff + 0.001), MLXArray(Float(1.0))) * strength,
            MLXArray(Float(1.0)))
        let avg = (up + down + left + right) / 4.0
        return center + weight * (center - avg)
    }

    /// Direct port of Sharpening.apply: CAS, then an optional unsharp pass.
    /// Note: in this port's actual call path (PostProcessChain, matching
    /// Python's PostProcessChain.from_config), `unsharpRadius`/`unsharpAmount`
    /// are never set — the workflow's `--sharpening` flag drives CAS
    /// strength only, same as Python's real usage
    /// (`Sharpening(cas_strength=sharp)` with no unsharp args).
    public static func sharpening(
        _ image: MLXArray, casStrength: Float = 0.1,
        unsharpRadius: Int = 0, unsharpAmount: Float = 0.0
    ) -> MLXArray {
        var out = image
        if casStrength > 0 {
            out = cas(out, strength: casStrength)
        }
        if unsharpRadius > 0 && unsharpAmount > 0 {
            out = unsharpMask(out, radius: unsharpRadius, amount: unsharpAmount)
        }
        return MLX.clip(out, min: 0.0, max: 1.0)
    }
}
