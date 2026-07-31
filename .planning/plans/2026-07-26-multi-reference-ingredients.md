# Multi-Reference Ingredients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Swift `ltx-video native-ingredients` to accept multiple reference images instead of exactly one, using the existing (append-based, non-colliding) `VideoConditionByReferenceLatent` mechanism, then empirically verify whether it produces real multi-reference compositing.

**Architecture:** `NativeUpscaleStage.generateIngredients` changes from a single `referenceImageURL: URL` parameter to `referenceImageURLs: [URL]`; each image is independently tiled/VAE-encoded/patchified (reusing one loaded `VideoEncoder`), and the resulting per-image reference-token/position tensors are concatenated along the token axis before a single `VideoConditionByReferenceLatent` call — everything downstream (LoRA fusion, denoise, decode) is untouched. `NativeIngredientsCommand`'s `--input` becomes repeatable. A final manual task runs a real 2-reference generation and records an honest pass/fail/inconclusive verdict in `docs/openmontage-capability-matrix.md`.

**Tech Stack:** Swift, `swift-argument-parser`, MLX (mlx-swift), XCTest.

**Full design doc:** `docs/superpowers/specs/2026-07-26-multi-reference-ingredients-design.md`

---

### Task 1: `NativeUpscaleStage.generateIngredients` accepts multiple reference images

**Files:**
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirector/NativeUpscaleStage.swift`
- Test: `swift/ltx-video-director/Tests/LTXVideoDirectorTests/NativeUpscaleStageRealCheckpointTests.swift`

- [ ] **Step 1: Write the failing tests**

Replace the two existing ingredients tests (currently at lines 357-405) with these four, in `swift/ltx-video-director/Tests/LTXVideoDirectorTests/NativeUpscaleStageRealCheckpointTests.swift`. They call the new `referenceImageURLs: [URL]` signature, which doesn't exist yet — this file will fail to compile until Task 1 Step 3 lands (that compile failure IS the RED state for this statically-typed change).

```swift
    func testGenerateIngredientsMissingLoraThrowsNamedError() throws {
        let referenceImageDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_ingredients_ref_\(UUID().uuidString)")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_ingredients_out_\(UUID().uuidString)")
        let missingLoraURL = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).safetensors")
        try FileManager.default.createDirectory(at: referenceImageDir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: referenceImageDir)
            try? FileManager.default.removeItem(at: outputDir)
        }
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 1, 64, 64], key: MLXRandom.key(17)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: referenceImageDir)
        let referenceImageURL = referenceImageDir.appendingPathComponent("frame_0000.png")

        XCTAssertThrowsError(try NativeUpscaleStage().generateIngredients(
            referenceImageURLs: [referenceImageURL], outputDir: outputDir, prompt: "a test prompt",
            loraURL: missingLoraURL, width: 64, height: 64)
        ) { error in
            guard let stageError = error as? NativeUpscaleStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .ingredientsLoraNotFound(let url) = stageError {
                XCTAssertEqual(url, missingLoraURL)
            } else {
                XCTFail("expected .ingredientsLoraNotFound, got \(stageError)")
            }
        }
    }

    func testGenerateIngredientsMissingReferenceImageThrowsNamedError() throws {
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_ingredients_out_\(UUID().uuidString)")
        let missingReferenceURL = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).png")
        let missingLoraURL = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).safetensors")
        defer { try? FileManager.default.removeItem(at: outputDir) }

        XCTAssertThrowsError(try NativeUpscaleStage().generateIngredients(
            referenceImageURLs: [missingReferenceURL], outputDir: outputDir, prompt: "a test prompt",
            loraURL: missingLoraURL, width: 64, height: 64)
        ) { error in
            guard let stageError = error as? NativeUpscaleStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .referenceImageNotFound(let url) = stageError {
                XCTAssertEqual(url, missingReferenceURL)
            } else {
                XCTFail("expected .referenceImageNotFound, got \(stageError)")
            }
        }
    }

    func testGenerateIngredientsEmptyReferenceListThrowsNamedError() throws {
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_ingredients_out_\(UUID().uuidString)")
        let loraURL = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).safetensors")
        defer { try? FileManager.default.removeItem(at: outputDir) }

        XCTAssertThrowsError(try NativeUpscaleStage().generateIngredients(
            referenceImageURLs: [], outputDir: outputDir, prompt: "a test prompt",
            loraURL: loraURL, width: 64, height: 64)
        ) { error in
            guard let stageError = error as? NativeUpscaleStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .noReferenceImages = stageError {
                // expected
            } else {
                XCTFail("expected .noReferenceImages, got \(stageError)")
            }
        }
    }

    func testGenerateIngredientsMultiReferenceIdentifiesSpecificMissingImage() throws {
        let referenceImageDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_ingredients_ref_\(UUID().uuidString)")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_ingredients_out_\(UUID().uuidString)")
        let missingLoraURL = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).safetensors")
        try FileManager.default.createDirectory(at: referenceImageDir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: referenceImageDir)
            try? FileManager.default.removeItem(at: outputDir)
        }
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 1, 64, 64], key: MLXRandom.key(19)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: referenceImageDir)
        let firstReferenceURL = referenceImageDir.appendingPathComponent("frame_0000.png")
        let secondReferenceURL = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).png")

        // First image exists, second doesn't — confirms per-image checking in a
        // multi-image list identifies the SPECIFIC bad path, not just "some" image.
        XCTAssertThrowsError(try NativeUpscaleStage().generateIngredients(
            referenceImageURLs: [firstReferenceURL, secondReferenceURL], outputDir: outputDir, prompt: "a test prompt",
            loraURL: missingLoraURL, width: 64, height: 64)
        ) { error in
            guard let stageError = error as? NativeUpscaleStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .referenceImageNotFound(let url) = stageError {
                XCTAssertEqual(url, secondReferenceURL)
            } else {
                XCTFail("expected .referenceImageNotFound(secondReferenceURL), got \(stageError)")
            }
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd swift/ltx-video-director && swift test --filter NativeUpscaleStageRealCheckpointTests 2>&1 | tail -40 )`
Expected: compile error — `generateIngredients(referenceImageURLs:...)` has no matching overload (current signature is `referenceImageURL: URL`, singular), and `.noReferenceImages` is not a member of `StageError`.

- [ ] **Step 3: Add the `noReferenceImages` error case**

In `swift/ltx-video-director/Sources/LTXVideoDirector/NativeUpscaleStage.swift`, in `StageError` (currently lines 44-78):

```swift
        case referenceImageNotFound(URL)
        case ingredientsLoraNotFound(URL)
        case noReferenceImages
        case invalidDimensions(String)
