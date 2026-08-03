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
