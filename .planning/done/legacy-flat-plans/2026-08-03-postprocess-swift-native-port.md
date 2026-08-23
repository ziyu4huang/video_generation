# Post-Process Swift-Native Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `app/postprocess.py`'s 4 real (GUI-exposed) pixel filters — film grain, CAS+unsharp sharpening, bilateral noise-clean, HSV/CLAHE skin-contrast — to a new `flux2 postprocess` Swift/MLX command, and chain it natively into `workflow_native.ts` between face-detail and upscale, closing the last real gap in `workflow_hybrid`'s native path (LUT grading stays deferred — no `.cube` asset exists anywhere in this repo).

**Architecture:** All filters are pure `(1,3,H,W)` float32 `[0,1]` `MLXArray → MLXArray` functions in a new `PostProcessFilters.swift` (library target), composed by a `PostProcessChain` in Python's fixed order (noise_clean → skin_contrast → sharpening → film_grain). A new no-model-load `flux2 postprocess` CLI command exposes them (mirrors `CutoutCommand.swift`'s shape). `workflow_native.ts` gains a new orchestration stage; `bridge.ts`'s `isNativeWorkflowRequest` gate is relaxed for the 4 portable knobs while LUT stays explicitly non-portable.

**Tech Stack:** Swift 6 / mlx-swift (`MLX`, `MLXRandom`), ArgumentParser, XCTest; TypeScript/Bun (`pi-agent-ext-movie-director`, `pi-agent-ext-flux2`), `bun test`.

---

## Reference: verified MLX-Swift API vocabulary

Every API used below has a confirmed existing call site in this repo (grepped before writing this plan — do not invent unverified APIs, this bit the team on a prior port):