```

(insert `case noReferenceImages` right after the existing `case ingredientsLoraNotFound(URL)` on line 57)

And in the `description` switch, right after the existing `.ingredientsLoraNotFound` case (line 74):

```swift
            case .noReferenceImages: return "NativeUpscaleStage: generateIngredients requires at least one reference image"
```

- [ ] **Step 4: Change `generateIngredients` to accept and fold multiple reference images**

Replace the full body of `generateIngredients` (currently `swift/ltx-video-director/Sources/LTXVideoDirector/NativeUpscaleStage.swift:693-763`, from the `public func generateIngredients(` signature through the `videoState = VideoConditionByReferenceLatent(...).apply(to: baseVideoState)` line) with:

```swift
    public func generateIngredients(
        referenceImageURLs: [URL], outputDir: URL, prompt: String,
        loraURL: URL, width: Int, height: Int, seconds: Double = 5.0,
        fps: Double = 24.0, textMaxLength: Int = 128, seed: UInt64 = 42,
        loraStrength: Float = 1.0
    ) throws -> IngredientsResult {
        let fm = FileManager.default
        guard !referenceImageURLs.isEmpty else {
            throw StageError.noReferenceImages
        }
        for referenceImageURL in referenceImageURLs {
            guard fm.fileExists(atPath: referenceImageURL.path) else {
                throw StageError.referenceImageNotFound(referenceImageURL)
            }
        }
        guard fm.fileExists(atPath: loraURL.path) else {
            throw StageError.ingredientsLoraNotFound(loraURL)
        }
        guard width > 0, height > 0 else {
            throw StageError.invalidDimensions("width/height must be positive, got \(width)x\(height)")
        }
        let optimized = ResolutionResolver.optimize(width: width, height: height)
        let outW = optimized.width, outH = optimized.height

        // LTX frame counts must be 8k+1 (mirrors NativeI2VStage.Request.frames).
        let raw = seconds * fps
        let kFloor = max(1, Int(floor((raw - 1) / 8.0)))
        let kCeil = kFloor + 1
        let fFloor = 8 * kFloor + 1
        let fCeil = 8 * kCeil + 1
        let frames = abs(Double(fFloor) - raw) <= abs(Double(fCeil) - raw) ? fFloor : fCeil

        print("[1/6] Loading \(referenceImageURLs.count) reference image(s), tiling to \(frames) frames at \(outW)x\(outH)...")
        print("[2/6] VideoEncoder: encoding tiled reference image(s) to latent (IC-LoRA conditioning)...")
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        guard fm.fileExists(atPath: vaeEncoderURL.path) else {
            throw StageError.videoEncoderCheckpointNotFound(vaeEncoderURL)
        }
        let encRaw = try MLX.loadArrays(url: vaeEncoderURL)
        var encWeights: [String: MLXArray] = [:]
        for (key, value) in encRaw {
            let stripped = key.hasPrefix("vae_encoder.") ? String(key.dropFirst("vae_encoder.".count)) : key
            encWeights[stripped] = value.asType(.float32)
        }
        // Loaded once, reused for every reference image below — avoids
        // re-reading the same checkpoint off disk N times.
        let videoEncoder = VideoEncoder(weights: encWeights)

        // Each reference image is independently tiled to `frames` copies and
        // VAE-encoded/patchified; all N share identical (f, h, w) dims since
        // every image is resized to the same outW x outH and tiled to the
        // same frame count. The resulting per-image token blocks are
        // concatenated into one combined reference-token sequence that
        // VideoConditionByReferenceLatent APPENDS to the generation's own
        // tokens (self-attention, not position-collision — see this
        // function's header / docs/superpowers/specs/
        // 2026-07-26-multi-reference-ingredients-design.md).
        var referenceTokenChunks: [MLXArray] = []
        var dims: (f: Int, h: Int, w: Int) = (0, 0, 0)
        for referenceImageURL in referenceImageURLs {
            guard var cgImage = FrameLoad.loadCGImage(from: referenceImageURL) else {
                throw StageError.referenceImageNotFound(referenceImageURL)
            }
            if cgImage.width != outW || cgImage.height != outH {
                cgImage = FrameLoad.resizeAspectFillCenterCrop(cgImage, targetWidth: outW, targetHeight: outH)
            }
            let framePixels01 = FrameLoad.toArray(cgImage)  // (1, 3, H, W) [0, 1]
            let singleFrame = (framePixels01.asType(.float32) * 2.0 - 1.0)[0]  // (3, H, W)
            let stacked = MLX.stacked(Array(repeating: singleFrame, count: frames), axis: 1)  // (3, F, H, W)
            let pixelsBCFHW = stacked.expandedDimensions(axis: 0)  // (1, 3, F, H, W)

            let referenceLatentRaw = videoEncoder(pixelsBCFHW)  // (1, 128, Fr, Hr, Wr), normalized
            MLX.eval(referenceLatentRaw)
            let (tokens, imageDims) = VideoLatentPatchifier.patchify(referenceLatentRaw)
            dims = imageDims
            referenceTokenChunks.append(tokens)
        }
        let referenceTokens = referenceTokenChunks.count == 1
            ? referenceTokenChunks[0]
            : MLX.concatenated(referenceTokenChunks, axis: 1)
        let positions = Positions.computeVideoPositions(numFrames: dims.f, height: dims.h, width: dims.w, frameRate: Float(fps))
        // Every reference's positions are value-identical to `positions`
        // (same formula, same dims) — repeat rather than recompute per image.
        let referencePositions = referenceTokenChunks.count == 1
            ? positions
            : MLX.concatenated(Array(repeating: positions, count: referenceTokenChunks.count), axis: 1)
        let genTokenCount = dims.f * dims.h * dims.w

        print("[3/6] LoRA: loading + fusing Ingredients IC-LoRA into distilled transformer...")
        let loraSources: [(weights: LoRAWeights, strength: Float)] = [
            (weights: try LoRAWeights.load(url: loraURL), strength: loraStrength),
        ]

        print("[4/6] denoise: LoRA-fused 48-block distilled transformer, IC-LoRA reference conditioning...")
        let noise = MLXRandom.normal([1, genTokenCount, 128], key: MLXRandom.key(seed))
        let baseVideoState = LatentState(
            latent: noise, cleanLatent: MLXArray.zeros([1, genTokenCount, 128]),
            denoiseMask: MLXArray.ones([1, genTokenCount, 1]), positions: positions)
        let videoState = VideoConditionByReferenceLatent(
            referenceLatent: referenceTokens, referencePositions: referencePositions,
            downscaleFactor: 1, strength: 1.0
        ).apply(to: baseVideoState)
```

Leave everything from `// Audio generated from scratch...` (the line right after) through the end of the function (the closing `return IngredientsResult(...)` and final `}`) exactly as it is today — no further changes needed there.

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd swift/ltx-video-director && swift build 2>&1 | tail -40 )`
Expected: builds cleanly (0 errors).

Run: `( cd swift/ltx-video-director && swift test --filter NativeUpscaleStageRealCheckpointTests 2>&1 | tail -60 )`
Expected: `testGenerateIngredientsMissingLoraThrowsNamedError`, `testGenerateIngredientsMissingReferenceImageThrowsNamedError`, `testGenerateIngredientsEmptyReferenceListThrowsNamedError`, `testGenerateIngredientsMultiReferenceIdentifiesSpecificMissingImage` all PASS. `testGenerateProducesDoubledResolutionFrames` (the unrelated `generate`/upscale test earlier in the same file) still passes or skips exactly as it did before this change (it doesn't call `generateIngredients`).

- [ ] **Step 6: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirector/NativeUpscaleStage.swift swift/ltx-video-director/Tests/LTXVideoDirectorTests/NativeUpscaleStageRealCheckpointTests.swift
git commit -m "feat(ltx-video-director): accept multiple reference images in generateIngredients"
```

---

### Task 2: `native-ingredients` CLI accepts repeatable `--input`

**Files:**
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirectorCLI/NativeIngredientsCommand.swift`

- [ ] **Step 1: Change the CLI option and call site**

In `swift/ltx-video-director/Sources/LTXVideoDirectorCLI/NativeIngredientsCommand.swift`, replace:

```swift
    @Option(name: .shortAndLong, help: "Reference image (e.g. a character/product/scene reference sheet).")
    var input: String
```

with:

```swift
    @Option(name: .customLong("input"), parsing: .upToNextOption,
            help: "Reference image(s) (e.g. a character/product/scene reference sheet). Repeatable — pass multiple --input flags (or multiple paths after one --input) to condition on more than one reference simultaneously. Experimental multi-reference compositing: see docs/openmontage-capability-matrix.md and docs/superpowers/specs/2026-07-26-multi-reference-ingredients-design.md.")
    var input: [String] = []
```

(this drops the `-i` short alias `.shortAndLong` gave — matches this file's convention for every other repeatable option, e.g. `--lora`/`--anchor-image` in `NativeI2VCommand.swift:78,124`, none of which use `.shortAndLong`)

Then in `run()`, replace:

```swift
        print("→ native ingredients (no run.py): reference=\(input) [lora=\(lora)]")
        let result = try stage.generateIngredients(
            referenceImageURL: URL(fileURLWithPath: input),
            outputDir: URL(fileURLWithPath: output),
            prompt: prompt, loraURL: URL(fileURLWithPath: lora),
            width: width, height: height, seconds: seconds,
            fps: fps, seed: seed, loraStrength: loraStrength)
```

with:

```swift
        print("→ native ingredients (no run.py): reference=\(input) [lora=\(lora)]")
        let result = try stage.generateIngredients(
            referenceImageURLs: input.map { URL(fileURLWithPath: $0) },
            outputDir: URL(fileURLWithPath: output),
            prompt: prompt, loraURL: URL(fileURLWithPath: lora),
            width: width, height: height, seconds: seconds,
            fps: fps, seed: seed, loraStrength: loraStrength)
```

- [ ] **Step 2: Build and smoke-check the CLI**

Run: `( cd swift/ltx-video-director && swift build 2>&1 | tail -40 )`
Expected: builds cleanly (0 errors) — this is the change's real verification, since this package has no dedicated CLI-argument-parsing test target (Task 1's XCTest coverage already exercises the underlying `generateIngredients` logic this command calls).

Run: `( cd swift/ltx-video-director && swift run ltx-video native-ingredients --help 2>&1 | tail -20 )`
Expected: help text shows `--input <input> ...` (repeatable) rather than a single required `--input <input>`.

- [ ] **Step 3: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirectorCLI/NativeIngredientsCommand.swift
git commit -m "feat(ltx-video-director): native-ingredients --input becomes repeatable"
```

---

### Task 3: Empirical verification — does multi-reference actually composite?

This task is evidence-gathering, not a pass/fail unit test, and requires real checkpoints present locally (Ingredients IC-LoRA + the standard VAE/transformer checkpoints `generateIngredients` already required before this change). If any required checkpoint is missing, skip this task and note in the final report which checkpoint was missing — do not fabricate a result.

**Files:**
- Modify: `docs/openmontage-capability-matrix.md`

- [ ] **Step 1: Prepare two maximally-distinct reference images**

Reuse the same technique the capability matrix's own prior negative tests used (see its `reference_to_video` row, "Same-frame-0 multi-anchor compositing tested 2026-07-10" and "Reference-sheet compositing tested 2026-07-10" paragraphs): one close-up portrait (identity anchor) and one image with a clearly different subject and no faces (e.g. a distinct object or landscape, style/setting anchor). Reuse any existing test portrait already on disk under this repo's test fixtures or `mlx-models/`-adjacent sample assets if one exists; otherwise generate one via the already-working `python/venv/bin/python python/mlx-movie-director/run.py image t2i` or an existing Z-Image self-test output.

- [ ] **Step 2: Run a real 2-reference generation**

Run (from repo root):

```bash
( cd swift/ltx-video-director && swift run -c release ltx-video native-ingredients \
    --input /path/to/portrait.png --input /path/to/distinct_object.png \
    --prompt "the person from the reference sits beside the object from the reference, cinematic wide shot, sunlit room" \
    --lora /path/to/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors \
    --width 512 --height 512 --seconds 2.0 \
    --output /tmp/native_ingredients_multiref_test )
```

Expected: a real mp4 + PNG frame sequence + audio.wav at `/tmp/native_ingredients_multiref_test`, same shape of output `generateIngredients` already produced pre-change (this run just confirms the multi-reference code path executes to completion on real checkpoints, not a stub).

- [ ] **Step 3: Judge the output and record the verdict**

Extract 2-3 frames from the output (e.g. via `ffmpeg -i /tmp/native_ingredients_multiref_test/video.mp4 -vf "select=eq(n\,0)+eq(n\,24)+eq(n\,48)" -vsync 0 /tmp/frame_%d.png`) and caption them (e.g. `python/venv/bin/python python/mlx-movie-director/run.py caption /tmp/frame_1.png --style default`, the same VLM-captioning method the capability matrix already uses throughout). Compare against both reference images: does the output show identifiable traces of **both** (e.g. a person resembling the portrait AND the distinct object/setting), one dominating/replacing the other (matching the existing negative composited-sheet result), or neither (garbage/collapse)?

Add a new dated subsection to `docs/openmontage-capability-matrix.md`, directly under the existing `reference_to_video` row's "Reference-sheet compositing tested 2026-07-10" paragraph, in the same evidence-first style as the surrounding text (cite the exact command run, the exact frames inspected, and the caption output) — for example:

```markdown
**Multi-reference append (N separate images via VideoConditionByReferenceLatent) tested 2026-07-26:**
[record here: exact verdict — positive/negative/inconclusive — with the
specific evidence (caption text, what was/wasn't visible in the frames)
that supports it, same format as the two prior negative results in this
row.]
```

- [ ] **Step 4: Commit the finding**

```bash
git add docs/openmontage-capability-matrix.md
git commit -m "docs: record multi-reference native-ingredients empirical result"
```

**Do not proceed to wiring this into `pi-agent-ext-ltx`/the movie-director pipeline (design doc's Phase 2) unless Step 3's verdict is a clear positive** (real, visible compositing of both references — not just "didn't crash"). If negative or inconclusive, this plan is complete as-is; Phase 2 stays unstarted future work, same disposition as the composited-sheet result before it.

---

## Self-Review Notes

- **Spec coverage:** Phase 1 (engine extension: `generateIngredients` signature + CLI) is Tasks 1-2. The empirical test + capability-matrix write-up is Task 3. Phase 2 (pipeline/schema wiring) is explicitly NOT a task here — the design doc gates it on Task 3's result, which can't be known until Task 3 actually runs; wiring a CLI schema field for a capability that might get a negative verdict would violate YAGNI.
- **Type consistency:** `referenceImageURLs: [URL]` (stage) / `input: [String]` (CLI) used consistently across Tasks 1-2; `StageError.noReferenceImages` and `StageError.referenceImageNotFound(URL)` names match between the implementation step and every test step.
- **No placeholders:** every step above shows the actual code to write or the actual command to run; Task 3 is deliberately evidence-gathering (its own nature per the design doc), not a scripted assertion — its "step" is still a concrete command + concrete recording instruction, not a vague "verify it works."
