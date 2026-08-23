# Post-Process Swift-Native Port — Design Spec

## Context

`workflow_hybrid`'s native path (`workflow_native.ts`, wired via `bridge.ts`'s
`isNativeWorkflowRequest`) already covers stage 1 (base-gen), stage 2
(face-detail, 2026-08-02), and stage 4 (ESRGAN upscale) of `run.py image
workflow`'s 4-stage pipeline. Stage 3 (post-processing —
`app/postprocess.py`, 442 lines) is the last remaining non-portable stage
that isn't a genuine model-unavailability gap: the module docstring says
"Pure numpy/PIL/cv2 image processing — no ML model loading needed," and the
code matches (no MLX/torch import anywhere in the file). `--upscale-method
seedvr2` stays permanently non-portable (confirmed PyTorch/torch-MPS-only,
unrelated to this port).

Five filters exist in `PostProcessChain`: `FilmGrain`, `Sharpening` (CAS +
unsharp), `NoiseCleaner` (cv2 bilateral + JPEG scrub), `LUTGrading` (`.cube`
3D LUT trilinear interpolation), `SkinContrast` (HSV skin mask + CLAHE).
Four of them (`film_grain`, `sharpening`, `skin_contrast`, `noise_clean`)
have real GUI exposure (`bun-apps/gui-movie-director/schemas/workflow.ts`,
"Post-Processing" section) and are load-bearing knobs a caller can actually
reach today. `lut`/`lut_strength` are GUI-declared but there is no `.cube`
file anywhere in this repo and no caller has ever exercised the path — a
theoretical field, not a real gap.

`swift/flux2-image-director`'s `Flux2Composite.swift` already established
the pattern this port follows: pure Swift pixel algorithms operating
directly on `(1, 3, H, W)` float32 `[0,1]` `MLXArray` images (the same shape
every stage in the workflow chain already passes around), using
vectorized shifted-slice operations (`boxBlur`/`blurAxis`, a separable box
blur) instead of a per-pixel loop. No new image-codec or Accelerate/vImage
dependency — every filter here is expressible as elementwise/windowed
MLXArray math, consistent with every other native command in this package.

## Scope

**In scope:**
- A new `PostProcessFilters.swift` (library,
  `swift/flux2-image-director/Sources/Flux2Director/`) implementing 4 of the
  5 Python filters as pure `MLXArray → MLXArray` functions:
  `FilmGrain`, `Sharpening` (CAS + unsharp), `NoiseCleaner` (windowed
  bilateral + JPEG-scrub unsharp), `SkinContrast` (HSV mask + CLAHE).
- A `PostProcessChain` type applying a subset of the above in the same
  fixed order Python's `PostProcessChain.from_config` uses (minus the LUT
  step, deferred — see below): `noise_clean → skin_contrast → sharpening →
  film_grain`.
- A new `flux2 postprocess` CLI command
  (`Sources/Flux2DirectorCLI/PostProcessCommand.swift`) — no model loading
  (mirrors `CutoutCommand.swift`'s shape, not `FaceDetailCommand`'s).