- `MLX.padded(x, widths: [[Int,Int], [Int,Int], [Int,Int], [Int,Int]])` — zero-pads each of 4 dims by `[before, after]`. (`Krea2VAE.swift:102`, `VAEPrimitives.swift:221`)
- `MLX.maximum(a, b)`, `MLX.minimum(a, b)`, `MLX.where(cond, a, b)`, `a .> b`, `a .< b` — elementwise. (`Krea2DiT.swift`, various)
- `MLX.exp(x)`, `MLX.square(x)`, `MLX.sqrt(x)`, `MLX.abs(x)`, `MLX.clip(x, min:, max:)` — elementwise. (`CLIPModel.swift`, `Flux2T2IPipeline.swift`)
- `x.sum(axis:, keepDims:)`, `x.mean(axis:, keepDims:)`, `MLX.mean(x)` (whole-array), `x.variance(axis:, keepDims:)` — reductions. (`Flux2KVStyleTransfer.swift`, others)
- `zeros(like: x)` (global free function), `MLXArray(scalar)`, `MLXArray([Float], [shape])` — construction.
- `x.dim(_ i: Int)`, `x.reshaped([...])`, `x.asType(.float32)`, `MLX.eval(x)`, `x.asArray(Float.self)`, `x.item(Float.self)` — inspection/materialization.
- `x[0..., 0..., y0..<y1, x0..<x1]` — slicing (used throughout `FaceDetailPipeline.swift`/`CutoutCommand.swift`).
- `MLXRandom.seed(UInt64)` (sets **global** RNG state) + `MLXRandom.normal([shape])` (no `key:` parameter in this repo's usage) — random. (`T2IPipeline.swift:236-238`, `Krea2Engine.swift:79-80`)

`Flux2Composite.swift`'s existing `static func boxBlur(_ mask: MLXArray, radius: Int) -> MLXArray` and `blurAxis(...)` operate on plain `(H,W)` 2D arrays via `asArray(Float.self)` + a cumulative-sum sliding window + `MLXArray(out, shape)` reconstruction — NOT vectorized MLX ops. Both are `static func` (internal, not `public`), so any file inside the `Flux2Director` module (same module `PostProcessFilters.swift` lives in) can call them directly without modification.

---

## Task 1: `filmGrain` + vignette

**Files:**
- Create: `swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift`
- Test: `swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
import MLX
@testable import Flux2Director

final class PostProcessFiltersTests: XCTestCase {
    private func flatGray(_ h: Int = 64, _ w: Int = 64, value: Float = 0.5) -> MLXArray {
        let img = MLXArray(Array(repeating: value, count: 3 * h * w), [1, 3, h, w])
        MLX.eval(img)
        return img
    }

    func testFilmGrainIncreasesVariance() {
        let image = flatGray()
        let result = PostProcessFilters.filmGrain(image, intensity: 0.05, seed: 42)
        MLX.eval(result)
        let inputVar = image.variance().item(Float.self)
        let outputVar = result.variance().item(Float.self)
        XCTAssertGreaterThan(outputVar, inputVar, "adding Gaussian noise should raise pixel variance")
        // Mean should stay close to the original flat value (noise is zero-mean).
        let outputMean = MLX.mean(result).item(Float.self)
        XCTAssertEqual(outputMean, 0.5, accuracy: 0.02)
    }

    func testFilmGrainTemperatureShiftsChannelsApart() {
        let image = flatGray()
        let result = PostProcessFilters.filmGrain(image, intensity: 0.0, temperature: 0.1, seed: 42)
        MLX.eval(result)
        let rMean = MLX.mean(result[0..., 0..<1, 0..., 0...]).item(Float.self)
        let bMean = MLX.mean(result[0..., 2..<3, 0..., 0...]).item(Float.self)
        XCTAssertGreaterThan(rMean, bMean, "positive temperature should warm (raise R, lower B)")
    }

    func testFilmGrainVignetteDarkensCorners() {
        let image = flatGray(128, 128, value: 0.8)
        let result = PostProcessFilters.filmGrain(image, intensity: 0.0, vignette: 0.6, seed: 42)
        MLX.eval(result)
        let center = MLX.mean(result[0..., 0..., 60..<68, 60..<68]).item(Float.self)
        let corner = MLX.mean(result[0..., 0..., 0..<8, 0..<8]).item(Float.self)
        XCTAssertLessThan(corner, center, "vignette should darken corners more than the center")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd swift/flux2-image-director && swift test --filter PostProcessFiltersTests )`
Expected: FAIL — `PostProcessFilters` does not exist.

- [ ] **Step 3: Implement `PostProcessFilters.filmGrain` + `vignetteFalloff` helper**

```swift
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/flux2-image-director && swift test --filter PostProcessFiltersTests )`
Expected: PASS (3/3)

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift \
        swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift
git commit -m "feat(flux2): PostProcessFilters.filmGrain (noise + temperature + vignette)"
```

---

## Task 2: `gaussianBlurRGB` + `unsharpMask` helpers

**Files:**
- Modify: `swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift`
- Modify: `swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift`

`gaussianBlurRGB` reuses `Flux2Composite.boxBlur` (3 passes of box blur ≈ gaussian, same technique `Flux2Composite.featherMask` already uses) per RGB channel — no new blur math, just a 3-channel wrapper.

- [ ] **Step 1: Write the failing test**

Add to `PostProcessFiltersTests.swift`:

```swift
    func testUnsharpMaskIncreasesEdgeContrast() {
        // A soft vertical step edge: left half 0.2, right half 0.8, pre-blurred
        // slightly so there's something for unsharp to sharpen.
        var raw = [Float](repeating: 0, count: 3 * 64 * 64)
        for c in 0..<3 {
            for y in 0..<64 {
                for x in 0..<64 {
                    raw[c * 64 * 64 + y * 64 + x] = x < 32 ? 0.2 : 0.8
                }
            }
        }
        let step = MLXArray(raw, [1, 3, 64, 64])
        MLX.eval(step)
        let blurred = PostProcessFilters.gaussianBlurRGB(step, sigma: 2.0)
        let sharpened = PostProcessFilters.unsharpMask(blurred, radius: 3, amount: 1.0)
        MLX.eval(sharpened)

        // Contrast across the edge (col 30 vs col 33) should be higher after
        // unsharp than in the blurred input.
        let blurredContrast = abs(
            MLX.mean(blurred[0..., 0..., 0..., 30..<31]).item(Float.self)
            - MLX.mean(blurred[0..., 0..., 0..., 33..<34]).item(Float.self))
        let sharpContrast = abs(
            MLX.mean(sharpened[0..., 0..., 0..., 30..<31]).item(Float.self)
            - MLX.mean(sharpened[0..., 0..., 0..., 33..<34]).item(Float.self))
        XCTAssertGreaterThan(sharpContrast, blurredContrast)
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd swift/flux2-image-director && swift test --filter testUnsharpMaskIncreasesEdgeContrast )`
Expected: FAIL — `gaussianBlurRGB`/`unsharpMask` do not exist.

- [ ] **Step 3: Implement the helpers**

Add to `PostProcessFilters.swift` (inside `public enum PostProcessFilters`, or as file-private `static func`s below it — put them below the enum, matching `Flux2Composite.swift`'s split between the public enum and its private static helpers):

```swift
extension PostProcessFilters {
    /// 3-channel wrapper over Flux2Composite.boxBlur (3 box-blur passes ≈
    /// gaussian, the SAME technique Flux2Composite.featherMask already uses
    /// for mask feathering) — no new blur primitive, just per-channel reuse.
    /// `sigma` is mapped to a box-blur radius via radius ≈ sigma * 1.88
    /// (matches the standard 3-pass-box-blur-approximates-gaussian relation).
    static func gaussianBlurRGB(_ image: MLXArray, sigma: Float) -> MLXArray {
        let radius = max(1, Int((sigma * 1.88).rounded()))
        let h = image.dim(2), w = image.dim(3)
        var channels: [MLXArray] = []
        for c in 0..<3 {
            let plane = image[0..., c..<(c + 1), 0..., 0...].reshaped([h, w])
            channels.append(Flux2Composite.boxBlur(plane, radius: radius))
        }
        return MLX.stacked(channels, axis: 0).reshaped([1, 3, h, w])
    }

    /// Unsharp mask: original + amount * (original - blurred). Direct port
    /// of Sharpening._unsharp (postprocess.py), radius given in PIXELS
    /// (matches Python's PIL GaussianBlur radius, not sigma) — converted to
    /// sigma via sigma ≈ radius / 2 (PIL's own documented approximation).
    static func unsharpMask(_ image: MLXArray, radius: Int, amount: Float) -> MLXArray {
        let blurred = gaussianBlurRGB(image, sigma: Float(radius) / 2.0)
        return image + amount * (image - blurred)
    }
}
```

`Flux2Composite.boxBlur`/`static func` visibility is already internal (not `private`), so this compiles without touching `Flux2Composite.swift`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/flux2-image-director && swift test --filter PostProcessFiltersTests )`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift \
        swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift
git commit -m "feat(flux2): PostProcessFilters gaussianBlurRGB + unsharpMask helpers"
```

---

## Task 3: `sharpening` (CAS + unsharp)

**Files:**
- Modify: `swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift`
- Modify: `swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
    func testSharpeningCASIncreasesLocalContrastAcrossEdge() {
        // Softly blurred step edge (0.3 -> 0.7), like the unsharp test above.
        var raw = [Float](repeating: 0, count: 3 * 32 * 32)
        for c in 0..<3 {
            for y in 0..<32 {
                for x in 0..<32 {
                    let base: Float = x < 16 ? 0.3 : 0.7
                    raw[c * 32 * 32 + y * 32 + x] = base
                }
            }
        }
        let step = MLXArray(raw, [1, 3, 32, 32])
        let blurred = PostProcessFilters.gaussianBlurRGB(step, sigma: 1.5)
        MLX.eval(blurred)

        let sharpened = PostProcessFilters.sharpening(blurred, casStrength: 0.8)
        MLX.eval(sharpened)

        XCTAssertEqual(sharpened.dim(2), blurred.dim(2))
        XCTAssertEqual(sharpened.dim(3), blurred.dim(3))
        let vals = sharpened.asArray(Float.self)
        XCTAssertTrue(vals.allSatisfy { $0 >= 0.0 && $0 <= 1.0 }, "CAS output must stay in [0,1]")

        let blurredContrast = abs(
            MLX.mean(blurred[0..., 0..., 0..., 13..<14]).item(Float.self)
            - MLX.mean(blurred[0..., 0..., 0..., 18..<19]).item(Float.self))
        let sharpContrast = abs(
            MLX.mean(sharpened[0..., 0..., 0..., 13..<14]).item(Float.self)
            - MLX.mean(sharpened[0..., 0..., 0..., 18..<19]).item(Float.self))
        XCTAssertGreaterThan(sharpContrast, blurredContrast)
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd swift/flux2-image-director && swift test --filter testSharpeningCASIncreasesLocalContrastAcrossEdge )`
Expected: FAIL — `sharpening`/`cas` do not exist.

- [ ] **Step 3: Implement `cas` + `sharpening`**

```swift
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/flux2-image-director && swift test --filter PostProcessFiltersTests )`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift \
        swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift
git commit -m "feat(flux2): PostProcessFilters.sharpening (CAS + unsharp)"
```

