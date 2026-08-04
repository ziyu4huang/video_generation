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
    ///
    /// Note: unlike Python's `_cas` (which clips to [0,1] before returning),
    /// this does not clip here — `sharpening()` below clips once at the end
    /// of the whole chain instead. Safe today because the real call path
    /// (PostProcessChain, matching Python's `Sharpening(cas_strength=...)`
    /// with no unsharp args) never chains `unsharpMask` after `cas` with an
    /// out-of-range intermediate; revisit if that combination becomes real.
    static func cas(_ image: MLXArray, strength: Float) -> MLXArray {
        let h = image.dim(2), w = image.dim(3)
        // Python pads with mode="reflect"; mlx-swift's PadMode only offers
        // .constant (zero-fill) / .edge (repeat-nearest) — no true reflect.
        // .edge is the closer approximation (avoids pulling border pixels
        // toward 0) and matches this file's existing border convention
        // (Flux2Composite.boxBlur/blurAxis also avoid zero-fill darkening).
        let padded = MLX.padded(image, widths: [[0, 0], [0, 0], [1, 1], [1, 1]], mode: .edge)
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

extension PostProcessFilters {
    /// Windowed joint-bilateral filter: for every offset in a
    /// (2*radius+1)x(2*radius+1) window, accumulate
    /// neighbor * spatial_gaussian(offset) * range_gaussian(neighbor - center),
    /// normalized by the summed weights. Replaces cv2.bilateralFilter
    /// (NoiseCleaner.apply, postprocess.py) — the range-gaussian term is
    /// what makes this edge-preserving (unlike a plain box/gaussian blur):
    /// a neighbor whose color is very different from the center pixel gets
    /// a near-zero weight regardless of how spatially close it is.
    /// `sigmaSpace` is in PIXEL units (matches cv2's convention);
    /// `sigmaColor` is in the [0,1] pixel-value units this port uses
    /// throughout (Python's cv2.bilateralFilter operates on 0-255 uint8, so
    /// its sigmaColor=75.0 maps to 75.0/255.0 here).
    ///
    /// Border handling: uses .edge padding (repeat-nearest), NOT zero-fill —
    /// see cas()'s fix earlier in this file for why zero-fill at image
    /// borders is a real correctness bug (it manufactures a fake color/
    /// spatial discontinuity at every border pixel).
    static func bilateralFilter(_ image: MLXArray, radius: Int, sigmaSpace: Float, sigmaColor: Float) -> MLXArray {
        let h = image.dim(2), w = image.dim(3)
        let padded = MLX.padded(image, widths: [[0, 0], [0, 0], [radius, radius], [radius, radius]], mode: .edge)
        var weightedSum = zeros(like: image)
        var weightSum = zeros(like: image[0..., 0..<1, 0..., 0...])
        for dy in -radius...radius {
            for dx in -radius...radius {
                let neighbor = padded[0..., 0..., (radius + dy)..<(radius + dy + h), (radius + dx)..<(radius + dx + w)]
                let spatialDist2 = Float(dy * dy + dx * dx)
                let spatialWeight = expf(-spatialDist2 / (2 * sigmaSpace * sigmaSpace))
                let colorDist2 = MLX.square(neighbor - image).sum(axis: 1, keepDims: true)   // (1,1,H,W)
                let rangeWeight = MLX.exp(-colorDist2 / (2 * sigmaColor * sigmaColor))
                let weight = rangeWeight * spatialWeight                                     // (1,1,H,W)
                weightedSum = weightedSum + neighbor * weight
                weightSum = weightSum + weight
            }
        }
        return weightedSum / weightSum
    }

    /// Direct port of NoiseCleaner.apply: bilateral denoise, then an
    /// optional unsharp "JPEG scrub" pass (Python: slight gaussian blur +
    /// 0.3-strength unsharp, to restore edge detail the blur removed).
    /// `bilateralRadius` maps to Python's `bilateral_d` diameter as
    /// radius = (d-1)/2 -> default d=9 -> radius=4.
    public static func noiseCleaner(
        _ image: MLXArray, bilateralRadius: Int = 4, sigmaSpace: Float = 75.0, sigmaColor: Float = 75.0 / 255.0,
        jpegScrub: Bool = true
    ) -> MLXArray {
        var out = image
        if bilateralRadius > 0 {
            out = bilateralFilter(out, radius: bilateralRadius, sigmaSpace: sigmaSpace, sigmaColor: sigmaColor)
        }
        if jpegScrub {
            let blurred = gaussianBlurRGB(out, sigma: 0.5)
            out = MLX.clip(out + 0.3 * (out - blurred), min: 0.0, max: 1.0)
        }
        return MLX.clip(out, min: 0.0, max: 1.0)
    }
}

extension PostProcessFilters {
    /// RGB[0,1] -> HSV (H in [0,360), S/V in [0,1]). Implemented as a raw
    /// per-pixel Swift loop over an extracted array — the SAME pattern
    /// `Flux2Composite.blurAxis` uses for its own filter math, and matches
    /// this repo's actual existing HSV-hue precedent
    /// (`LTXVideoDirector/VideoSceneDetector.swift`'s `hueHistogram`, which
    /// computes hue via `truncatingRemainder(dividingBy: 6)` etc. the same
    /// way, also in a raw pixel loop) rather than a vectorized MLXArray
    /// boolean-op formula.
    static func rgbToHSV(_ image: MLXArray) -> (h: [Float], s: [Float], v: [Float]) {
        let h = image.dim(2), w = image.dim(3)
        MLX.eval(image)
        let flat = image.reshaped([3, h * w]).asArray(Float.self)
        var hue = [Float](repeating: 0, count: h * w)
        var sat = [Float](repeating: 0, count: h * w)
        var val = [Float](repeating: 0, count: h * w)
        for i in 0..<(h * w) {
            let r = flat[i], g = flat[h * w + i], b = flat[2 * h * w + i]
            let maxC = max(r, g, b), minC = min(r, g, b)
            let delta = maxC - minC
            var hh: Float
            if delta < 1e-6 {
                hh = 0
            } else if maxC == r {
                hh = 60 * (((g - b) / delta).truncatingRemainder(dividingBy: 6))
            } else if maxC == g {
                hh = 60 * ((b - r) / delta + 2)
            } else {
                hh = 60 * ((r - g) / delta + 4)
            }
            if hh < 0 { hh += 360 }
            hue[i] = hh
            sat[i] = maxC < 1e-6 ? 0 : delta / maxC
            val[i] = maxC
        }
        return (h: hue, s: sat, v: val)
    }

    /// Direct port of SkinContrast.apply's skin-tone mask: two HSV bands
    /// (cv2's [0,30,60]-[25,180,255] and [170,30,60]-[180,180,255], H
    /// doubled and S/V divided by 255 to convert from cv2's 8-bit
    /// convention to this port's [0,360)/[0,1] convention). Returns a
    /// (1,1,H,W) mask in {0,1}.
    public static func skinMask(_ image: MLXArray) -> MLXArray {
        let h = image.dim(2), w = image.dim(3)
        let (hue, sat, val) = rgbToHSV(image)
        func inBand(_ i: Int, hLo: Float, hHi: Float, sLo: Float, sHi: Float, vLo: Float, vHi: Float) -> Bool {
            hue[i] >= hLo && hue[i] <= hHi && sat[i] >= sLo && sat[i] <= sHi && val[i] >= vLo && val[i] <= vHi
        }
        var out = [Float](repeating: 0, count: h * w)
        for i in 0..<(h * w) {
            let band1 = inBand(i, hLo: 0, hHi: 50, sLo: 30.0 / 255.0, sHi: 180.0 / 255.0, vLo: 60.0 / 255.0, vHi: 1.0)
            let band2 = inBand(i, hLo: 340, hHi: 360, sLo: 30.0 / 255.0, sHi: 180.0 / 255.0, vLo: 60.0 / 255.0, vHi: 1.0)
            out[i] = (band1 || band2) ? 1.0 : 0.0
        }
        let result = MLXArray(out, [1, 1, h, w])
        MLX.eval(result)
        return result
    }
}

extension PostProcessFilters {
    /// sRGB[0,1] (1,3,H,W) -> CIE LAB, L in [0,100], a/b roughly [-128,127].
    /// Standard D65 closed-form: sRGB->linear gamma decode, linear->XYZ
    /// matrix, XYZ->LAB f() nonlinearity. Internal round-trip convention
    /// only (verified via testLABRoundTripIsNearIdentity) — not scaled to
    /// cv2's 8-bit LAB range, since the only consumer (skinContrast, Task 7)
    /// round-trips through rgbToLAB -> clahe(L) -> labToRGB.
    public static func rgbToLAB(_ image: MLXArray) -> MLXArray {
        func degamma(_ c: MLXArray) -> MLXArray {
            let low = c / 12.92
            let high = MLX.pow((c + 0.055) / 1.055, MLXArray(Float(2.4)))
            return MLX.where(c .<= 0.04045, low, high)
        }
        let r = degamma(image[0..., 0..<1, 0..., 0...])
        let g = degamma(image[0..., 1..<2, 0..., 0...])
        let b = degamma(image[0..., 2..<3, 0..., 0...])

        let x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375
        let y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750
        let z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041

        let xn: Float = 0.95047, yn: Float = 1.0, zn: Float = 1.08883
        func f(_ t: MLXArray) -> MLXArray {
            let delta: Float = 6.0 / 29.0
            let cubeRootBranch = MLX.pow(MLX.maximum(t, MLXArray(Float(1e-8))), MLXArray(Float(1.0 / 3.0)))
            let linearBranch = t / (3 * delta * delta) + 4.0 / 29.0
            return MLX.where(t .> (delta * delta * delta), cubeRootBranch, linearBranch)
        }
        let fx = f(x / xn), fy = f(y / yn), fz = f(z / zn)
        let l = 116.0 * fy - 16.0
        let a = 500.0 * (fx - fy)
        let bb = 200.0 * (fy - fz)
        return MLX.concatenated([l, a, bb], axis: 1)
    }

    /// Inverse of rgbToLAB. LAB (1,3,H,W) -> sRGB[0,1].
    public static func labToRGB(_ lab: MLXArray) -> MLXArray {
        let l = lab[0..., 0..<1, 0..., 0...]
        let a = lab[0..., 1..<2, 0..., 0...]
        let bb = lab[0..., 2..<3, 0..., 0...]

        let fy = (l + 16.0) / 116.0
        let fx = fy + a / 500.0
        let fz = fy - bb / 200.0

        func fInv(_ t: MLXArray) -> MLXArray {
            let delta: Float = 6.0 / 29.0
            let cubeBranch = MLX.pow(t, MLXArray(Float(3.0)))
            let linearBranch = 3 * delta * delta * (t - 4.0 / 29.0)
            return MLX.where(t .> delta, cubeBranch, linearBranch)
        }
        let xn: Float = 0.95047, yn: Float = 1.0, zn: Float = 1.08883
        let x = fInv(fx) * xn, y = fInv(fy) * yn, z = fInv(fz) * zn

        let rLin = x * 3.2404542 + y * -1.5371385 + z * -0.4985314
        let gLin = x * -0.9692660 + y * 1.8760108 + z * 0.0415560
        let bLin = x * 0.0556434 + y * -0.2040259 + z * 1.0572252

        func gamma(_ c: MLXArray) -> MLXArray {
            let clamped = MLX.clip(c, min: 0.0, max: 1.0)
            let low = clamped * 12.92
            let high = 1.055 * MLX.pow(clamped, MLXArray(Float(1.0 / 2.4))) - 0.055
            return MLX.where(clamped .<= 0.0031308, low, high)
        }
        let r = gamma(rLin), g = gamma(gLin), b = gamma(bLin)
        return MLX.clip(MLX.concatenated([r, g, b], axis: 1), min: 0.0, max: 1.0)
    }
}

extension PostProcessFilters {
    /// Contrast Limited Adaptive Histogram Equalization on a single-channel
    /// (1,1,H,W) plane in [0,1]. Direct algorithmic port of
    /// SkinContrast.apply's cv2.createCLAHE step: tile the image into
    /// tileGridSize x tileGridSize regions, build a clipped 256-bin
    /// histogram per tile, turn each into a per-tile mapping (CDF), and
    /// bilinearly interpolate between the 4 nearest tile mappings per
    /// pixel. Single-pass clip-redistribute (spreads clipped excess evenly
    /// across all 256 bins once) — a documented simplification of OpenCV's
    /// iterative redistribution. Implemented as a raw Swift loop over an
    /// extracted array (same "materialize, loop, rebuild" pattern
    /// `Flux2Composite.blurAxis` uses) — tile-histogram bookkeeping doesn't
    /// vectorize cleanly into MLXArray ops.
    public static func clahe(_ plane: MLXArray, clipLimit: Float = 2.0, tileGridSize: Int = 8) -> MLXArray {
        let h = plane.dim(2), w = plane.dim(3)
        MLX.eval(plane)
        let src = plane.reshaped([h, w]).asArray(Float.self)

        let tileH = (h + tileGridSize - 1) / tileGridSize
        let tileW = (w + tileGridSize - 1) / tileGridSize
        let nBins = 256

        // Per-tile CDF mapping table: [tileGridSize][tileGridSize][256].
        var mappings = [[[Float]]](
            repeating: [[Float]](repeating: [Float](repeating: 0, count: nBins), count: tileGridSize),
            count: tileGridSize)

        for ty in 0..<tileGridSize {
            for tx in 0..<tileGridSize {
                let y0 = ty * tileH, y1 = min(h, y0 + tileH)
                let x0 = tx * tileW, x1 = min(w, x0 + tileW)
                guard y1 > y0, x1 > x0 else { continue }
                var hist = [Float](repeating: 0, count: nBins)
                for y in y0..<y1 {
                    for x in x0..<x1 {
                        let bin = min(nBins - 1, max(0, Int(src[y * w + x] * Float(nBins - 1))))
                        hist[bin] += 1
                    }
                }
                let pixelCount = Float((y1 - y0) * (x1 - x0))
                let clipThreshold = max(1.0, clipLimit * pixelCount / Float(nBins))
                var excess: Float = 0
                for i in 0..<nBins where hist[i] > clipThreshold {
                    excess += hist[i] - clipThreshold
                    hist[i] = clipThreshold
                }
                let redistribute = excess / Float(nBins)
                for i in 0..<nBins { hist[i] += redistribute }

                var cdf = [Float](repeating: 0, count: nBins)
                var running: Float = 0
                for i in 0..<nBins {
                    running += hist[i]
                    cdf[i] = running
                }
                let total = max(cdf[nBins - 1], 1e-6)
                for i in 0..<nBins { cdf[i] /= total }
                mappings[ty][tx] = cdf
            }
        }

        // Bilinear-interpolate between the 4 nearest tile centers per pixel.
        var out = [Float](repeating: 0, count: h * w)
        for y in 0..<h {
            let ty = Float(y) / Float(tileH) - 0.5
            let ty0 = max(0, min(tileGridSize - 1, Int(floor(ty))))
            let ty1 = max(0, min(tileGridSize - 1, ty0 + 1))
            let fy = max(0, min(1, ty - Float(ty0)))
            for x in 0..<w {
                let tx = Float(x) / Float(tileW) - 0.5
                let tx0 = max(0, min(tileGridSize - 1, Int(floor(tx))))
                let tx1 = max(0, min(tileGridSize - 1, tx0 + 1))
                let fx = max(0, min(1, tx - Float(tx0)))

                let bin = min(nBins - 1, max(0, Int(src[y * w + x] * Float(nBins - 1))))
                let v00 = mappings[ty0][tx0][bin]
                let v01 = mappings[ty0][tx1][bin]
                let v10 = mappings[ty1][tx0][bin]
                let v11 = mappings[ty1][tx1][bin]
                let v0 = v00 * (1 - fx) + v01 * fx
                let v1 = v10 * (1 - fx) + v11 * fx
                out[y * w + x] = v0 * (1 - fy) + v1 * fy
            }
        }
        let result = MLXArray(out, [1, 1, h, w])
        MLX.eval(result)
        return result
    }

    /// Direct port of SkinContrast.apply: HSV skin-tone mask + CLAHE on the
    /// LAB L channel, blended into skin pixels only.
    public static func skinContrast(_ image: MLXArray, clipLimit: Float = 2.0, tileGridSize: Int = 8) -> MLXArray {
        let mask = skinMask(image)
        let lab = rgbToLAB(image)
        let lChannel = lab[0..., 0..<1, 0..., 0...] / 100.0    // normalize L[0,100] -> [0,1] for clahe's bin scaling
        let lEq = clahe(lChannel, clipLimit: clipLimit, tileGridSize: tileGridSize) * 100.0
        let labEq = MLX.concatenated([lEq, lab[0..., 1..<2, 0..., 0...], lab[0..., 2..<3, 0..., 0...]], axis: 1)
        let enhanced = labToRGB(labEq)
        return image * (1.0 - mask) + enhanced * mask
    }
}

public struct PostProcessConfig {
    public var filmGrain: Float = 0        // 0 = off
    public var sharpening: Float = 0       // 0 = off, else CAS strength
    public var skinContrast: Bool = false
    public var noiseClean: Bool = false
    public var seed: UInt64? = nil

    public init() {}
}

public enum PostProcessChain {
    /// Applies the requested subset of filters in Python's fixed order
    /// (PostProcessChain.from_config, postprocess.py): noise_clean ->
    /// skin_contrast -> sharpening -> film_grain. (LUT grading would sit
    /// between sharpening and film_grain — deferred, see design spec.)
    public static func apply(_ image: MLXArray, config: PostProcessConfig) -> MLXArray {
        var out = image
        if config.noiseClean {
            out = PostProcessFilters.noiseCleaner(out)
        }
        if config.skinContrast {
            out = PostProcessFilters.skinContrast(out)
        }
        if config.sharpening > 0 {
            out = PostProcessFilters.sharpening(out, casStrength: config.sharpening)
        }
        if config.filmGrain > 0 {
            out = PostProcessFilters.filmGrain(out, intensity: config.filmGrain, seed: config.seed)
        }
        return out
    }
}