- `workflow_native.ts` gains a new stage, chained between face-detail and
  upscale (matching Python's `stage_order = ["base", "face_detail",
  "postprocess", "upscale"]`).
- `bridge.ts`'s `isNativeWorkflowRequest` relaxed to let
  `film_grain`/`sharpening`/`skin_contrast`/`noise_clean` requests reach the
  native path. LUT-related keys/flags stay in the non-portable list.
- `pi-agent-ext-flux2`'s `commands.ts` gains a `postprocess` entry.
- `registry.ts`'s `workflow_hybrid` notes updated to reflect the narrowed
  gap (LUT + seedvr2 only).
- Real, non-mocked test coverage per filter (statistical/property
  assertions on synthetic fixtures — see Testing) plus a real end-to-end
  `PostProcessCommand` test and `workflow_native.ts` unit/orchestration
  tests.

**Out of scope (deferred, documented, not silently dropped):**
- `LUTGrading` (`.cube` 3D LUT + trilinear interpolation, `lut`/
  `lut_strength`) — zero `.cube` assets exist anywhere in this repo and no
  caller has ever exercised this path (confirmed via repo-wide search); a
  theoretical GUI field, not a real gap. `isNativeWorkflowRequest` keeps
  `lut`/`lutPath`/`lut_path` options and the `--lut` flag in its
  non-portable list, so any future caller that does supply a LUT path
  still safely falls back to `run.py`, unchanged from today. The Swift
  primitives this port builds (chain shape, filter-config plumbing) are
  structured so a future LUT filter slots in without rework.
- `--upscale-method seedvr2` — unchanged, confirmed PyTorch/torch-MPS-only
  elsewhere, unrelated to this port.

## Design

### 1. `PostProcessFilters.swift` (new, library)

All functions take/return `(1, 3, H, W)` float32 `[0,1]` `MLXArray`,
matching every other stage in the pipeline. `Flux2Composite.swift`'s
`boxBlur`/`blurAxis` (currently single-channel, used for mask feathering)
is generalized to accept a channel dimension so it can run per-RGB-channel
for the blur steps below — no new blur primitive.

```swift
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
        // Matches the established repo pattern (T2IPipeline.swift,
        // Krea2Engine.swift, etc.) — MLXRandom.seed(_:) sets the global RNG
        // state, MLXRandom.normal(_:) takes no key: parameter.
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

    /// Direct port of Sharpening.apply: AMD FidelityFX CAS (3x3 cross
    /// neighborhood min/max contrast-adaptive blend) + optional unsharp mask.
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

    /// Direct port of NoiseCleaner.apply: windowed joint-bilateral filter
    /// (spatial-gaussian x range-gaussian, replacing cv2.bilateralFilter)
    /// + JPEG-scrub unsharp pass.
    public static func noiseCleaner(
        _ image: MLXArray, bilateralRadius: Int = 4, sigma: Float = 75.0 / 255.0,
        jpegScrub: Bool = true
    ) -> MLXArray {
        var out = image
        if bilateralRadius > 0 {
            out = bilateralFilter(out, radius: bilateralRadius, sigmaSpace: Float(bilateralRadius), sigmaColor: sigma)
        }
        if jpegScrub {
            let blurred = gaussianBlurRGB(out, sigma: 0.5)
            out = MLX.clip(out + 0.3 * (out - blurred), min: 0.0, max: 1.0)
        }
        return out
    }

    /// Direct port of SkinContrast.apply: HSV skin-tone mask (two ranges,
    /// matching Python's lower/upper_skin + lower/upper_skin2) + CLAHE on
    /// the LAB L channel, blended into skin pixels only.
    public static func skinContrast(
        _ image: MLXArray, clipLimit: Float = 2.0, tileGridSize: Int = 8
    ) -> MLXArray {
        let mask = skinMask(image)                       // (1,1,H,W) in {0,1}
        let lab = rgbToLAB(image)                         // (1,3,H,W)
        let lChannel = lab[0..., 0..<1, 0..., 0...]
        let lEq = clahe(lChannel, clipLimit: clipLimit, tileGridSize: tileGridSize)
        let labEq = MLX.concatenated([lEq, lab[0..., 1..<2, 0..., 0...], lab[0..., 2..<3, 0..., 0...]], axis: 1)
        let enhanced = labToRGB(labEq)
        return image * (1.0 - mask) + enhanced * mask
    }
}

public enum PostProcessConfig {
    public var filmGrain: Float = 0        // 0 = off
    public var sharpening: Float = 0       // 0 = off, else CAS strength
    public var skinContrast: Bool = false
    public var noiseClean: Bool = false
    public var seed: UInt64? = nil
}