---

## Task 4: `noiseCleaner` (bilateral filter + JPEG scrub)

**Files:**
- Modify: `swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift`
- Modify: `swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
    func testNoiseCleanerReducesFlatRegionVarianceButPreservesEdge() {
        // Left half 0.2 + noise, right half 0.8 + noise, hard edge at x=32.
        MLXRandom.seed(7)
        let h = 48, w = 64
        var raw = [Float](repeating: 0, count: 3 * h * w)
        for c in 0..<3 {
            for y in 0..<h {
                for x in 0..<w {
                    raw[c * h * w + y * w + x] = x < 32 ? 0.2 : 0.8
                }
            }
        }
        let clean = MLXArray(raw, [1, 3, h, w])
        let noise = MLXRandom.normal([1, 3, h, w]) * 0.08
        let noisy = MLX.clip(clean + noise, min: 0.0, max: 1.0)
        MLX.eval(noisy)

        let denoised = PostProcessFilters.noiseCleaner(noisy, bilateralRadius: 3, jpegScrub: false)
        MLX.eval(denoised)

        // Flat-region variance (within the left half, away from the edge)
        // should drop after denoising.
        let noisyVar = noisy[0..., 0..., 0..., 0..<20].variance().item(Float.self)
        let denoisedVar = denoised[0..., 0..., 0..., 0..<20].variance().item(Float.self)
        XCTAssertLessThan(denoisedVar, noisyVar, "bilateral filter should reduce flat-region noise variance")

        // The edge should still be there: left-half mean clearly below
        // right-half mean, not smeared into a uniform gray.
        let leftMean = MLX.mean(denoised[0..., 0..., 0..., 0..<20]).item(Float.self)
        let rightMean = MLX.mean(denoised[0..., 0..., 0..., 44..<64]).item(Float.self)
        XCTAssertLessThan(leftMean, 0.4)
        XCTAssertGreaterThan(rightMean, 0.6)
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd swift/flux2-image-director && swift test --filter testNoiseCleanerReducesFlatRegionVarianceButPreservesEdge )`
Expected: FAIL — `noiseCleaner`/`bilateralFilter` do not exist.

- [ ] **Step 3: Implement `bilateralFilter` + `noiseCleaner`**

```swift
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
    static func bilateralFilter(_ image: MLXArray, radius: Int, sigmaSpace: Float, sigmaColor: Float) -> MLXArray {
        let h = image.dim(2), w = image.dim(3)
        let padded = MLX.padded(image, widths: [[0, 0], [0, 0], [radius, radius], [radius, radius]])
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
```

