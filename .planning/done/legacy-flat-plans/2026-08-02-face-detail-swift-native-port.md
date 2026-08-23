# Face-Detail Swift-Native Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port `face_detailer.py`'s face-detail stage (mediapipe detect → crop → low-denoise SDEdit regenerate → feathered composite) to Swift-native, and wire it into `workflow_native.ts` so `image workflow --face-detail` no longer falls back to `run.py`.

**Architecture:** A new `FaceDetector.swift` (Apple Vision `VNDetectFaceRectanglesRequest`, bbox-only) plus a new `FaceDetailPipeline.swift` (per-face crop/regenerate/composite loop, library-level so it's testable without ArgumentParser) both land in `swift/flux2-image-director`'s `Flux2Director` library target — the package's first `testTarget`, mirroring `z-image-director`'s `ZImageDirectorTests` shape. A thin `flux2 face-detail` CLI command wires flags + model loading (copying `StyleTransferCommand.swift`'s pattern exactly) and calls the library function. On the Bun side, `pi-agent-ext-flux2`'s `commands.ts` gets a new `"face-detail"` entry (required so `runFlux2({command: "face-detail", ...})` works at all — not mentioned in the design spec but load-bearing), `workflow_native.ts` gains a `faceDetail` option chained between base-gen and upscale, and `bridge.ts`'s `isNativeWorkflowRequest` gate (the design spec calls this "`workflow_native.ts`'s gate" but it actually lives in `bridge.ts` — a spec imprecision caught during planning) is relaxed so `face_detail: true` requests reach the native path instead of falling back to `run.py`.

**Deviation from the literal spec text (both disclosed, both required for the design's own stated goal in §3):**
1. **Output path handling.** The spec's CLI surface (§2) shows a bare required `--output`. But §3 requires `workflow_native.ts` to chain `flux2 face-detail` "the same way it already spawns `flux2 upscale`" — and `defaultRunUpscale` never passes an explicit `output`, only `outputDir` (relying on `OutputPathResolver`'s auto-naming). `FaceDetailCommand` therefore gets `StyleTransferCommand`'s full `--output`/`--output-dir`/`--name` + `RunConfig`/`Manifest` shape, not `CutoutCommand`'s simpler required-`--output` shape.
2. **Algorithm placement.** The spec puts the 6-step algorithm directly inside `FaceDetailCommand.swift` (matching `StyleTransferCommand`'s own style of inlining logic in `run()`). This plan instead puts the per-face crop/regenerate/composite loop in a new library file (`Flux2Director/FaceDetailPipeline.swift`), with the CLI command as a thin wrapper. Reason: this package has never had a `Tests` target, and there's no existing precedent anywhere in this repo for an XCTest that invokes a package's own CLI executable as a subprocess. Every other real/non-mocked Swift test in this codebase (e.g. `ZImageDirectorTests.testLoadMoodyProMixWeights`) tests a **library-level** function. Putting the loop in `Flux2Director` (not `Flux2DirectorCLI`) is the only way to satisfy the spec's "real, non-mocked end-to-end test" requirement without inventing new CLI-subprocess test infrastructure. Same primitives, same algorithm, same file (`FaceDetailCommand.swift`) still owns flag parsing + model loading + wiring.

**Tech Stack:** Swift 6 / MLX Swift / Apple Vision framework (`VNDetectFaceRectanglesRequest`) / swift-argument-parser / Bun + TypeScript / Bun test.

---

### Task 1: `FaceDetector.swift` + Flux2Director's first test target

**Files:**
- Modify: `swift/flux2-image-director/Package.swift`
- Create: `swift/flux2-image-director/Sources/Flux2Director/FaceDetector.swift`
- Test: `swift/flux2-image-director/Tests/Flux2DirectorTests/FaceDetectorTests.swift`

- [ ] **Step 1: Add the `Flux2DirectorTests` test target to `Package.swift`**

This package has never had a `Tests/` directory. Mirror `z-image-director`'s test-target shape exactly (`swift/z-image-director/Package.swift`'s `.testTarget(name: "ZImageDirectorTests", ...)`).

In `swift/flux2-image-director/Package.swift`, change the `targets:` array's closing from:

```swift
        .target(
            name: "Flux2Director",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXRandom", package: "mlx-swift"),
                .product(name: "MLXFast", package: "mlx-swift"),
                .product(name: "ImageGenUtils", package: "image-gen-utils"),
                .product(name: "CommonImageDirector", package: "common-image-director"),
                .product(name: "ZImageDirector", package: "z-image-director"),
            ],
            path: "Sources/Flux2Director"
        ),
    ]
)
```

to:

```swift
        .target(
            name: "Flux2Director",
            dependencies: [
                .product(name: "MLX", package: "mlx-swift"),
                .product(name: "MLXNN", package: "mlx-swift"),
                .product(name: "MLXRandom", package: "mlx-swift"),
                .product(name: "MLXFast", package: "mlx-swift"),
                .product(name: "ImageGenUtils", package: "image-gen-utils"),
                .product(name: "CommonImageDirector", package: "common-image-director"),
                .product(name: "ZImageDirector", package: "z-image-director"),
            ],
            path: "Sources/Flux2Director"
        ),
        .testTarget(
            name: "Flux2DirectorTests",
            dependencies: [
                "Flux2Director",
                .product(name: "CommonImageDirector", package: "common-image-director"),
            ],
            path: "Tests/Flux2DirectorTests"
        ),
    ]
)
```

- [ ] **Step 2: Write the failing test**

Create `swift/flux2-image-director/Tests/Flux2DirectorTests/FaceDetectorTests.swift`:

```swift
import XCTest
@testable import Flux2Director

final class FaceDetectorTests: XCTestCase {

    // MARK: - expandBBox (pure logic, no fixture needed)

    func testExpandBBoxDoublesSizeAroundCenter() {
        let box = FaceBoundingBox(x1: 100, y1: 100, x2: 200, y2: 200)
        let expanded = FaceDetector.expandBBox(box, padding: 2.0, imgW: 1000, imgH: 1000)
        XCTAssertEqual(expanded, FaceBoundingBox(x1: 50, y1: 50, x2: 250, y2: 250))
    }

    func testExpandBBoxClampsToImageBounds() {
        let box = FaceBoundingBox(x1: 10, y1: 10, x2: 60, y2: 60)
        let expanded = FaceDetector.expandBBox(box, padding: 3.0, imgW: 100, imgH: 100)
        XCTAssertEqual(expanded.x1, 0)
        XCTAssertEqual(expanded.y1, 0)
        XCTAssertLessThanOrEqual(expanded.x2, 100)
        XCTAssertLessThanOrEqual(expanded.y2, 100)
    }

    func testExpandBBoxForcesEvenDimensions() {
        // width = (101-0) * 1.0 = 101 -> 101 & ~1 = 100 (even)
        let box = FaceBoundingBox(x1: 0, y1: 0, x2: 101, y2: 101)
        let expanded = FaceDetector.expandBBox(box, padding: 1.0, imgW: 1000, imgH: 1000)
        XCTAssertEqual((expanded.x2 - expanded.x1) % 2, 0)
        XCTAssertEqual((expanded.y2 - expanded.y1) % 2, 0)
    }

    // MARK: - detectFaces (real Vision detection against a git-tracked fixture)

    private var fixtureURL: URL {
        // Tests run with CWD = the package root (swift/flux2-image-director);
        // walk up to the repo root, same discipline as CutoutCommand.swift's
        // runSAM3Bridge python-venv lookup.
        var dir = FileManager.default.currentDirectoryPath
        for _ in 0..<8 {
            let candidate = (dir as NSString).appendingPathComponent(
                "scripts/fixtures/faces/real_face_portrait.png")
            if FileManager.default.fileExists(atPath: candidate) {
                return URL(fileURLWithPath: candidate)
            }
            dir = (dir as NSString).deletingLastPathComponent
        }
        return URL(fileURLWithPath: dir)
    }

    func testDetectFacesFindsRealFaceInFixtureImage() throws {
        let url = fixtureURL
        try XCTSkipUnless(FileManager.default.fileExists(atPath: url.path),
                           "fixture image not found — expected scripts/fixtures/faces/real_face_portrait.png")

        let faces = try FaceDetector.detectFaces(at: url, width: 832, height: 1024)

        XCTAssertGreaterThanOrEqual(faces.count, 1, "expected at least one face detected in the fixture image")
        for face in faces {
            XCTAssertGreaterThan(face.x2, face.x1)
            XCTAssertGreaterThan(face.y2, face.y1)
            XCTAssertGreaterThanOrEqual(face.x1, 0)
            XCTAssertGreaterThanOrEqual(face.y1, 0)
            XCTAssertLessThanOrEqual(face.x2, 832)
            XCTAssertLessThanOrEqual(face.y2, 1024)
        }
    }
}
```

- [ ] **Step 3: Run the test to verify it fails to compile**

Run: `( cd swift/flux2-image-director && swift test --filter FaceDetectorTests 2>&1 | tail -30 )`
Expected: FAIL — `cannot find type 'FaceBoundingBox' in scope` / `cannot find 'FaceDetector' in scope` (the type doesn't exist yet).

- [ ] **Step 4: Implement `FaceDetector.swift`**

Create `swift/flux2-image-director/Sources/Flux2Director/FaceDetector.swift`:

```swift
//
//  FaceDetector.swift
//  Flux2Director
//
//  Native (Vision framework) face bounding-box detection — replaces
//  face_detailer.py's mediapipe `vision.FaceDetector` (blaze_face_short_range
//  TFLite model). VNDetectFaceRectanglesRequest gives bbox-only detection
//  (no landmarks needed; face_detailer.py only ever uses bounding boxes).
//  Vision's confidence calibration differs from mediapipe's — this is a
//  fresh implementation of the same CONCEPT, not a numeric port, matching
//  the precedent set by LipsyncMetrics.swift's VNDetectFaceLandmarksRequest
//  port of lipsync_metrics.py. See
//  docs/superpowers/specs/2026-08-02-face-detail-swift-native-port-design.md.
//

import Vision
import Foundation

/// Axis-aligned bounding box in pixel coordinates, origin top-left.
public struct FaceBoundingBox: Equatable {
    public let x1: Int, y1: Int, x2: Int, y2: Int

    public init(x1: Int, y1: Int, x2: Int, y2: Int) {
        self.x1 = x1; self.y1 = y1; self.x2 = x2; self.y2 = y2
    }
}

public enum FaceDetector {
    /// Detect face bounding boxes in an image file via Apple Vision
    /// (VNDetectFaceRectanglesRequest). Pixel-coordinate boxes, origin
    /// top-left (Vision's own boundingBox is normalized [0,1] with a
    /// BOTTOM-left origin — this function does the y-flip + denormalize).
    /// `VNImageRequestHandler(url:)` reads the file directly — no need to
    /// first decode into an MLXArray/CGImage ourselves (unlike
    /// LipsyncMetrics.swift, which detects on already-decoded video frames
    /// and so needs the `cgImage:` initializer instead).
    public static func detectFaces(
        at imageURL: URL, width: Int, height: Int, minConfidence: Float = 0.5
    ) throws -> [FaceBoundingBox] {
        let handler = VNImageRequestHandler(url: imageURL, options: [:])
        let request = VNDetectFaceRectanglesRequest()
        try handler.perform([request])
        let observations = (request.results ?? []).filter { $0.confidence >= minConfidence }
        return observations.map { obs in
            let bb = obs.boundingBox  // normalized, bottom-left origin
            let x1 = Int((bb.minX * CGFloat(width)).rounded(.down))
            let x2 = Int((bb.maxX * CGFloat(width)).rounded(.up))
            let yTop = 1.0 - bb.maxY  // flip to top-left origin
            let yBottom = 1.0 - bb.minY
            let y1 = Int((yTop * CGFloat(height)).rounded(.down))
            let y2 = Int((yBottom * CGFloat(height)).rounded(.up))
            return FaceBoundingBox(
                x1: max(0, x1), y1: max(0, y1),
                x2: min(width, x2), y2: min(height, y2))
        }
    }

    /// Expand a bounding box by `padding` around its center, clamped to even
    /// dimensions (VAE constraint — same `& ~1` truncation as Python's
    /// `int(w) & ~1`) and image bounds. Direct port of face_detailer.py's
    /// `expand_bbox`. Pure function — no I/O, no MLX — independently
    /// testable, and reused by both FaceDetailCommand (crop sizing) and
    /// FaceDetailPipeline (the same expansion, so both agree exactly).
    public static func expandBBox(_ box: FaceBoundingBox, padding: Float, imgW: Int, imgH: Int) -> FaceBoundingBox {
        let cx = Float(box.x1 + box.x2) / 2
        let cy = Float(box.y1 + box.y2) / 2
        let wi = Int(Float(box.x2 - box.x1) * padding) & ~1
        let hi = Int(Float(box.y2 - box.y1) * padding) & ~1
        let x1 = max(0, Int(cx - Float(wi) / 2))
        let y1 = max(0, Int(cy - Float(hi) / 2))
        let x2 = min(imgW, Int(cx + Float(wi) / 2))
        let y2 = min(imgH, Int(cy + Float(hi) / 2))
        return FaceBoundingBox(x1: x1, y1: y1, x2: x2, y2: y2)
    }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `( cd swift/flux2-image-director && swift build 2>&1 | tail -30 && swift test --filter FaceDetectorTests 2>&1 | tail -40 )`
Expected: PASS — 4 tests, 0 failures (the fixture file is git-tracked so `testDetectFacesFindsRealFaceInFixtureImage` runs for real, not skipped).

- [ ] **Step 6: Commit**

```bash
git add swift/flux2-image-director/Package.swift \
        swift/flux2-image-director/Sources/Flux2Director/FaceDetector.swift \
        swift/flux2-image-director/Tests/Flux2DirectorTests/FaceDetectorTests.swift
git commit -m "feat(flux2): add FaceDetector (Vision-based face bbox detection)

First testTarget for flux2-image-director (mirrors z-image-director's
ZImageDirectorTests shape). VNDetectFaceRectanglesRequest replaces
face_detailer.py's mediapipe detector; expandBBox is a direct port of
expand_bbox, kept pure/testable and shared by the upcoming
FaceDetailPipeline/FaceDetailCommand."
```

---

### Task 2: `FaceDetailPipeline.swift` (per-face crop/regenerate/composite loop)

**Files:**
- Create: `swift/flux2-image-director/Sources/Flux2Director/FaceDetailPipeline.swift`
- Test: `swift/flux2-image-director/Tests/Flux2DirectorTests/FaceDetailPipelineTests.swift`

- [ ] **Step 1: Write the failing test**

Create `swift/flux2-image-director/Tests/Flux2DirectorTests/FaceDetailPipelineTests.swift`:

```swift
import XCTest
import MLX
import CommonImageDirector
@testable import Flux2Director

final class FaceDetailPipelineTests: XCTestCase {

    private static func repoRootRelative(_ relPath: String) -> String {
        var dir = FileManager.default.currentDirectoryPath
        for _ in 0..<8 {
            let candidate = (dir as NSString).appendingPathComponent(relPath)
            if FileManager.default.fileExists(atPath: candidate) { return candidate }
            dir = (dir as NSString).deletingLastPathComponent
        }
        return (FileManager.default.currentDirectoryPath as NSString).appendingPathComponent(relPath)
    }

    /// Real end-to-end: real Vision detection + real Flux2 Klein model load +
    /// real SDEdit regeneration + real composite. Slow (full model load +
    /// denoise) — skipped automatically when the models aren't present on
    /// disk (fresh checkout / CI), same XCTSkipUnless discipline as
    /// ZImageDirectorTests.testLoadMoodyProMixWeights.
    func testDetailFacesRegeneratesFaceRegionAndLeavesRestNearUnchanged() throws {
        let fixture = URL(fileURLWithPath: Self.repoRootRelative(
            "scripts/fixtures/faces/real_face_portrait.png"))
        try XCTSkipUnless(FileManager.default.fileExists(atPath: fixture.path), "fixture image not found")

        let transformerDir = ModelPaths.transformerRoot.appendingPathComponent(Flux2ModelRegistry.defaultTransformer)
        try XCTSkipUnless(FileManager.default.fileExists(atPath: transformerDir.path),
                           "flux2 klein-9b transformer weights not found at \(transformerDir.path) — skipping real E2E test")

        let faces = try FaceDetector.detectFaces(at: fixture, width: 832, height: 1024)
        try XCTSkipIf(faces.isEmpty, "no face detected in fixture — cannot exercise the regenerate/composite path")

        print("  loading flux2 models for real E2E face-detail test...")
        let tfW = try Flux2TransformerWeights.load(dir: transformerDir)
        let tf = Flux2Transformer.build(weights: tfW)
        let teW = try Flux2TextEncoderWeights.load(
            dir: ModelPaths.textEncoderRoot.appendingPathComponent(Flux2ModelRegistry.defaultTextEncoder))
        let te = Flux2TextEncoder.build(weights: teW)
        let tok = Flux2Tokenizer(jsonURL: ModelPaths.tokenizerRoot
            .appendingPathComponent(Flux2ModelRegistry.defaultTokenizer).appendingPathComponent("tokenizer.json"))!
        let vaeURL = ModelPaths.vaeRoot.appendingPathComponent(Flux2ModelRegistry.defaultVAE)
        var vaeWeights: [String: MLXArray] = [:]
        let files = (try FileManager.default.contentsOfDirectory(at: vaeURL, includingPropertiesForKeys: nil))
            .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
        for f in files { vaeWeights.merge(try loadArrays(url: f)) { _, new in new } }
        let bn = Flux2BatchNormStats(
            runningMean: vaeWeights["bn.running_mean"]!, runningVar: vaeWeights["bn.running_var"]!)
        let pipeline = Flux2EditPipeline(
            transformer: tf, textEncoder: te, tokenizer: tok,
            vaeEncoder: Flux2VAEEncoder(weights: vaeWeights),
            vaeDecoder: Flux2VAEDecoder(weights: vaeWeights), bn: bn)

        let image = try Flux2ImageLoad.loadArray(from: fixture, targetSize: (832, 1024))
        let result = try FaceDetailPipeline.detailFaces(
            image: image, faces: faces, prompt: "a woman's face, natural skin detail, photorealistic",
            pipeline: pipeline, seed: 42, steps: 9, denoiseStrength: 0.15, padding: 1.8, feather: 20)

        XCTAssertEqual(result.dim(2), image.dim(2))
        XCTAssertEqual(result.dim(3), image.dim(3))

        // Coarse localization check: the composite should differ MORE inside
        // the (expanded) face region than in a corner patch far from any
        // face — proves detailFaces localized the edit rather than
        // regenerating/blending the whole frame.
        let expanded = FaceDetector.expandBBox(faces[0], padding: 1.8, imgW: 832, imgH: 1024)
        let diff = MLX.abs(result - image)
        MLX.eval(diff)
        let insideDiff = MLX.mean(diff[0..., 0..., expanded.y1..<expanded.y2, expanded.x1..<expanded.x2]).item(Float.self)
        let cornerDiff = MLX.mean(diff[0..., 0..., 0..<50, 0..<50]).item(Float.self)
        XCTAssertGreaterThan(insideDiff, cornerDiff,
            "face-region diff (\(insideDiff)) should exceed a far corner patch's diff (\(cornerDiff))")
    }

    func testDetailFacesReturnsImageUnchangedWhenNoFacesGiven() throws {
        let image = MLX.zeros([1, 3, 64, 64])
        MLX.eval(image)
        // No real pipeline needed — detailFaces must short-circuit before
        // touching `pipeline` when `faces` is empty (`pipeline: nil` is only
        // legal because the empty-faces guard runs first). Compare via
        // .asArray since MLXArray itself isn't Equatable.
        let result = try FaceDetailPipeline.detailFaces(
            image: image, faces: [], prompt: "", pipeline: nil,
            seed: 42, steps: 9, denoiseStrength: 0.15, padding: 1.8, feather: 20)
        MLX.eval(result)
        XCTAssertEqual(result.asArray(Float.self), image.asArray(Float.self))
    }
}
```

- [ ] **Step 2: Run test to verify it fails to compile**

Run: `( cd swift/flux2-image-director && swift test --filter FaceDetailPipelineTests 2>&1 | tail -30 )`
Expected: FAIL — `cannot find 'FaceDetailPipeline' in scope`, and a second error because `pipeline: nil` doesn't type-check against a non-optional `Flux2EditPipeline` parameter yet (this drives the signature below to make `pipeline` optional so the empty-faces path needs no model at all).

- [ ] **Step 3: Implement `FaceDetailPipeline.swift`**

Create `swift/flux2-image-director/Sources/Flux2Director/FaceDetailPipeline.swift`:

```swift
//
//  FaceDetailPipeline.swift
//  Flux2Director
//
//  Per-face crop → low-denoise SDEdit regenerate → feathered composite
//  loop. Direct port of face_detailer.py's `detail_faces()` (minus
//  detection, which FaceDetector.swift owns, and minus LoRA support —
//  deferred, see design spec's Scope section). Takes an ALREADY-LOADED
//  Flux2EditPipeline so callers (FaceDetailCommand) control model
//  lifetime and this stays independently testable without ArgumentParser
//  or a running CLI process.
//

import CommonImageDirector
import Foundation
import MLX

public enum FaceDetailPipeline {
    /// `faces` are RAW (un-expanded) detection boxes from
    /// `FaceDetector.detectFaces`. Returns `image` unchanged if `faces` is
    /// empty (mirrors Python's "no faces detected — skipping", not an
    /// error) — `pipeline` is optional and never touched on that path, so
    /// callers with zero detected faces don't need a loaded model at all.
    /// Processes faces sequentially, each composited onto the accumulating
    /// `result` before the next face is cropped from the ORIGINAL `image`
    /// (matches Python's `image.crop(...)` reading from the untouched
    /// source while `result.paste(...)` accumulates).
    public static func detailFaces(
        image: MLXArray, faces: [FaceBoundingBox], prompt: String,
        pipeline: Flux2EditPipeline?, seed: UInt64, steps: Int,
        denoiseStrength: Float, padding: Float, feather: Int
    ) throws -> MLXArray {
        guard !faces.isEmpty, let pipeline else { return image }

        let h = image.dim(2), w = image.dim(3)
        var result = image

        for (idx, face) in faces.enumerated() {
            let expanded = FaceDetector.expandBBox(face, padding: padding, imgW: w, imgH: h)
            let cropW = expanded.x2 - expanded.x1
            let cropH = expanded.y2 - expanded.y1
            guard cropW > 0, cropH > 0 else { continue }
            print("  [face-detail] face \(idx + 1)/\(faces.count): (\(expanded.x1),\(expanded.y1))-(\(expanded.x2),\(expanded.y2)) [\(cropW)x\(cropH)]")

            let crop = image[0..., 0..., expanded.y1..<expanded.y2, expanded.x1..<expanded.x2]
            let tempCrop = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("flux2-face-detail-\(UUID().uuidString).png")
            defer { try? FileManager.default.removeItem(at: tempCrop) }
            try ImageSave.savePNG(crop, to: tempCrop)

            let (detailedCrop, _) = pipeline.generate(
                prompt: prompt, imagePaths: [], seed: seed,
                height: cropH, width: cropW, steps: steps, guidance: 1.0,
                initImagePath: tempCrop, denoiseStrength: denoiseStrength)

            // Full-canvas mask: 1.0 inside the expanded box, 0.0 elsewhere.
            // Flux2Composite resizes `reference` to fit the mask's bbox
            // (here a no-op — detailedCrop is already cropW×cropH) and
            // handles feathering itself.
            var mask = MLX.zeros([1, 1, h, w])
            mask[0..., 0..., expanded.y1..<expanded.y2, expanded.x1..<expanded.x2] =
                MLX.ones([1, 1, cropH, cropW])

            result = Flux2Composite.composite(
                source: result, reference: detailedCrop, mask: mask, featherRadius: feather)
        }

        return result
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `( cd swift/flux2-image-director && swift build 2>&1 | tail -30 && swift test --filter FaceDetailPipelineTests 2>&1 | tail -60 )`
Expected: `testDetailFacesReturnsImageUnchangedWhenNoFacesGiven` PASSes immediately. `testDetailFacesRegeneratesFaceRegionAndLeavesRestNearUnchanged` either PASSes (slow — full model load + 9-step denoise, likely 30s-2min on Apple Silicon) if `mlx-models/transformer/klein-9b` is present, or SKIPs with a clear reason if not. Confirm which case applies locally and report the actual outcome — do not assume.

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2Director/FaceDetailPipeline.swift \
        swift/flux2-image-director/Tests/Flux2DirectorTests/FaceDetailPipelineTests.swift
git commit -m "feat(flux2): add FaceDetailPipeline (crop/regenerate/composite loop)

Library-level port of face_detailer.py's detail_faces() per-face loop,
reusing Flux2EditPipeline (SDEdit regen) + Flux2Composite (feathered
paste-back) + FaceDetector.expandBBox. Kept in Flux2Director (not the
CLI target) so it has a real end-to-end XCTest without needing new
CLI-subprocess test infrastructure."
```

---

### Task 3: `flux2 face-detail` CLI command

**Files:**
- Create: `swift/flux2-image-director/Sources/Flux2DirectorCLI/FaceDetailCommand.swift`
- Modify: `swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift`

- [ ] **Step 1: Register the (not-yet-existing) command in `Flux2CLI.swift`**

In `swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift`, change:

```swift
        subcommands: [
            T2I.self, Edit.self, Angle.self, Segment.self, Cutout.self, Swap.self, Style.self,
            Story.self, Kontext.self, Scene.self, Expand.self, Inpaint.self, StyleTransfer.self, FaceSwap.self, Upscale.self, Gate.self, Models.self, VerifyVAE.self, VerifyEncoder.self,
```

to:

```swift
        subcommands: [
            T2I.self, Edit.self, Angle.self, Segment.self, Cutout.self, Swap.self, Style.self,
            Story.self, Kontext.self, Scene.self, Expand.self, Inpaint.self, StyleTransfer.self, FaceSwap.self, FaceDetail.self, Upscale.self, Gate.self, Models.self, VerifyVAE.self, VerifyEncoder.self,
```

Also add one line to the module doc's subcommand list (after the `faceswap` line):

```swift
//    faceswap     — BFS face/head swap (Flux2 Klein 9B + BFS LoRA-at-init, port of image-faceswap.py)
//    face-detail  — detect faces (Apple Vision) + low-denoise regenerate + composite (port of face_detailer.py)
```

- [ ] **Step 2: Confirm it fails to build (the type doesn't exist yet)**

Run: `( cd swift/flux2-image-director && swift build 2>&1 | tail -20 )`
Expected: FAIL — `cannot find type 'FaceDetail' in scope`.

- [ ] **Step 3: Implement `FaceDetailCommand.swift`**

Create `swift/flux2-image-director/Sources/Flux2DirectorCLI/FaceDetailCommand.swift`:

```swift
//
//  FaceDetailCommand.swift
//  Flux2DirectorCLI
//
//  `flux2 face-detail` — detect faces (Apple Vision), crop + pad, regenerate
//  each crop at low-denoise SDEdit strength, feathered-composite back. Port
//  of face_detailer.py's `detail_faces()` orchestration; the per-face loop
//  itself lives in Flux2Director's FaceDetailPipeline (library-level, so it
//  stays testable without ArgumentParser). Model-loading mirrors
//  StyleTransferCommand.swift exactly (same flags/defaults).
//
//  No faces detected -> the input is copied to the output unchanged, exit 0
//  (mirrors Python's "no faces detected — skipping", NOT an error).
//
//  LoRA support for the regeneration step (face_detailer.py's lora_path/
//  lora_scale) is deliberately NOT exposed — no caller in this repo's
//  current workflow usage needs it (YAGNI); see design spec's Scope
//  section.
//

import ArgumentParser
import CommonImageDirector
import Flux2Director
import Foundation
import MLX

extension Flux2CLI {
    struct FaceDetail: ParsableCommand {
        static let configuration = CommandConfiguration(
            commandName: "face-detail",
            abstract: "Detect faces and regenerate each at higher detail (Flux2 Klein SDEdit img2img, Apple Vision detection)."
        )

        @OptionGroup var globals: GlobalOptions

        @Option(help: "Source image path.")
        var input: String

        @Option(help: "Text prompt describing the person/scene, used for face-detail regeneration.")
        var prompt: String = ""

        @Option(help: "Bounding-box expansion factor around each detected face.")
        var padding: Float = 1.8

        @Option(help: "Feather radius (px) for the composite seam.")
        var feather: Int = 20

        @Option(name: .customLong("denoise-strength"), help: "SDEdit denoise strength on each face crop (0.15 subtle .. 0.3 noticeable).")
        var denoiseStrength: Float = 0.15

        @Option(help: "Denoising steps for face regeneration.")
        var steps: Int = 9

        @Option(name: .customLong("min-confidence"), help: "Minimum Vision face-detection confidence (0-1).")
        var minConfidence: Float = 0.5

        @Option var seed: UInt64 = 42
        @Option var transformer: String = Flux2ModelRegistry.defaultTransformer
        @Option var vae: String = Flux2ModelRegistry.defaultVAE
        @Option var encoder: String = Flux2ModelRegistry.defaultTextEncoder
        @Option var tokenizerDir: String = Flux2ModelRegistry.defaultTokenizer
        @Option var output: String = ""
        @Option var outputDir: String?
        @Option var name: String?
        @Flag var noArtifacts: Bool = false

        @Flag(help: "Abort (exit 1) if the output FAILs the image gate.")
        var strictGate: Bool = false

        func validate() throws {
            guard padding > 0 else { throw ValidationError("--padding must be > 0") }
            guard denoiseStrength > 0 && denoiseStrength <= 1.0 else {
                throw ValidationError("--denoise-strength must be in (0, 1.0]")
            }
        }

        func run() throws {
            setbuf(stdout, nil)
            globals.apply()

            print("flux2 face-detail — detect + regenerate faces")
            print("  input     : \(input)")
            print("  padding   : \(padding), feather: \(feather), denoise: \(denoiseStrength), steps: \(steps)")
            print("  min-conf  : \(minConfidence), seed: \(seed)")

            let (width, height) = try Flux2ImageLoad.imageSize(at: URL(fileURLWithPath: input))
            let rgb = try Flux2ImageLoad.loadArray(from: URL(fileURLWithPath: input), targetSize: (width, height))

            let faces = try FaceDetector.detectFaces(
                at: URL(fileURLWithPath: input), width: width, height: height, minConfidence: minConfidence)

            let paths = try OutputPathResolver.makePaths(
                explicitOutput: output.isEmpty ? nil : output,
                outputDir: outputDir, customName: name)
            let imagePath = URL(fileURLWithPath: paths.png)

            guard !faces.isEmpty else {
                print("  [face-detail] No faces detected — copying input unchanged")
                try ImageSave.savePNG(rgb, to: imagePath)
                print("")
                print("✅ face-detail (no-op) \(imagePath.lastPathComponent)")
                print("   \(imagePath.path)")
                return
            }
            print("  [face-detail] Found \(faces.count) face(s)")

            print("  loading models...")
            let tfW = try Flux2TransformerWeights.load(
                dir: ModelPaths.transformerRoot.appendingPathComponent(transformer))
            let tf = Flux2Transformer.build(weights: tfW)
            let teW = try Flux2TextEncoderWeights.load(
                dir: ModelPaths.textEncoderRoot.appendingPathComponent(encoder))
            let te = Flux2TextEncoder.build(weights: teW)
            let tok = Flux2Tokenizer(jsonURL: ModelPaths.tokenizerRoot
                .appendingPathComponent(tokenizerDir).appendingPathComponent("tokenizer.json"))!
            let vaeURL = ModelPaths.vaeRoot.appendingPathComponent(vae)
            let vaeWeights = try Self.loadAllShards(url: vaeURL)
            let bn = Flux2BatchNormStats(
                runningMean: vaeWeights["bn.running_mean"]!,
                runningVar: vaeWeights["bn.running_var"]!)
            let pipeline = Flux2EditPipeline(
                transformer: tf, textEncoder: te, tokenizer: tok,
                vaeEncoder: Flux2VAEEncoder(weights: vaeWeights),
                vaeDecoder: Flux2VAEDecoder(weights: vaeWeights), bn: bn)

            print("  generating...")
            let start = DispatchTime.now()
            let result = try FaceDetailPipeline.detailFaces(
                image: rgb, faces: faces, prompt: prompt, pipeline: pipeline,
                seed: seed, steps: steps, denoiseStrength: denoiseStrength,
                padding: padding, feather: feather)
            let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9

            try ImageGate.check(result, label: "face-detail", strict: strictGate)

            try Flux2T2IPipeline.saveImage(result, to: imagePath)
            print("")
            print("✅ face-detail \(imagePath.lastPathComponent)  (\(String(format: "%.1f", elapsed))s)")
            print("   \(imagePath.path)")

            if !noArtifacts {
                try writeArtifacts(paths: paths, elapsed: elapsed, faceCount: faces.count, width: width, height: height)
            }
        }

        private func writeArtifacts(paths: OutputPaths, elapsed: Double, faceCount: Int, width: Int, height: Int) throws {
            let startTime = Manifest.nowISO()
            let runConfig = RunConfig(
                transformer: transformer, prompt: prompt,
                width: width, height: height, steps: steps, seed: seed, cfgScale: 1.0,
                loraPaths: nil, loraScale: 1.0, loraScales: nil,
                textEncoder: encoder, tokenizer: tokenizerDir, vae: vae,
                quantBits: 8, quantGroupSize: 64, command: "face-detail", pipeline: "flux2"
            )
            try runConfig.write(to: paths.runJSON)
            let sizeBytes = (try? FileManager.default.attributesOfItem(
                atPath: paths.png)[.size] as? Int64) ?? 0
            let manifest = Manifest.success(
                runFile: paths.runJSON, startTime: startTime, endTime: Manifest.nowISO(),
                timings: ["generation": elapsed], models: [:],
                outputFiles: [ManifestOutput(path: URL(fileURLWithPath: paths.png).lastPathComponent,
                                             seed: Int(seed), sizeBytes: sizeBytes,
                                             width: width, height: height)],
                quality: nil, perf: nil)
            try manifest.write(to: paths.manifestJSON)
            print("   run.json:   \(paths.runJSON)")
            print("   manifest:   \(paths.manifestJSON)")
            print("   faces:      \(faceCount)")
        }

        private static func loadAllShards(url: URL) throws -> [String: MLXArray] {
            var all: [String: MLXArray] = [:]
            let files = (try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil))
                .filter { $0.pathExtension == "safetensors" && !$0.lastPathComponent.hasPrefix("._") }
                .sorted { $0.lastPathComponent < $1.lastPathComponent }
            for f in files { all.merge(try loadArrays(url: f)) { _, new in new } }
            return all
        }
    }
}
```

- [ ] **Step 4: Build and smoke-test manually**

Run: `( cd swift/flux2-image-director && swift build -c release 2>&1 | tail -40 )`
Expected: builds cleanly.

Run (real smoke test — this DOES load models and generate, expect it to take a minute or two):
```bash
( cd swift/flux2-image-director && .build/release/flux2 face-detail \
    --input ../../scripts/fixtures/faces/real_face_portrait.png \
    --prompt "a woman's face, natural skin detail, photorealistic" \
    --output /tmp/face-detail-smoke-test.png )
```
Expected: prints `Found 1 face(s)` (or more), then `✅ face-detail ... .png`, and `/tmp/face-detail-smoke-test.png` exists with the same 832×1024 dimensions as the input. Also run `flux2 face-detail --help` and confirm every flag listed above (`--input --prompt --padding --feather --denoise-strength --steps --min-confidence --seed --transformer --vae --encoder --tokenizer-dir --output --output-dir --name --no-artifacts --strict-gate --models-root`) is present — Task 4 needs this exact flag list to match `commands.ts`.

- [ ] **Step 5: Commit**

```bash
git add swift/flux2-image-director/Sources/Flux2DirectorCLI/FaceDetailCommand.swift \
        swift/flux2-image-director/Sources/Flux2DirectorCLI/Flux2CLI.swift
git commit -m "feat(flux2): add flux2 face-detail CLI command

Thin ArgumentParser wrapper: parses flags, loads models (mirrors
StyleTransferCommand.swift), detects faces via FaceDetector, delegates
the crop/regenerate/composite loop to FaceDetailPipeline. No faces
detected -> copies input to output unchanged (exit 0, not an error)."
```

---

### Task 4: `pi-agent-ext-flux2` `commands.ts` wiring for `face-detail`

**Why this task exists:** not mentioned in the design spec, but `workflow_native.ts` (Task 5) calls `runFlux2({command: "face-detail", ...})`, and `runFlux2` looks up `COMMANDS["face-detail"]` (`bun-apps/pi-agent-ext-flux2/src/index.ts:199`) to build the CLI args — without this entry the call throws immediately. `commands.ts` is this tool's single source of truth for every `flux2` subcommand's flags, drift-checked against `flux2 --help` by `scripts/check-flags.ts`.

**Files:**
- Modify: `bun-apps/pi-agent-ext-flux2/src/commands.ts`
- Test: `bun-apps/pi-agent-ext-flux2/src/commands.test.ts`

- [ ] **Step 1: Write the failing test**

In `bun-apps/pi-agent-ext-flux2/src/commands.test.ts`, add (near the other per-command shape assertions):

```ts
test("face-detail command is registered with its own flags", () => {
  const spec = cmd("face-detail");
  expect(spec.name).toBe("face-detail");
  expect(spec.writesImage).toBe(true);
  expect(Object.keys(spec.fields)).toContain("input");
  expect(Object.keys(spec.fields)).toContain("padding");
  expect(Object.keys(spec.fields)).toContain("minConfidence");
  expect(spec.fields.minConfidence?.flag).toBe("--min-confidence");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-flux2 && bun test src/commands.test.ts 2>&1 | tail -20 )`
Expected: FAIL — `cmd("face-detail")` throws `unknown flux2 command "face-detail"`.

- [ ] **Step 3: Add the `"face-detail"` entry to `COMMANDS`**

In `bun-apps/pi-agent-ext-flux2/src/commands.ts`, add a new entry to the `COMMANDS` object (alongside the other dashed-name entries like `"kv-style-transfer"`):

```ts
  "face-detail": {
    name: "face-detail",
    writesImage: true,
    acceptsGlobals: true,
    when: "Detect faces (Apple Vision) and regenerate each at higher detail via low-denoise SDEdit, feathered-composited back — port of face_detailer.py. Copies input to output unchanged if no faces are detected.",
    fields: {
      input: { flag: "--input", type: "string", isPath: true, description: "Source image path." },
      prompt: { flag: "--prompt", type: "string", description: "Text prompt describing the person/scene, used for face-detail regeneration." },
      padding: { flag: "--padding", type: "number", description: "Bounding-box expansion factor around each detected face. Default 1.8." },
      feather: { flag: "--feather", type: "int", description: "Feather radius (px) for the composite seam. Default 20." },
      denoiseStrength: { flag: "--denoise-strength", type: "number", description: "SDEdit denoise strength on each face crop (0.15 subtle .. 0.3 noticeable). Default 0.15." },
      steps: { flag: "--steps", type: "int", description: "Denoising steps for face regeneration. Default 9." },
      minConfidence: { flag: "--min-confidence", type: "number", description: "Minimum Vision face-detection confidence (0-1). Default 0.5." },
      seed: GEN_FIELDS.seed,
      transformer: GEN_FIELDS.transformer,
      vae: GEN_FIELDS.vae,
      encoder: GEN_FIELDS.encoder,
      tokenizerDir: GEN_FIELDS.tokenizerDir,
      output: GEN_FIELDS.output,
      outputDir: GEN_FIELDS.outputDir,
      name: GEN_FIELDS.name,
      noArtifacts: GEN_FIELDS.noArtifacts,
      strictGate: GEN_FIELDS.strictGate,
    },
  },
```

Place it near `styletransfer`/`upscale` (alphabetical-ish grouping isn't strictly enforced in this file — match whatever the surrounding entries do).

- [ ] **Step 4: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-flux2 && bun test src/commands.test.ts 2>&1 | tail -20 )`
Expected: PASS.

- [ ] **Step 5: Run the drift guard against the real built binary**

Requires Task 3's `flux2` binary already built (`swift/flux2-image-director/.build/release/flux2`).

Run: `( cd bun-apps/pi-agent-ext-flux2 && bun run check:flags 2>&1 | tail -60 )`
Expected: no drift reported for `face-detail` (every flag `flux2 face-detail --help` prints is modeled in `commands.ts`, and every field modeled has a matching real flag). If it reports drift, reconcile `commands.ts`'s field list against the actual `--help` output rather than allow-listing the mismatch away.

- [ ] **Step 6: Run the full package test suite**

Run: `( cd bun-apps/pi-agent-ext-flux2 && bun test 2>&1 | tail -30 )`
Expected: all pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add bun-apps/pi-agent-ext-flux2/src/commands.ts bun-apps/pi-agent-ext-flux2/src/commands.test.ts
git commit -m "feat(flux2): register face-detail in the commands.ts flag registry

Required for runFlux2({command: \"face-detail\", ...}) to work at all —
COMMANDS[\"face-detail\"] is what workflow_native.ts's upcoming
defaultRunFaceDetail call looks up. Verified flag-for-flag against the
real flux2 face-detail --help via check:flags."
```

---

### Task 5: `workflow_native.ts` — chain `face-detail` between base-gen and upscale

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/workflow_native.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/workflow_native.test.ts`

- [ ] **Step 1: Write the failing tests**

In `bun-apps/pi-agent-ext-movie-director/src/workflow_native.test.ts`, change the import line:

```ts
import {
  runWorkflowNative,
  type BaseGenFn,
  type UpscaleFn,
} from "./workflow_native.ts";
```

to:

```ts
import {
  runWorkflowNative,
  type BaseGenFn,
  type FaceDetailFn,
  type UpscaleFn,
} from "./workflow_native.ts";
```

Then add these tests inside the existing `describe(...)` block, after the `"chains ESRGAN upscale onto the base image when requested"` test:

```ts
  it("chains face-detail onto the base image when requested", async () => {
    const faceDetailCalls: string[] = [];
    const runFaceDetail: FaceDetailFn = async (input) => {
      faceDetailCalls.push(input);
      return { path: "/out/t2i_facedetail.png", width: 640, height: 960 };
    };

    const result = await runWorkflowNative({
      prompt: "a portrait",
      faceDetail: true,
      _runBase: fakeBase,
      _runFaceDetail: runFaceDetail,
    });

    expect(faceDetailCalls).toEqual(["/out/t2i.png"]);
    expect(result.stages).toEqual(["base", "face_detail"]);
    expect(result.finalImage).toBe("/out/t2i_facedetail.png");
    expect(result.faceDetailImage).toBe("/out/t2i_facedetail.png");
  });

  it("chains upscale onto the face-detail output, not the base image, when both are requested", async () => {
    const upscaleCalls: string[] = [];
    const runFaceDetail: FaceDetailFn = async () => ({ path: "/out/t2i_facedetail.png", width: 640, height: 960 });
    const runUpscale: UpscaleFn = async (input) => {
      upscaleCalls.push(input);
      return { path: "/out/t2i_facedetail_upscaled.png", width: 2560, height: 3840 };
    };

    const result = await runWorkflowNative({
      prompt: "a portrait",
      faceDetail: true,
      upscale: true,
      _runBase: fakeBase,
      _runFaceDetail: runFaceDetail,
      _runUpscale: runUpscale,
    });

    expect(upscaleCalls).toEqual(["/out/t2i_facedetail.png"]);
    expect(result.stages).toEqual(["base", "face_detail", "upscale"]);
    expect(result.finalImage).toBe("/out/t2i_facedetail_upscaled.png");
  });

  it("does not call face-detail when faceDetail is false/unset", async () => {
    let called = false;
    const runFaceDetail: FaceDetailFn = async () => {
      called = true;
      return { path: "/never.png", width: null, height: null };
    };
    const result = await runWorkflowNative({ prompt: "x", _runBase: fakeBase, _runFaceDetail: runFaceDetail });
    expect(called).toBe(false);
    expect(result.stages).toEqual(["base"]);
  });

  it("propagates a face-detail failure (no partial-success mode)", async () => {
    const runFaceDetail: FaceDetailFn = async () => {
      throw new Error("workflow: face-detail failed: boom");
    };
    await expect(
      runWorkflowNative({ prompt: "x", faceDetail: true, _runBase: fakeBase, _runFaceDetail: runFaceDetail }),
    ).rejects.toThrow(/boom/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/workflow_native.test.ts 2>&1 | tail -40 )`
Expected: FAIL — `FaceDetailFn` doesn't exist, `faceDetail`/`_runFaceDetail` aren't valid `WorkflowNativeOptions` fields, `result.faceDetailImage` is `undefined`.

- [ ] **Step 3: Update the module doc's stage-2 verdict**

In `bun-apps/pi-agent-ext-movie-director/src/workflow_native.ts`, the module doc's stage-2 paragraph currently reads (lines ~16-30):

```
 *   2. FACE DETAILER (`app/face_detailer.py`, 246 lines) — `detect_faces()`
 *      (line 41) uses `mediapipe.tasks.python.vision.FaceDetector` (a
 *      TFLite-backed bbox detector, `blaze_face_short_range.tflite`) to find
 *      face boxes, then `detail_faces()` (line 138) crops+pads each box and
 *      re-denoises it via the SAME `ZImagePipeline.generate()` I2I path used
 *      by stage 1, feather-composited back with PIL `Image.paste(mask=...)`.
 *      So the RE-DENOISE half is portable (same native I2I as base-gen), but
 *      the DETECTION half is not: no mediapipe/Vision-framework-backed face
 *      detector exists anywhere in swift/ (grepped for face/detail/landmark
 *      across all 6 swift packages — zero hits outside unrelated Whisper/
 *      ModelRegistry/Verify files). Apple's Vision framework COULD replace
 *      mediapipe (VNDetectFaceRectanglesRequest), but that is a genuinely NEW
 *      native port (a face-detection primitive this repo has never shipped),
 *      not orchestration of an already-native primitive — out of scope here.
 *      NOT PORTABLE in this session's orchestration-only scope.
```

Replace it with:

```
 *   2. FACE DETAILER (`app/face_detailer.py`, 246 lines) — `detect_faces()`
 *      (line 41) uses `mediapipe.tasks.python.vision.FaceDetector` (a
 *      TFLite-backed bbox detector, `blaze_face_short_range.tflite`) to find
 *      face boxes, then `detail_faces()` (line 138) crops+pads each box and
 *      re-denoises it via the SAME `ZImagePipeline.generate()` I2I path used
 *      by stage 1, feather-composited back with PIL `Image.paste(mask=...)`.
 *      NOW PORTABLE (2026-08-02): `swift/flux2-image-director`'s
 *      `FaceDetector.swift` (VNDetectFaceRectanglesRequest) replaces the
 *      mediapipe detection half, and `FaceDetailPipeline.swift` replicates
 *      the crop/regenerate/composite loop using the existing
 *      `Flux2EditPipeline` (SDEdit I2I) + `Flux2Composite` (feathered
 *      paste-back) primitives — see
 *      docs/superpowers/specs/2026-08-02-face-detail-swift-native-port-design.md.
 *      Exposed as `flux2 face-detail`, chained here between base-gen and
 *      upscale (see `runWorkflowNative`).
```

And the "NET" summary paragraph near the end (currently: `"NET: the genuinely portable subset is base-generation (T2I/I2I, stage 1) chained with ESRGAN upscale (stage 4)..."`) — update to:

```
 * NET: the genuinely portable subset is base-generation (T2I/I2I, stage 1)
 * optionally chained with face-detail (stage 2) and/or ESRGAN upscale
 * (stage 4). Post-processing (stage 3) and `--upscale-method seedvr2` are
 * NOT silently dropped: `isNativeWorkflowRequest` (bridge.ts) refuses the
 * native path and falls back to run.py's `image workflow` (realRunPyImage)
 * whenever either is requested — the same style-forked routing discipline
 * `isNativeControlNetRequest` established for `controlnet`.
 */
```

(This replaces the final two sentences of the existing NET paragraph and the doc's closing `*/` — leave everything before "NET:" unchanged.)

- [ ] **Step 4: Add the `faceDetail` option, `FaceDetailFn` type, and `defaultRunFaceDetail`**

In `WorkflowNativeOptions`, add after `denoiseStrength`:

```ts
  /** I2I denoise strength (mirrors Python's `denoise_strength`, krea2's `strength`). */
  denoiseStrength?: number;
  /** Run stage 2 (face-detail: Apple Vision detect + SDEdit regenerate + composite) — see module doc. */
  faceDetail?: boolean;
  /** Run stage 4 (ESRGAN only — see module doc; `seedvr2` must never reach here). */
  upscale?: boolean;
```

Add after `BaseGenResult`/`BaseGenFn`:

```ts
export interface FaceDetailResult {
  path: string;
  width: number | null;
  height: number | null;
}
export type FaceDetailFn = (input: string, opts: WorkflowNativeOptions) => Promise<FaceDetailResult>;
```

Add `_runFaceDetail` to `WorkflowNativeOptions` (next to `_runBase`/`_runUpscale`):

```ts
  /** Test seam: inject a canned base-generation call (t2i/i2i). */
  _runBase?: BaseGenFn;
  /** Test seam: inject a canned face-detail call. */
  _runFaceDetail?: FaceDetailFn;
  /** Test seam: inject a canned upscale call. */
  _runUpscale?: UpscaleFn;
```

Add `defaultRunFaceDetail` after `defaultRunBase` (before `defaultRunUpscale`):

```ts
/** Default face-detail call: flux2 native `face-detail` (Apple Vision detection + SDEdit regenerate + feathered composite). Reuses the SAME `prompt` as base-gen — face_detailer.py's own `detail_faces()` takes the workflow's single prompt, not a separate one. */
export const defaultRunFaceDetail: FaceDetailFn = async (input, opts) => {
  const out = await runFlux2({
    command: "face-detail",
    options: { input, prompt: opts.prompt, seed: opts.seed },
    outputDir: opts.outputDir,
  });
  const d: Flux2Details = out.details;
  if (!d.ok || !d.output) {
    throw new Error(`workflow: face-detail failed: ${out.summary}\n${out.stderrTail}`.trim());
  }
  return { path: d.output, width: d.width, height: d.height };
};
```

- [ ] **Step 5: Add `faceDetailImage` to the result type and update `"base" | "upscale"` stage unions**

Change `WorkflowNativeResult`:

```ts
export interface WorkflowNativeResult {
  /** The last-produced image path (post-upscale if it ran, else post-face-detail if it ran, else base). */
  finalImage: string;
  baseImage: string;
  faceDetailImage: string | null;
  upscaledImage: string | null;
  seed: number | null;
  width: number | null;
  height: number | null;
  /** Stages that actually ran, in order — mirrors Python's `stage_images.keys()` (a subset of base/face_detail/postprocess/upscale; this port only ever produces base and/or face_detail and/or upscale). */
  stages: ("base" | "face_detail" | "upscale")[];
}
```

- [ ] **Step 6: Chain face-detail into `runWorkflowNative`, and chain upscale from `finalImage` (not `base.path`)**

Change the body of `runWorkflowNative` from:

```ts
  const runBase = opts._runBase ?? defaultRunBase;
  const base = await runBase(opts);

  const stages: ("base" | "upscale")[] = ["base"];
  let finalImage = base.path;
  let upscaledImage: string | null = null;
  let width = base.width;
  let height = base.height;

  if (opts.upscale) {
    const runUpscale = opts._runUpscale ?? defaultRunUpscale;
    const up = await runUpscale(base.path, opts);
    finalImage = up.path;
    upscaledImage = up.path;
    stages.push("upscale");
    width = up.width ?? width;
    height = up.height ?? height;
  }

  return {
    finalImage,
    baseImage: base.path,
    upscaledImage,
    seed: base.seed,
    width,
    height,
    stages,
  };
```

to:

```ts
  const runBase = opts._runBase ?? defaultRunBase;
  const base = await runBase(opts);

  const stages: ("base" | "face_detail" | "upscale")[] = ["base"];
  let finalImage = base.path;
  let faceDetailImage: string | null = null;
  let upscaledImage: string | null = null;
  let width = base.width;
  let height = base.height;

  if (opts.faceDetail) {
    const runFaceDetail = opts._runFaceDetail ?? defaultRunFaceDetail;
    const fd = await runFaceDetail(finalImage, opts);
    finalImage = fd.path;
    faceDetailImage = fd.path;
    stages.push("face_detail");
    width = fd.width ?? width;
    height = fd.height ?? height;
  }

  if (opts.upscale) {
    const runUpscale = opts._runUpscale ?? defaultRunUpscale;
    const up = await runUpscale(finalImage, opts);
    finalImage = up.path;
    upscaledImage = up.path;
    stages.push("upscale");
    width = up.width ?? width;
    height = up.height ?? height;
  }

  return {
    finalImage,
    baseImage: base.path,
    faceDetailImage,
    upscaledImage,
    seed: base.seed,
    width,
    height,
    stages,
  };
```

Note `runUpscale(finalImage, opts)` (was `runUpscale(base.path, opts)`) — this is the real behavior fix: upscale must run on the face-detail output when both stages are requested, matching Python's stage order (each stage operates on the previous stage's output, not always on the raw base).

- [ ] **Step 7: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/workflow_native.test.ts 2>&1 | tail -60 )`
Expected: PASS — all 10 tests (6 pre-existing + 4 new).

- [ ] **Step 8: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/workflow_native.ts \
        bun-apps/pi-agent-ext-movie-director/src/workflow_native.test.ts
git commit -m "feat(workflow-native): chain flux2 face-detail between base-gen and upscale

faceDetail option + defaultRunFaceDetail (flux2 native face-detail,
reusing the base-gen prompt) chained after base-gen; upscale now runs
on the face-detail output (not always the raw base) when both stages
are requested, matching Python's per-stage-operates-on-previous-output
order. Module doc updated: stage 2 is no longer NOT PORTABLE."
```

---

### Task 6: `bridge.ts` — relax `isNativeWorkflowRequest` for `face_detail`

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/bridge.test.ts`

- [ ] **Step 1: Write the failing test**

In `bun-apps/pi-agent-ext-movie-director/src/bridge.test.ts`, replace the existing test:

```ts
  it("false when face_detail is requested (camelCase or snake_case)", () => {
    expect(isNativeWorkflowRequest({ prompt: "x", faceDetail: true })).toBe(false);
    expect(isNativeWorkflowRequest({ prompt: "x", face_detail: true })).toBe(false);
  });
```

with:

```ts
  it("true when face_detail is requested — now native (camelCase or snake_case)", () => {
    expect(isNativeWorkflowRequest({ prompt: "x", faceDetail: true })).toBe(true);
    expect(isNativeWorkflowRequest({ prompt: "x", face_detail: true })).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/bridge.test.ts -t "isNativeWorkflowRequest" 2>&1 | tail -30 )`
Expected: FAIL — `isNativeWorkflowRequest({ prompt: "x", faceDetail: true })` still returns `false`.

- [ ] **Step 3: Relax the gate**

In `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`, update the doc comment above `isNativeWorkflowRequest` (currently lines ~607-630) from:

```
 * Native path is only safe when NONE of the non-portable stages are
 * requested: face-detail (needs mediapipe/Vision-framework face DETECTION,
 * not just the I2I re-denoise it wraps — no Swift port exists), any
 * post-process filter (film grain/sharpening/LUT/skin-contrast/noise-clean —
 * pure pixel math, but no image-codec dep in this package and no Swift
 * filter chain either), or `upscale_method: "seedvr2"` (confirmed
 * PyTorch/torch-MPS-only, no MLX/Swift port anywhere).
```

to:

```
 * Native path is only safe when NONE of the non-portable stages are
 * requested: any post-process filter (film grain/sharpening/LUT/
 * skin-contrast/noise-clean — pure pixel math, but no image-codec dep in
 * this package and no Swift filter chain either), or `upscale_method:
 * "seedvr2"` (confirmed PyTorch/torch-MPS-only, no MLX/Swift port
 * anywhere). face-detail is now native too (FaceDetector.swift's
 * VNDetectFaceRectanglesRequest, 2026-08-02) — see workflow_native.ts's
 * module doc.
```

Then change the function body from:

```ts
  const NONPORTABLE_OPTION_KEYS = [
    "faceDetail", "face_detail",
    "filmGrain", "film_grain",
    "sharpening",
    "lut", "lutPath", "lut_path",
    "skinContrast", "skin_contrast",
    "noiseClean", "noise_clean",
  ];
  for (const k of NONPORTABLE_OPTION_KEYS) {
    if (truthy(options[k])) return false;
  }
  const upscaleMethod = options.upscaleMethod ?? options.upscale_method;
  if (upscaleMethod === "seedvr2") return false;

  const NONPORTABLE_FLAGS = new Set([
    "--face-detail", "--film-grain", "--sharpening", "--lut",
    "--skin-contrast", "--noise-clean",
  ]);
```

to:

```ts
  const NONPORTABLE_OPTION_KEYS = [
    "filmGrain", "film_grain",
    "sharpening",
    "lut", "lutPath", "lut_path",
    "skinContrast", "skin_contrast",
    "noiseClean", "noise_clean",
  ];
  for (const k of NONPORTABLE_OPTION_KEYS) {
    if (truthy(options[k])) return false;
  }
  const upscaleMethod = options.upscaleMethod ?? options.upscale_method;
  if (upscaleMethod === "seedvr2") return false;

  const NONPORTABLE_FLAGS = new Set([
    "--film-grain", "--sharpening", "--lut",
    "--skin-contrast", "--noise-clean",
  ]);
```

- [ ] **Step 4: Pass `faceDetail` through in `realWorkflow`**

In `bun-apps/pi-agent-ext-movie-director/src/bridge.ts`'s `realWorkflow`, change:

```ts
      denoiseStrength: (options.denoiseStrength as number | undefined) ?? (options.denoise_strength as number | undefined),
      upscale: Boolean(options.upscale),
      upscaleModel: (options.upscaleModel as string | undefined) ?? (options.upscale_model as string | undefined),
      outputDir: req.outputDir,
    });
    return {
      success: true,
      provider: "workflow-native",
      command: "image workflow",
      artifacts: [{ path: result.finalImage, kind: "image", seed: result.seed, width: result.width, height: result.height, role: "primary" }],
      error: null,
      cost_usd: costFor(req.capability, null, env),
      duration_seconds: (Date.now() - started) / 1000,
      seed: result.seed,
      model: "zimage:t2i/i2i" + (result.stages.includes("upscale") ? "+flux2:upscale" : ""),
    };
```

to:

```ts
      denoiseStrength: (options.denoiseStrength as number | undefined) ?? (options.denoise_strength as number | undefined),
      faceDetail: Boolean(options.faceDetail ?? options.face_detail),
      upscale: Boolean(options.upscale),
      upscaleModel: (options.upscaleModel as string | undefined) ?? (options.upscale_model as string | undefined),
      outputDir: req.outputDir,
    });
    return {
      success: true,
      provider: "workflow-native",
      command: "image workflow",
      artifacts: [{ path: result.finalImage, kind: "image", seed: result.seed, width: result.width, height: result.height, role: "primary" }],
      error: null,
      cost_usd: costFor(req.capability, null, env),
      duration_seconds: (Date.now() - started) / 1000,
      seed: result.seed,
      model: "zimage:t2i/i2i"
        + (result.stages.includes("face_detail") ? "+flux2:face-detail" : "")
        + (result.stages.includes("upscale") ? "+flux2:upscale" : ""),
    };
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/bridge.test.ts 2>&1 | tail -60 )`
Expected: PASS — including the updated `isNativeWorkflowRequest` test and the pre-existing post-process/seedvr2 tests (unchanged, still `false`).

- [ ] **Step 6: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/bridge.ts bun-apps/pi-agent-ext-movie-director/src/bridge.test.ts
git commit -m "feat(bridge): route face_detail requests to the native workflow path

isNativeWorkflowRequest no longer treats face_detail as non-portable —
FaceDetector.swift/FaceDetailPipeline.swift now cover it natively.
Only post-process filters and upscale_method=seedvr2 still force the
run.py fallback."
```

---

### Task 7: `registry.ts` — update the stale face-detail note

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/registry.ts`

- [ ] **Step 1: Update the comment block and `notes` field**

In `bun-apps/pi-agent-ext-movie-director/src/registry.ts`, the comment block above the `workflow_hybrid` registry entry currently reads (around lines 195-208):

```ts
  // above uses). Stage 2 (face detailer) needs mediapipe FACE DETECTION (the
  // re-denoise half reuses the same native I2I, but detection has no Swift/
  // Vision-framework port anywhere in this repo — a genuinely NEW primitive,
  // not orchestration). Stage 3 (post-process: film grain/sharpen/LUT/skin
  // contrast) is pure pixel math but needs a decoded RGB buffer this package
  // has no image-codec dependency for, and no Swift filter chain exists
  // either — also NEW work, not orchestration. Stage 4's `seedvr2` method
  // stays confirmed PyTorch/torch-MPS-only (no MLX/Swift port anywhere — see
  // memory project_pytorch_mps_versions/project_attention_backends_mps).
  // So this stays under ONE command name ("workflow") and forks by request
  // shape inside bridge.ts's realWorkflow — the same style-fork controlnet_
  // hybrid (above) and caption.ts use. Native path only fires when NONE of
  // face_detail/film_grain/sharpening/lut/skin_contrast/noise_clean is
  // requested and upscale_method isn't "seedvr2" — see isNativeWorkflowRequest
  // in bridge.ts. Everything else still reaches run.py's image-workflow.py
  // via realRunPyImage exactly as before.
```

Replace with:

```ts
  // above uses). Stage 2 (face detailer) is now native too (2026-08-02):
  // FaceDetector.swift (Apple Vision VNDetectFaceRectanglesRequest) replaces
  // mediapipe's TFLite detector, and FaceDetailPipeline.swift replicates the
  // crop/regenerate/composite loop via the existing Flux2EditPipeline/
  // Flux2Composite primitives — exposed as `flux2 face-detail`. Stage 3
  // (post-process: film grain/sharpen/LUT/skin contrast) is pure pixel math
  // but needs a decoded RGB buffer this package has no image-codec
  // dependency for, and no Swift filter chain exists either — still NEW
  // work, not orchestration, still out of scope. Stage 4's `seedvr2` method
  // stays confirmed PyTorch/torch-MPS-only (no MLX/Swift port anywhere — see
  // memory project_pytorch_mps_versions/project_attention_backends_mps).
  // So this stays under ONE command name ("workflow") and forks by request
  // shape inside bridge.ts's realWorkflow — the same style-fork controlnet_
  // hybrid (above) and caption.ts use. Native path only fires when NONE of
  // film_grain/sharpening/lut/skin_contrast/noise_clean is requested and
  // upscale_method isn't "seedvr2" — see isNativeWorkflowRequest in
  // bridge.ts. Everything else still reaches run.py's image-workflow.py via
  // realRunPyImage exactly as before.
```

And change the entry's `notes` field from:

```ts
    notes: "Style-forked (caption.ts/controlnet_hybrid pattern) workflow dispatch (src/bridge.ts realWorkflow). Native path: src/workflow_native.ts orchestrating krea2 t2i/i2i (base gen) optionally chained with flux2 upscale (ESRGAN/RealPLKSR) — fires only when no face-detail/post-process knob is requested and upscale_method isn't seedvr2. Fallback path: run.py's image-workflow.py (full 4-stage pipeline incl. mediapipe face-detailer, numpy/PIL/cv2 post-process chain, SeedVR2) — fires for everything else, unchanged from before this migration. See isNativeWorkflowRequest for the exact split and workflow_native.ts's module doc for the full per-stage portability investigation.",
```

to:

```ts
    notes: "Style-forked (caption.ts/controlnet_hybrid pattern) workflow dispatch (src/bridge.ts realWorkflow). Native path: src/workflow_native.ts orchestrating krea2 t2i/i2i (base gen) optionally chained with flux2 face-detail (Apple Vision detect + SDEdit regen) and/or flux2 upscale (ESRGAN/RealPLKSR) — fires only when no post-process knob is requested and upscale_method isn't seedvr2. Fallback path: run.py's image-workflow.py (full 4-stage pipeline incl. numpy/PIL/cv2 post-process chain, SeedVR2) — fires for everything else, unchanged from before this migration. See isNativeWorkflowRequest for the exact split and workflow_native.ts's module doc for the full per-stage portability investigation.",
```

- [ ] **Step 2: Run the full package test suite (this is a comment-only change, but confirm no regressions)**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test 2>&1 | tail -30 )`
Expected: all pass, unchanged from before this task.

- [ ] **Step 3: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/registry.ts
git commit -m "docs(registry): update workflow_hybrid's stale face-detail note

Face-detail moved from NOT PORTABLE to native (Tasks 1-6, this branch)
— the registry comment and notes field still described the old split."
```

---

### Final verification (do this after all 7 tasks, before finishing the branch)

Run the full test matrix across every touched package:

```bash
( cd swift/flux2-image-director && swift test 2>&1 | tail -60 )
( cd bun-apps/pi-agent-ext-flux2 && bun test 2>&1 | tail -30 )
( cd bun-apps/pi-agent-ext-movie-director && bun test 2>&1 | tail -60 )
```

Expected: all green. Report the actual pass/skip counts (especially whether the real E2E `FaceDetailPipelineTests` test ran or skipped, and why) rather than assuming.