public enum PostProcessChain {
    /// Applies the requested subset of filters in Python's fixed order:
    /// noise_clean -> skin_contrast -> sharpening -> film_grain.
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

Internal helpers (`vignetteFalloff`, `cas`, `unsharpMask`, `bilateralFilter`,
`gaussianBlurRGB`, `skinMask`, `rgbToLAB`/`labToRGB`, `clahe`) are private to
the file, each a direct algorithmic port of its Python counterpart:

- **`cas`** — the existing `Sharpening._cas` 3x3 cross-neighborhood
  min/max/weight math, rewritten as shifted-slice MLXArray ops (same
  technique `Flux2Composite.blurAxis` already uses for its separable box
  blur — pad, slice 4 shifted views, elementwise min/max/arithmetic).
- **`bilateralFilter`** — a fixed-radius windowed joint bilateral filter:
  for each of the `(2·radius+1)²` offsets, accumulate
  `pixel_at_offset * spatial_gaussian(offset) * range_gaussian(image -
  pixel_at_offset)`, normalize by the summed weights. Same shifted-slice-
  accumulation shape as `cas`, just a larger fixed window (radius 4 →
  matches Python's `bilateral_d=9` diameter) and importantly the range-
  gaussian term makes edges pass through unattenuated the way
  `cv2.bilateralFilter` does — this is what distinguishes it from a plain
  box/gaussian blur and gives it its edge-preserving JPEG-cleanup effect.
- **`gaussianBlurRGB`** — 3-channel generalization of
  `Flux2Composite.boxBlur`/`blurAxis` (loops the existing separable-blur
  helper once per RGB channel instead of the single mask channel).
- **`skinMask`** — RGB→HSV conversion via the standard closed-form
  elementwise formula, then two range checks (`[0,30,60]..[25,180,255]` and
  `[170,30,60]..[180,180,255]`, matching Python's two skin-tone bands)
  OR'd together, mirrored 1:1 from `SkinContrast.apply`.
- **`rgbToLAB`/`labToRGB`** — standard closed-form sRGB↔CIE-LAB conversion
  formulas (no cv2 call in either language — Python routes through
  `cv2.cvtColor`, but the underlying transform is a fixed, well-documented
  matrix+gamma formula reproducible directly in MLXArray).
- **`clahe`** — tiled (default 8×8) per-tile 256-bin histogram + contrast
  clip-and-redistribute + bilinear interpolation between the 4 nearest
  tile mappings per pixel. This is the most involved primitive in the
  file; it is still pure algorithm (histogram counts via one-hot-sum over
  MLXArray, no external dependency).

### 2. `PostProcessCommand.swift` (new)

No model loading — mirrors `CutoutCommand.swift`'s shape (not
`FaceDetailCommand`'s heavier transformer/VAE/encoder-loading shape):

```
flux2 postprocess --input <path> --output <path>
  [--film-grain 0.0] [--sharpening 0.0]
  [--skin-contrast] [--noise-clean]
  [--seed 42]
```

```swift
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

            let outputURL = URL(fileURLWithPath: output)
            try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try ImageSave.savePNG(result, to: outputURL)
            print("")
            print("✅ postprocess saved: \(outputURL.path)")
        }
    }
}
```

Registered in `Flux2CLI.swift`'s `subcommands:` array, next to
`FaceDetail.self`/`Upscale.self`.

### 3. `workflow_native.ts` chaining

New optional field on `WorkflowNativeOptions` mirroring `faceDetail`'s
simple-flag shape but carrying the 4 sub-knobs:

```typescript
export interface PostProcessOptions {
  filmGrain?: number;
  sharpening?: number;
  skinContrast?: boolean;
  noiseClean?: boolean;
}
```

Added to `WorkflowNativeOptions` as `postProcess?: PostProcessOptions`. New
`PostProcessResult`/`PostProcessFn` test-seam pair (mirrors
`FaceDetailResult`/`FaceDetailFn`) and `defaultRunPostProcess` calling
`runFlux2({command: "postprocess", options: {input, filmGrain, sharpening,
skinContrast, noiseClean, seed}, outputDir})`.

`runWorkflowNative`'s body gains a new block between the existing
face-detail block and the upscale block — chains off `finalImage` (whatever
the pipeline has produced so far), matching Python's stage order:

```typescript
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

`WorkflowNativeResult` gains `postProcessImage: string | null`; `stages`
widens to `("base" | "face_detail" | "postprocess" | "upscale")[]`.

### 4. `bridge.ts` gate relaxation

`isNativeWorkflowRequest`'s `NONPORTABLE_OPTION_KEYS` loses `"filmGrain",
"film_grain"`, `"sharpening"`, `"skinContrast", "skin_contrast"`,
`"noiseClean", "noise_clean"` — those become portable. `"lut", "lutPath",
"lut_path"` are ADDED explicitly (previously implicit/absent — LUT was
never separately gated because the whole workflow fell back whenever ANY
post-process knob was set; now that most knobs are portable, LUT needs its
own explicit non-portable entry so a LUT request doesn't slip through).
Same treatment for `NONPORTABLE_FLAGS`: drop `"--film-grain"`,
`"--sharpening"`, `"--skin-contrast"`, `"--noise-clean"`; add `"--lut"`,
`"--lut-strength"`.

`realWorkflow` passes `postProcess: {filmGrain, sharpening, skinContrast,
noiseClean}` (built from `options.film_grain ?? options.filmGrain`, etc.,
same dual-casing pattern every other field in this function already uses)
through to `runWorkflowNative`, only when at least one sub-field is
truthy (mirrors the existing `Boolean(options.faceDetail ??
options.face_detail)` pattern but for a nested options object instead of a
single boolean).

### 5. `commands.ts` (pi-agent-ext-flux2)

New `"postprocess"` entry in `COMMANDS`, reusing `GEN_FIELDS` where
possible (`output`, `outputDir`, `name`, `noArtifacts` — `postprocess` has
no model-loading fields since it loads no model) plus its own
`filmGrain`/`sharpening`/`skinContrast`/`noiseClean`/`seed` fields.

### 6. `registry.ts` note cleanup

`workflow_hybrid`'s notes updated: "post-process is now native for
film-grain/sharpening/skin-contrast/noise-clean; only LUT color-grading
and `--upscale-method seedvr2` still fall back here." Module-header comment
in `workflow_native.ts` (stage 3 paragraph) updated to describe the 4
newly-portable filters and the deferred LUT gap, following the same
pattern the face-detail port used for its own stage-2 paragraph update.

### 7. Testing

Real, non-mocked, property-based assertions on small synthetic fixtures
(no golden-pixel bit-exactness — `FilmGrain`'s RNG won't match Python's
`np.random.default_rng` bit-for-bit, same fidelity bar the XDoG/scribble
precedent already established for classical-CV ports in this repo):

- **`filmGrain`**: on a flat mid-gray image, assert output variance
  increases (noise was added) and mean stays approximately unchanged;
  assert a nonzero `temperature` shifts the R/B channel means apart in the
  expected direction; assert `vignette > 0` darkens corner pixels more than
  the center.
- **`sharpening`**: on a synthetic blurred step-edge image, assert CAS
  increases local contrast across the edge (Laplacian variance goes up)
  without pushing values outside `[0,1]`.
- **`noiseCleaner`**: on a synthetic image with a hard edge plus injected
  Gaussian noise, assert (a) overall variance decreases in flat regions
  (denoising happened) while (b) the edge magnitude is still detectable
  post-filter (bilateral's edge-preserving property, distinguishing it from
  a plain blur that would also smear the edge).
- **`skinContrast`**: on a synthetic image with a skin-tone-colored patch
  and a clearly-non-skin patch (e.g. saturated blue), assert the skin patch
  changes (contrast enhanced) while the non-skin patch stays
  near-unchanged (mask correctly excluded it).
- **`PostProcessCommand`**: real end-to-end run with all 4 flags on a real
  small PNG fixture — asserts output PNG exists, same dimensions as input,
  and differs from the input.
- **`workflow_native.ts`**: unit tests for the relaxed
  `isNativeWorkflowRequest` gate (film_grain/sharpening/skin_contrast/
  noise_clean all now native; LUT and seedvr2 still fall back), plus an
  orchestration test confirming `flux2 postprocess` chains between
  face-detail and upscale (operates on face-detail's output when both are
  requested, and upscale operates on postprocess's output in turn).