`MLX.square(...)` is the verified free-function form (confirmed via `Flux2KVStyleTransfer.swift`'s `MLX.square(stacked)`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/flux2-image-director && swift test --filter PostProcessFiltersTests )`
Expected: PASS (6/6)

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift \
        swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift
git commit -m "feat(flux2): PostProcessFilters.noiseCleaner (bilateral + jpeg-scrub)"
```

---

## Task 5: `skinMask` (HSV skin-tone detection)

**Files:**
- Modify: `swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift`
- Modify: `swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift`

Python's `cv2` HSV convention is 8-bit: `H` in `[0,179]` (degrees/2), `S`/`V` in `[0,255]`. This port uses standard HSV: `H` in `[0,360)`, `S`/`V` in `[0,1]`. Python's two skin ranges (`lower_skin=[0,30,60]`/`upper_skin=[25,180,255]`, `lower_skin2=[170,30,60]`/`upper_skin2=[180,180,255]`) convert by doubling H and dividing S/V by 255.

- [ ] **Step 1: Write the failing test**

```swift
    func testSkinMaskDetectsSkinToneAndExcludesSaturatedBlue() {
        let h = 32, w = 64
        var raw = [Float](repeating: 0, count: 3 * h * w)
        // Left half: a mid skin tone (R=0.85,G=0.62,B=0.48 ~ typical skin RGB).
        // Right half: saturated blue (R=0.0,G=0.0,B=0.9) ~ clearly non-skin.
        for y in 0..<h {
            for x in 0..<w {
                let (r, g, b): (Float, Float, Float) = x < 32 ? (0.85, 0.62, 0.48) : (0.0, 0.0, 0.9)
                raw[0 * h * w + y * w + x] = r
                raw[1 * h * w + y * w + x] = g
                raw[2 * h * w + y * w + x] = b
            }
        }
        let image = MLXArray(raw, [1, 3, h, w])
        MLX.eval(image)

        let mask = PostProcessFilters.skinMask(image)
        MLX.eval(mask)
        let skinRegion = MLX.mean(mask[0..., 0..., 0..., 0..<32]).item(Float.self)
        let blueRegion = MLX.mean(mask[0..., 0..., 0..., 32..<64]).item(Float.self)
        XCTAssertGreaterThan(skinRegion, 0.5, "skin-tone patch should be classified as skin")
        XCTAssertLessThan(blueRegion, 0.5, "saturated blue patch should NOT be classified as skin")
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd swift/flux2-image-director && swift test --filter testSkinMaskDetectsSkinToneAndExcludesSaturatedBlue )`
Expected: FAIL — `skinMask` does not exist.

- [ ] **Step 3: Implement `skinMask`**

```swift
extension PostProcessFilters {
    /// RGB[0,1] -> HSV, H in [0,360), S/V in [0,1]. Standard closed-form
    /// conversion (matches cv2.cvtColor(RGB2HSV) up to its 8-bit H/2
    /// scaling, undone by the caller). Implemented as a raw per-pixel Swift
    /// loop over an extracted array — the SAME pattern
    /// `Flux2Composite.blurAxis` uses for its own filter math, and matches
    /// this repo's actual existing HSV-hue precedent
    /// (`LTXVideoDirector/VideoSceneDetector.swift`'s `hueHistogram`, which
    /// computes `h = 60 * (((g - b) / delta).truncatingRemainder(dividingBy: 6))`
    /// etc. the same way, also in a raw pixel loop) rather than a vectorized
    /// MLXArray formula.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/flux2-image-director && swift test --filter PostProcessFiltersTests )`
Expected: PASS (7/7)

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift \
        swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift
git commit -m "feat(flux2): PostProcessFilters.skinMask (HSV skin-tone detection)"
```

---

## Task 6: `rgbToLAB`/`labToRGB`

**Files:**
- Modify: `swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift`
- Modify: `swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift`

Standard closed-form sRGB↔CIE-LAB (D65), used as an internal round-trip only (image → LAB → CLAHE(L) → RGB) — the exact numeric convention doesn't need to match cv2's 8-bit-scaled LAB as long as `labToRGB(rgbToLAB(x)) ≈ x`, verified directly below.

- [ ] **Step 1: Write the failing test**

```swift
    func testLABRoundTripIsNearIdentity() {
        var raw = [Float](repeating: 0, count: 3 * 16 * 16)
        for y in 0..<16 {
            for x in 0..<16 {
                raw[0 * 16 * 16 + y * 16 + x] = Float(x) / 15.0
                raw[1 * 16 * 16 + y * 16 + x] = Float(y) / 15.0
                raw[2 * 16 * 16 + y * 16 + x] = 0.5
            }
        }
        let image = MLXArray(raw, [1, 3, 16, 16])
        MLX.eval(image)

        let lab = PostProcessFilters.rgbToLAB(image)
        let roundTrip = PostProcessFilters.labToRGB(lab)
        MLX.eval(roundTrip)

        let diff = MLX.mean(MLX.abs(roundTrip - image)).item(Float.self)
        XCTAssertLessThan(diff, 0.01, "RGB->LAB->RGB should be near-identity")
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd swift/flux2-image-director && swift test --filter testLABRoundTripIsNearIdentity )`
Expected: FAIL — `rgbToLAB`/`labToRGB` do not exist.

- [ ] **Step 3: Implement `rgbToLAB`/`labToRGB`**

```swift
extension PostProcessFilters {
    /// sRGB[0,1] (1,3,H,W) -> CIE LAB, L in [0,100], a/b roughly [-128,127].
    /// Standard D65 closed-form: sRGB->linear gamma decode, linear->XYZ
    /// matrix, XYZ->LAB f() nonlinearity. Internal round-trip convention
    /// only (see task header) — not scaled to cv2's 8-bit LAB range.
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
```

`MLX.pow(base, exponent)` is a verified free function (confirmed via `RoPE`/LayerNorm-variance call sites using `MLX.pow(MLXArray(...), scaleArr)` and `MLX.pow(x - mean, 2)`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/flux2-image-director && swift test --filter PostProcessFiltersTests )`
Expected: PASS (8/8)

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift \
        swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift
git commit -m "feat(flux2): PostProcessFilters rgbToLAB/labToRGB (D65 closed-form)"
```

---

## Task 7: `clahe` + `skinContrast`

**Files:**
- Modify: `swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift`
- Modify: `swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift`

CLAHE (tiled histogram + clip-redistribute + bilinear tile interpolation) is implemented in plain Swift over an extracted `[Float]` array — the same "materialize, loop, rebuild" pattern `Flux2Composite.blurAxis` already uses for its own per-pixel filter math (see the Reference section) — rather than trying to vectorize tile-histogram bookkeeping in MLXArray ops. This is a single-pass clip-and-redistribute (spread clipped-bin excess uniformly across all 256 bins once), a documented simplification of OpenCV's iterative redistribution — acceptable given this port's established fidelity bar (algorithmic match, not bit-exact).

- [ ] **Step 1: Write the failing test**

```swift
    func testCLAHEIncreasesLowContrastRegionSpread() {
        // A 64x64 L-channel-like single-plane image: values clustered
        // tightly around 0.5 (low contrast) in the left half, full [0,1]
        // range in the right half.
        let h = 64, w = 64
        var raw = [Float](repeating: 0, count: h * w)
        for y in 0..<h {
            for x in 0..<w {
                if x < 32 {
                    raw[y * w + x] = 0.48 + 0.04 * (Float(y) / Float(h))   // tight cluster [0.48,0.52]
                } else {
                    raw[y * w + x] = Float(y) / Float(h)                   // full spread [0,1)
                }
            }
        }
        let l = MLXArray(raw, [1, 1, h, w])
        MLX.eval(l)

        let eq = PostProcessFilters.clahe(l, clipLimit: 2.0, tileGridSize: 8)
        MLX.eval(eq)

        let leftVarBefore = l[0..., 0..., 0..., 0..<32].variance().item(Float.self)
        let leftVarAfter = eq[0..., 0..., 0..., 0..<32].variance().item(Float.self)
        XCTAssertGreaterThan(leftVarAfter, leftVarBefore, "CLAHE should spread a tightly-clustered region's contrast")

        let vals = eq.asArray(Float.self)
        XCTAssertTrue(vals.allSatisfy { $0 >= 0.0 && $0 <= 1.0 })
    }

    func testSkinContrastLeavesNonSkinRegionNearUnchanged() {
        let h = 32, w = 64
        var raw = [Float](repeating: 0, count: 3 * h * w)
        for y in 0..<h {
            for x in 0..<w {
                let (r, g, b): (Float, Float, Float) = x < 32
                    ? (0.85, 0.62, 0.48)   // skin tone, tightly clustered per-row for CLAHE to act on
                    : (0.0, 0.0, 0.9)      // saturated blue, clearly non-skin
                raw[0 * h * w + y * w + x] = r
                raw[1 * h * w + y * w + x] = g
                raw[2 * h * w + y * w + x] = b
            }
        }
        let image = MLXArray(raw, [1, 3, h, w])
        MLX.eval(image)

        let result = PostProcessFilters.skinContrast(image)
        MLX.eval(result)

        let blueDiff = MLX.mean(MLX.abs(
            result[0..., 0..., 0..., 32..<64] - image[0..., 0..., 0..., 32..<64]
        )).item(Float.self)
        XCTAssertLessThan(blueDiff, 0.02, "non-skin region should stay near-unchanged")
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd swift/flux2-image-director && swift test --filter "testCLAHEIncreasesLowContrastRegionSpread|testSkinContrastLeavesNonSkinRegionNearUnchanged" )`
Expected: FAIL — `clahe`/`skinContrast` do not exist.

- [ ] **Step 3: Implement `clahe` + `skinContrast`**

```swift
extension PostProcessFilters {
    /// Contrast Limited Adaptive Histogram Equalization on a single-channel
    /// (1,1,H,W) plane in [0,1]. Direct algorithmic port of
    /// SkinContrast.apply's cv2.createCLAHE step: tile the image into
    /// tileGridSize x tileGridSize regions, build a clipped 256-bin
    /// histogram per tile, turn each into a per-tile mapping (CDF), and
    /// bilinearly interpolate between the 4 nearest tile mappings per
    /// pixel. Single-pass clip-redistribute (spreads clipped excess evenly
    /// across all 256 bins once) — a documented simplification of OpenCV's
    /// iterative redistribution.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/flux2-image-director && swift test --filter PostProcessFiltersTests )`
Expected: PASS (10/10)

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift \
        swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift
git commit -m "feat(flux2): PostProcessFilters.clahe + skinContrast"
```

---

## Task 8: `PostProcessConfig` + `PostProcessChain`

**Files:**
- Modify: `swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift`
- Modify: `swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift`

- [ ] **Step 1: Write the failing test**

```swift
    func testPostProcessChainAppliesOnlyRequestedFiltersInPythonOrder() {
        let h = 32, w = 32
        let image = MLXArray(Array(repeating: Float(0.5), count: 3 * h * w), [1, 3, h, w])
        MLX.eval(image)

        var config = PostProcessConfig()
        // Nothing enabled -> output must equal input exactly.
        let untouched = PostProcessChain.apply(image, config: config)
        MLX.eval(untouched)
        XCTAssertEqual(untouched.asArray(Float.self), image.asArray(Float.self))

        // Only film grain enabled -> output must differ from input.
        config.filmGrain = 0.05
        config.seed = 3
        let grained = PostProcessChain.apply(image, config: config)
        MLX.eval(grained)
        XCTAssertNotEqual(grained.asArray(Float.self), image.asArray(Float.self))
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd swift/flux2-image-director && swift test --filter testPostProcessChainAppliesOnlyRequestedFiltersInPythonOrder )`
Expected: FAIL — `PostProcessConfig`/`PostProcessChain` do not exist.

- [ ] **Step 3: Implement `PostProcessConfig` + `PostProcessChain`**

```swift
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/flux2-image-director && swift test --filter PostProcessFiltersTests )`
Expected: PASS (11/11)

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2Director/PostProcessFilters.swift \
        swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessFiltersTests.swift
git commit -m "feat(flux2): PostProcessConfig + PostProcessChain"
```

---

## Task 9: `flux2 postprocess` CLI command

**Files:**
- Create: `swift/flux2-image-director/Sources/Flux2DirectorCLI/PostProcessCommand.swift`
- Modify: `swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift`
- Test: `swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessCommandTests.swift`

No model loading — mirrors `CutoutCommand.swift`'s shape (see that file, already read during design), not `FaceDetailCommand`'s heavier transformer/VAE/encoder-loading shape.

- [ ] **Step 1: Write the failing test**

The CLI command itself is a thin `run()` wrapper around `PostProcessChain.apply` + `ImageSave.savePNG`; test the underlying behavior directly against the library (consistent with how `FaceDetailPipelineTests` tests `FaceDetailPipeline` rather than shelling out to the built binary — no precedent in this repo for testing a CLI command via subprocess).

```swift
import XCTest
import MLX
@testable import Flux2Director
import CommonImageDirector

final class PostProcessCommandTests: XCTestCase {
    func testPostProcessSaveRoundTripPreservesDimensions() throws {
        let h = 48, w = 64
        let image = MLXArray(Array(repeating: Float(0.6), count: 3 * h * w), [1, 3, h, w])
        MLX.eval(image)

        var config = PostProcessConfig()
        config.filmGrain = 0.02
        config.sharpening = 0.1
        let result = PostProcessChain.apply(image, config: config)
        MLX.eval(result)

        let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("postprocess-test-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: tmp) }
        try ImageSave.savePNG(result, to: tmp)

        XCTAssertTrue(FileManager.default.fileExists(atPath: tmp.path))
        let (savedW, savedH) = try Flux2ImageLoad.imageSize(at: tmp)
        XCTAssertEqual(savedW, w)
        XCTAssertEqual(savedH, h)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd swift/flux2-image-director && swift test --filter testPostProcessSaveRoundTripPreservesDimensions )`
Expected: FAIL only if `PostProcessConfig`/`PostProcessChain` are inaccessible — they were completed in Task 8, so this should actually PASS already (this step is a regression check confirming Task 8's library code + `ImageSave.savePNG`/`Flux2ImageLoad.imageSize` compose correctly). If it fails for any other reason, fix before proceeding.

- [ ] **Step 3: Implement `PostProcessCommand.swift` and register it**

```swift
//
//  PostProcessCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 postprocess` — film grain / CAS+unsharp sharpening / bilateral
//  noise-clean / CLAHE skin-contrast pixel filters (port of
//  app/postprocess.py's PostProcessChain). No model loading — mirrors
//  CutoutCommand.swift's shape. LUT grading is NOT exposed (deferred, see
//  .planning/specs/2026-08-03-postprocess-swift-native-port-design.md —
//  zero .cube assets exist anywhere in this repo, no caller has ever
//  exercised that path).
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct PostProcess: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "postprocess",
            abstract: "Pixel-filter post-processing (film grain / CAS+unsharp sharpening / bilateral noise-clean / CLAHE skin-contrast)."
        )

        @Option(help: "Source image path.") var input: String
        @Option(name: .customLong("film-grain"), help: "Film grain intensity (0 = off).") var filmGrain: Float = 0
        @Option(help: "CAS sharpening strength (0 = off).") var sharpening: Float = 0
        @Flag(name: .customLong("skin-contrast"), help: "Apply CLAHE contrast enhancement to detected skin-tone regions.") var skinContrast: Bool = false
        @Flag(name: .customLong("noise-clean"), help: "Apply bilateral denoise + JPEG-artifact scrub.") var noiseClean: Bool = false
        @Option var seed: UInt64 = 42
        @Option var output: String

        func run() throws {
            setbuf(stdout, nil)
            print("flux2 postprocess")
            print("  input: \(input)  film-grain: \(filmGrain)  sharpening: \(sharpening)  skin-contrast: \(skinContrast)  noise-clean: \(noiseClean)")

            let (width, height) = try Flux2ImageLoad.imageSize(at: URL(fileURLWithPath: input))
            let rgb = try Flux2ImageLoad.loadArray(from: URL(fileURLWithPath: input), targetSize: (width, height))

            var config = PostProcessConfig()
            config.filmGrain = filmGrain
            config.sharpening = sharpening
            config.skinContrast = skinContrast
            config.noiseClean = noiseClean
            config.seed = seed

            let result = PostProcessChain.apply(rgb, config: config)
            MLX.eval(result)

            let outputURL = URL(fileURLWithPath: output)
            try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try ImageSave.savePNG(result, to: outputURL)
            print("")
            print("✅ postprocess saved: \(outputURL.path)")
        }
    }
}
```

In `Sources/Flux2DirectorCLI/Flux2CLI.swift`, add `PostProcess.self` to the `subcommands:` array, next to `FaceDetail.self`/`Upscale.self`:

```swift
        subcommands: [
            T2I.self, Edit.self, Angle.self, Segment.self, Cutout.self, Swap.self, Style.self,
            Story.self, Kontext.self, Scene.self, Expand.self, Inpaint.self, StyleTransfer.self, FaceSwap.self, FaceDetail.self, PostProcess.self, Upscale.self, Gate.self, Models.self, VerifyVAE.self, VerifyEncoder.self,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/flux2-image-director && swift build && swift test --filter "PostProcessFiltersTests|PostProcessCommandTests" )`
Expected: PASS, and `swift build` succeeds with the new `postprocess` subcommand registered.

- [ ] **Step 5: Manual smoke test**

```bash
( cd swift/flux2-image-director && swift build )
swift/flux2-image-director/.build/debug/flux2 postprocess \
  --input scripts/fixtures/faces/real_face_portrait.png \
  --film-grain 0.02 --sharpening 0.15 --skin-contrast --noise-clean \
  --output /tmp/postprocess-smoke-test.png
```
Expected: `✅ postprocess saved: /tmp/postprocess-smoke-test.png`, and the file exists with the same dimensions as the input (832×1024).

- [ ] **Step 6: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2DirectorCLI/PostProcessCommand.swift \
        swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift \
        swift/flux2-image-director/Tests/Flux2DirectorTests/PostProcessCommandTests.swift
git commit -m "feat(flux2): flux2 postprocess CLI command"
```

---

## Task 10: `workflow_native.ts` chaining

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/workflow_native.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/workflow_native.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `workflow_native.test.ts` (following the existing face-detail test shape in the same file — read it first to match the existing mocking/assertion style exactly, since this plan can't see its current exact content):

```typescript
test("runWorkflowNative chains postProcess after face-detail, before upscale", async () => {
  const calls: string[] = [];
  const result = await runWorkflowNative({
    prompt: "a woman standing",
    faceDetail: true,
    postProcess: { filmGrain: 0.02, sharpening: 0.1 },
    upscale: true,
    _runBase: async () => { calls.push("base"); return { path: "/tmp/base.png", seed: 1, width: 512, height: 768 }; },
    _runFaceDetail: async (input) => { calls.push(`face_detail(${input})`); return { path: "/tmp/fd.png", width: 512, height: 768 }; },
    _runPostProcess: async (input) => { calls.push(`postprocess(${input})`); return { path: "/tmp/pp.png", width: 512, height: 768 }; },
    _runUpscale: async (input) => { calls.push(`upscale(${input})`); return { path: "/tmp/up.png", width: 1024, height: 1536 }; },
  });
  expect(calls).toEqual([
    "base",
    "face_detail(/tmp/base.png)",
    "postprocess(/tmp/fd.png)",
    "upscale(/tmp/pp.png)",
  ]);
  expect(result.stages).toEqual(["base", "face_detail", "postprocess", "upscale"]);
  expect(result.postProcessImage).toBe("/tmp/pp.png");
  expect(result.finalImage).toBe("/tmp/up.png");
});

test("runWorkflowNative does not call postProcess when unset", async () => {
  let postProcessCalled = false;
  const result = await runWorkflowNative({
    prompt: "a woman standing",
    _runBase: async () => ({ path: "/tmp/base.png", seed: 1, width: 512, height: 768 }),
    _runPostProcess: async (input) => { postProcessCalled = true; return { path: "/tmp/pp.png", width: 512, height: 768 }; },
  });
  expect(postProcessCalled).toBe(false);
  expect(result.stages).toEqual(["base"]);
  expect(result.postProcessImage).toBeNull();
});

test("runWorkflowNative propagates postProcess failure", async () => {
  await expect(runWorkflowNative({
    prompt: "a woman standing",
    postProcess: { filmGrain: 0.02 },
    _runBase: async () => ({ path: "/tmp/base.png", seed: 1, width: 512, height: 768 }),
    _runPostProcess: async () => { throw new Error("postprocess: boom"); },
  })).rejects.toThrow("postprocess: boom");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test workflow_native.test.ts )`
Expected: FAIL — `postProcess`/`_runPostProcess` are not recognized options, `result.postProcessImage` is `undefined`.

- [ ] **Step 3: Implement the chaining**

In `workflow_native.ts`, add new types (near the existing `FaceDetailResult`/`FaceDetailFn`):

```typescript
export interface PostProcessOptions {
  filmGrain?: number;
  sharpening?: number;
  skinContrast?: boolean;
  noiseClean?: boolean;
}

export interface PostProcessResult {
  path: string;
  width: number | null;
  height: number | null;
}
export type PostProcessFn = (input: string, opts: WorkflowNativeOptions) => Promise<PostProcessResult>;

/** Default post-process call: flux2 native `postprocess` (film grain / CAS+unsharp sharpening / bilateral noise-clean / CLAHE skin-contrast). */
export const defaultRunPostProcess: PostProcessFn = async (input, opts) => {
  const pp = opts.postProcess ?? {};
  const out = await runFlux2({
    command: "postprocess",
    options: {
      input,
      filmGrain: pp.filmGrain,
      sharpening: pp.sharpening,
      skinContrast: pp.skinContrast,
      noiseClean: pp.noiseClean,
      seed: opts.seed,
    },
    outputDir: opts.outputDir,
  });
  const d: Flux2Details = out.details;
  if (!d.ok || !d.output) {
    throw new Error(`workflow: postprocess failed: ${out.summary}\n${out.stderrTail}`.trim());
  }
  return { path: d.output, width: d.width, height: d.height };
};
```

Add `postProcess?: PostProcessOptions;` and `_runPostProcess?: PostProcessFn;` to `WorkflowNativeOptions`. Add `postProcessImage: string | null;` to `WorkflowNativeResult`. Widen `stages`:

```typescript
  stages: ("base" | "face_detail" | "postprocess" | "upscale")[];
```

In `runWorkflowNative`, insert a new block between the existing `faceDetail` block and the `upscale` block:

```typescript
  let postProcessImage: string | null = null;
  if (opts.postProcess) {
    const runPostProcess = opts._runPostProcess ?? defaultRunPostProcess;
    const pp = await runPostProcess(finalImage, opts);
    finalImage = pp.path;
    postProcessImage = pp.path;
    stages.push("postprocess");
    width = pp.width ?? width;
    height = pp.height ?? height;
  }
```

(declare `let postProcessImage` alongside the existing `let faceDetailImage`/`let upscaledImage` declarations near the top of the function, not inline where shown above — match the existing declaration block's placement). Add `postProcessImage,` to the function's final returned object, next to `faceDetailImage`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test workflow_native.test.ts )`
Expected: PASS, including all pre-existing tests in the file (no regressions).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/workflow_native.ts \
        bun-apps/pi-agent-ext-movie-director/src/workflow_native.test.ts
git commit -m "feat(movie-director): chain flux2 postprocess in workflow_native.ts"
```

---

## Task 11: `bridge.ts` gate relaxation

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `bridge.test.ts` (matching the existing `isNativeWorkflowRequest`/`realWorkflow` test style already in the file):

```typescript
test("isNativeWorkflowRequest: true when film_grain/sharpening/skin_contrast/noise_clean are requested — now native", () => {
  expect(isNativeWorkflowRequest({ film_grain: 0.02 })).toBe(true);
  expect(isNativeWorkflowRequest({ sharpening: 0.1 })).toBe(true);
  expect(isNativeWorkflowRequest({ skin_contrast: true })).toBe(true);
  expect(isNativeWorkflowRequest({ noise_clean: true })).toBe(true);
});

test("isNativeWorkflowRequest: false when a LUT knob is requested — still falls back", () => {
  expect(isNativeWorkflowRequest({ lut: "models/lut/NaturalBoost.cube" })).toBe(false);
  expect(isNativeWorkflowRequest({ lutPath: "x.cube" })).toBe(false);
  expect(isNativeWorkflowRequest({}, ["--lut", "x.cube"])).toBe(false);
});

test("isNativeWorkflowRequest: false when seedvr2 upscale is requested (unchanged)", () => {
  expect(isNativeWorkflowRequest({ upscaleMethod: "seedvr2" })).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test bridge.test.ts )`
Expected: the `film_grain`/`sharpening`/`skin_contrast`/`noise_clean` cases FAIL (currently `false`, asserting `true`); the LUT cases currently pass by accident (any post-process knob falls back today) — after Task 11's Step 3 they must still pass, now because of an explicit LUT check rather than the blanket one.

- [ ] **Step 3: Relax the gate**

In `bridge.ts`, update `isNativeWorkflowRequest`:

```typescript
export function isNativeWorkflowRequest(options: Record<string, unknown>, extraArgs?: string[]): boolean {
  const truthy = (v: unknown): boolean => {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v > 0;
    if (typeof v === "string") return v.length > 0;
    return v != null;
  };
  const NONPORTABLE_OPTION_KEYS = [
    "lut", "lutPath", "lut_path",
  ];
  for (const k of NONPORTABLE_OPTION_KEYS) {
    if (truthy(options[k])) return false;
  }
  const upscaleMethod = options.upscaleMethod ?? options.upscale_method;
  if (upscaleMethod === "seedvr2") return false;

  const NONPORTABLE_FLAGS = new Set([
    "--lut", "--lut-strength",
  ]);
  for (const a of extraArgs ?? []) {
    if (NONPORTABLE_FLAGS.has(a)) return false;
  }
  if ((extraArgs ?? []).includes("seedvr2")) return false;

  return true;
}
```

Update the doc comment directly above it: replace the "Native path is only safe when NONE of the non-portable stages are requested..." paragraph with one noting that `film_grain`/`sharpening`/`skin_contrast`/`noise_clean` are now native (2026-08-03,
`PostProcessFilters.swift` — pure MLXArray reimplementation, see
`.planning/specs/2026-08-03-postprocess-swift-native-port-design.md`), and only LUT grading (no `.cube` asset/caller exists) and `seedvr2` upscale remain non-portable.

In `realWorkflow`, add the post-process passthrough next to the existing `faceDetail:` line:

```typescript
    const postProcess = {
      filmGrain: (options.filmGrain as number | undefined) ?? (options.film_grain as number | undefined),
      sharpening: options.sharpening as number | undefined,
      skinContrast: Boolean(options.skinContrast ?? options.skin_contrast),
      noiseClean: Boolean(options.noiseClean ?? options.noise_clean),
    };
    const hasPostProcess = Boolean(
      postProcess.filmGrain || postProcess.sharpening || postProcess.skinContrast || postProcess.noiseClean);
```

and pass `postProcess: hasPostProcess ? postProcess : undefined,` into the `runWorkflowNative({...})` call, next to the existing `faceDetail: Boolean(options.faceDetail ?? options.face_detail),` line. Also extend the `model:` string-building logic (wherever it currently appends `+flux2:face-detail`) to append `+flux2:postprocess` when `result.stages.includes("postprocess")` — find and mirror the existing face-detail conditional exactly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test bridge.test.ts )`
Expected: PASS, including all pre-existing tests (no regressions — especially the pre-existing extraArgs tests; if any assert `--film-grain`/`--sharpening`/`--skin-contrast`/`--noise-clean` return `false`, move those assertions to a "now portable" case the same way the face-detail port's Task 6 did for `--face-detail`, per this repo's established precedent — check for this explicitly, don't assume it isn't there).

- [ ] **Step 5: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/bridge.ts \
        bun-apps/pi-agent-ext-movie-director/src/bridge.test.ts
git commit -m "feat(movie-director): relax isNativeWorkflowRequest for post-process filters"
```

---

## Task 12: `pi-agent-ext-flux2` `commands.ts` wiring

**Files:**
- Modify: `bun-apps/pi-agent-ext-flux2/src/commands.ts`
- Modify: `bun-apps/pi-agent-ext-flux2/src/commands.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `commands.test.ts` (matching the existing `face-detail` spec-shape test already in the file):

```typescript
test("postprocess command spec has the expected shape", () => {
  const spec = COMMANDS["postprocess"];
  expect(spec).toBeDefined();
  expect(spec.name).toBe("postprocess");
  expect(spec.writesImage).toBe(true);
  expect(Object.keys(spec.fields)).toEqual(
    expect.arrayContaining(["input", "filmGrain", "sharpening", "skinContrast", "noiseClean", "seed", "output"]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-flux2 && bun test commands.test.ts )`
Expected: FAIL — `COMMANDS["postprocess"]` is `undefined`.

- [ ] **Step 3: Add the `postprocess` entry**

In `commands.ts`, add (matching the `face-detail` entry's exact real shape, confirmed at `commands.ts:374-395`: `{ flag: "--x", type: "string"|"number"|"int"|"boolean", isPath?: true, description: "..." }` per field, `noArtifacts`'s `type: "boolean"` at `commands.ts:104` is the boolean-flag precedent):

```typescript
  "postprocess": {
    name: "postprocess",
    writesImage: true,
    acceptsGlobals: false,
    when: "Pixel-filter post-processing (film grain, CAS+unsharp sharpening, bilateral noise-clean, CLAHE skin-contrast) on an existing image — port of postprocess.py's PostProcessChain. No model load.",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Source image path." },
      filmGrain: { flag: "--film-grain", type: "number", description: "Film grain intensity (0 = off). Default 0." },
      sharpening: { flag: "--sharpening", type: "number", description: "CAS sharpening strength (0 = off). Default 0." },
      skinContrast: { flag: "--skin-contrast", type: "boolean", description: "Apply CLAHE contrast enhancement to detected skin-tone regions." },
      noiseClean: { flag: "--noise-clean", type: "boolean", description: "Apply bilateral denoise + JPEG-artifact scrub." },
      seed: GEN_FIELDS.seed,
      output: GEN_FIELDS.output,
      outputDir: GEN_FIELDS.outputDir,
      name: GEN_FIELDS.name,
      noArtifacts: GEN_FIELDS.noArtifacts,
    },
  },
```

`postprocess` has NO model-loading fields (`transformer`/`vae`/`encoder`/`tokenizerDir`) since it loads no model, unlike `face-detail`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-flux2 && bun test commands.test.ts )`
Expected: PASS. Also check for a hardcoded "N documented subcommands" exact-count test in this file (the face-detail port hit exactly this — Task 4 of that plan) — if present, update the count and the listed array to include `"postprocess"`.

- [ ] **Step 5: Verify against the real binary**

Run: `( cd bun-apps/pi-agent-ext-flux2 && bun run check:flags )` (or the equivalent script referenced in this package's `package.json` / root `CLAUDE.md`'s "Extension packages" section — `scripts/check-flags.ts`) to confirm `commands.ts`'s new `postprocess` entry doesn't drift from the real `flux2 postprocess --help` output built in Task 9.
Expected: no drift reported for `postprocess`.

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-flux2/src/commands.ts \
        bun-apps/pi-agent-ext-flux2/src/commands.test.ts
git commit -m "feat(flux2-ext): wire postprocess into commands.ts"
```

---

## Task 13: `registry.ts` + module-doc cleanup

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/registry.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/workflow_native.ts` (module-header doc only)

- [ ] **Step 1: Update `registry.ts`'s `workflow_hybrid` notes**

Find the `workflow_hybrid` entry's `notes` field (contains "Native path: src/workflow_native.ts orchestrating krea2 t2i/i2i (base gen) optionally chained with flux2 face-detail..."). Update it to also mention post-process:

Replace:
```
Native path: src/workflow_native.ts orchestrating krea2 t2i/i2i (base gen) optionally chained with flux2 face-detail (Apple Vision detect + SDEdit regen) and/or flux2 upscale (ESRGAN/RealPLKSR) — fires only when no post-process knob is requested and upscale_method isn't seedvr2. Fallback path: run.py's image-workflow.py (full 4-stage pipeline incl. numpy/PIL/cv2 post-process chain, SeedVR2), — fires for everything else, unchanged from before this migration.
```
With:
```
Native path: src/workflow_native.ts orchestrating krea2 t2i/i2i (base gen) optionally chained with flux2 face-detail (Apple Vision detect + SDEdit regen), flux2 postprocess (film-grain/CAS+unsharp-sharpening/bilateral-noise-clean/CLAHE-skin-contrast, 2026-08-03 — see PostProcessFilters.swift), and/or flux2 upscale (ESRGAN/RealPLKSR) — fires whenever the request needs neither LUT color-grading nor upscale_method=seedvr2. Fallback path: run.py's image-workflow.py (full 4-stage pipeline incl. LUT grading, SeedVR2) — fires for everything else, unchanged from before this migration.
```

(Match the surrounding punctuation/wrapping style of the existing multi-line comment block exactly — this is a single long `notes:` string field, not separate lines, per this file's established convention seen in every other entry.)

Also check the module-header comment block directly above the `workflow_hybrid` entry (contains "Stage 2 (face detailer) is now native too (2026-08-02):" per the earlier session's edit) — extend it with a stage-3 sentence noting post-process is now native as of this port, mirroring how the face-detail port extended this same comment block for stage 2.

- [ ] **Step 2: Update `workflow_native.ts`'s module-header doc**

The module doc's "3. POST-PROCESSING" paragraph currently ends with "NOT PORTABLE in this session's orchestration-only scope." Replace that paragraph (keep the historical investigation prose intact — the "confirmed PURE numpy/PIL/cv2 pixel math" framing is still accurate background) with an update noting: as of 2026-08-03, `film_grain`/`sharpening`/`skin_contrast`/`noise_clean` ARE portable via `PostProcessFilters.swift` (pure MLXArray reimplementation, no image-codec dependency needed after all — the earlier "no codec dependency" blocker assumed pixel buffers had to be decoded via an external library, but this port operates directly on the `MLXArray` the pipeline already carries). Only `LUTGrading` stays non-portable (no `.cube` asset/caller in this repo). Update the final "NET:" summary paragraph accordingly (mirrors the face-detail port's own module-doc update for stage 2, same file).

- [ ] **Step 3: Run the full existing test suites to confirm no regressions from the doc-only changes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Expected: all pass (doc/comment changes only, no behavior change in this task).

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/registry.ts \
        bun-apps/pi-agent-ext-movie-director/src/workflow_native.ts
git commit -m "docs(movie-director): registry.ts + workflow_native.ts notes for postprocess port"
```

---

## Final: Whole-branch review checklist (for the dispatching agent, not a subagent task)

After Task 13, before handing off to `finishing-a-development-branch`:
- Run the full Swift test suite: `( cd swift/flux2-image-director && swift test )`.
- Run the full Bun test suites: `( cd bun-apps/pi-agent-ext-movie-director && bun test )` and `( cd bun-apps/pi-agent-ext-flux2 && bun test )`.
- Run `bun run --cwd bun-apps/gui-movie-director check:schema` (per root `CLAUDE.md`'s Testing section) to confirm the GUI's `film_grain`/`sharpening`/`skin_contrast`/`noise_clean` schema fields (`bun-apps/gui-movie-director/schemas/workflow.ts`) still validate against the now-changed `run.py` capability surface.
- Dispatch a final code reviewer subagent with NO per-task context (fresh, whole-diff view) per `subagent-driven-development`'s closing step — the face-detail port's own final review caught a second stale doc reference Task 7 (that port's registry cleanup task) missed; expect this port's Task 13 to have a similar blind spot risk given it also touches two files (`registry.ts` + `workflow_native.ts`) with overlapping narrative.
