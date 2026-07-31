# Camera-control-LoRA / native-relay integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Cseti's Cameraman v2 IC-LoRA into `native-relay`'s per-segment chain (the real movie-director production path) for two movement types — `dolly_in` and `tilt_up` — end to end: scene_plan's existing `shot_language.camera_movement` → TS dispatch → new Swift CLI flags → real per-segment IC-LoRA conditioning inside `native-relay`, with all other segments byte-identical to today.

**Architecture:** A new `SyntheticCameraReference.swift` synthesizes a per-segment reference frame sequence natively (CoreGraphics affine crop/scale, no ffmpeg) from that segment's own start frame. A new `NativeUpscaleStage.generateCameraControl` method reuses `generateRestyle`'s IC-LoRA reference-conditioning recipe for video but generates fresh audio (unlike `generateRestyle`, which preserves existing audio). `NativeRelayStage`'s existing per-segment loop branches to this new path only for segments whose `cameraMovements[i]` is `dolly_in`/`tilt_up` and which have a real start image available; every other segment is untouched. TS wiring threads `scene_plan.shot_language.camera_movement` from `assets-encoder.ts` through `driver-wiring.ts`'s single `native-relay` dispatch call into `pi-agent-ext-ltx`'s new `--camera-movements`/`--camera-lora` CLI fields.

**Tech Stack:** Swift/MLX (`swift/ltx-video-director`), TypeScript/Bun (`bun-apps/pi-agent-ext-ltx`, `bun-apps/pi-agent-ext-movie-director`), one Python one-time model-import command (repo-setup tooling, not a runtime path).

**Spec:** `docs/superpowers/specs/2026-07-27-camera-control-lora-relay-design.md`

---

### Task 1: `SyntheticCameraReference.swift` — native reference-clip synthesizer

**Files:**
- Create: `swift/ltx-video-director/Sources/LTXVideoDirector/SyntheticCameraReference.swift`
- Test: `swift/ltx-video-director/Tests/LTXVideoDirectorTests/SyntheticCameraReferenceTests.swift`

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
import CoreGraphics
@testable import LTXVideoDirector

/// Fast, no-checkpoint contract tests for the synthetic reference-clip
/// generator — verifies frame count and the direction of the crop-window/
/// scale trajectory, not visual quality (that's the manual real-generation
/// verification in Task 8).
final class SyntheticCameraReferenceTests: XCTestCase {
    /// A 64x64 solid-color CGImage — content doesn't matter, only geometry.
    private func makeTestImage(width: Int = 64, height: Int = 64) -> CGImage {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        let ctx = CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo)!
        ctx.setFillColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage()!
    }

    func testSynthesizeReturnsExactlyRequestedFrameCount() {
        let img = makeTestImage()
        let frames = SyntheticCameraReference.synthesize(
            startImage: img, movement: .dollyIn, frameCount: 25, targetWidth: 64, targetHeight: 64)
        XCTAssertEqual(frames.count, 25)
        for frame in frames {
            XCTAssertEqual(frame.width, 64)
            XCTAssertEqual(frame.height, 64)
        }
    }

    func testSynthesizeSingleFrameReturnsOneFrame() {
        let img = makeTestImage()
        let frames = SyntheticCameraReference.synthesize(
            startImage: img, movement: .tiltUp, frameCount: 1, targetWidth: 64, targetHeight: 64)
        XCTAssertEqual(frames.count, 1)
    }

    /// dolly_in: the drawn image rect must strictly grow (relative to the
    /// target canvas) from frame 0 to the last frame — a zoom-in.
    func testDollyInScaleGrowsMonotonically() {
        let img = makeTestImage()
        let scales = (0..<9).map { SyntheticCameraReference.transformParametersForTesting(movement: .dollyIn, t: Double($0) / 8.0).scale }
        for i in 1..<scales.count {
            XCTAssertGreaterThan(scales[i], scales[i - 1], "scale must strictly increase frame over frame for dolly_in")
        }
        XCTAssertEqual(scales.first, 1.0, accuracy: 1e-9)
    }

    /// tilt_up: the crop-window's vertical offset fraction must move from the
    /// bottom of the frame (1.0) toward the top (0.0) as t increases.
    func testTiltUpOffsetMovesFromBottomToTop() {
        let first = SyntheticCameraReference.transformParametersForTesting(movement: .tiltUp, t: 0.0)
        let last = SyntheticCameraReference.transformParametersForTesting(movement: .tiltUp, t: 1.0)
        XCTAssertEqual(first.offsetYFraction, 1.0, accuracy: 1e-9)
        XCTAssertEqual(last.offsetYFraction, 0.0, accuracy: 1e-9)
    }

    func testIsSupportedRecognizesOnlyV1Movements() {
        XCTAssertTrue(SyntheticCameraReference.isSupported("dolly_in"))
        XCTAssertTrue(SyntheticCameraReference.isSupported("tilt_up"))
        XCTAssertFalse(SyntheticCameraReference.isSupported("pan_right"))
        XCTAssertFalse(SyntheticCameraReference.isSupported("orbital"))
        XCTAssertFalse(SyntheticCameraReference.isSupported("none"))
        XCTAssertFalse(SyntheticCameraReference.isSupported(""))
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd swift/ltx-video-director && swift test --filter SyntheticCameraReferenceTests )`
Expected: FAIL to build — `SyntheticCameraReference`/`CameraMovementType` don't exist yet.

- [ ] **Step 3: Write the implementation**

```swift
//
//  SyntheticCameraReference.swift
//  LTXVideoDirector
//
//  Synthesizes a per-segment reference frame sequence for camera-control-LoRA
//  conditioning natively (CoreGraphics affine crop/scale — no ffmpeg), from a
//  single starting frame. Ported from the ffmpeg zoompan/crop technique used
//  in the PR #890/#896 measurement spikes (see
//  docs/superpowers/specs/2026-07-27-camera-control-lora-relay-design.md).
//
//  v1 supports exactly two movements — the two that measured cleanly in both
//  the Python spike (PR #890) and the isolated Swift native-restyle spike
//  (PR #896): dolly_in and tilt_up. Every other shot_language.camera_movement
//  value is a no-op at the call site (NativeRelayStage falls back to plain
//  generation) — see isSupported().
//

import CoreGraphics

public enum CameraMovementType: String {
    case dollyIn = "dolly_in"
    case tiltUp = "tilt_up"
}

public enum SyntheticCameraReference {
    /// True for exactly the v1-supported movement strings (scene_plan's raw
    /// shot_language.camera_movement values, e.g. "dolly_in"). Callers should
    /// treat every other value (including "none", "", and the other 16
    /// CAMERA_MOVEMENTS entries) as "no camera-control conditioning."
    public static func isSupported(_ rawMovement: String) -> Bool {
        CameraMovementType(rawValue: rawMovement) != nil
    }

    /// Synthesize `frameCount` frames depicting `movement` applied to
    /// `startImage`, each exactly `targetWidth` x `targetHeight`. Frame 0 is
    /// the unmodified start image (aspect-fill-center-cropped to target
    /// size); the last frame is the movement's maximum extent. `frameCount`
    /// must equal the segment's own LTX frame count (8k+1) — the IC-LoRA
    /// reference-conditioning path derives the generation's output length
    /// directly from the reference clip's own frame count (see
    /// NativeUpscaleStage.generateCameraControl's header).
    public static func synthesize(
        startImage: CGImage, movement: CameraMovementType,
        frameCount: Int, targetWidth: Int, targetHeight: Int
    ) -> [CGImage] {
        let base = FrameLoad.resizeAspectFillCenterCrop(startImage, targetWidth: targetWidth, targetHeight: targetHeight)
        guard frameCount > 1 else { return [base] }
        return (0..<frameCount).map { i in
            let t = Double(i) / Double(frameCount - 1)
            return renderFrame(base, movement: movement, t: t, targetWidth: targetWidth, targetHeight: targetHeight)
        }
    }

    /// Exposed for tests only — the (scale, offsetXFraction, offsetYFraction)
    /// trajectory at progress `t` in [0, 1]. offsetXFraction/offsetYFraction
    /// of 0.5 = a centered crop window; 0.0/1.0 = the crop window pinned to
    /// the start/end edge of the scaled source.
    static func transformParametersForTesting(movement: CameraMovementType, t: Double) -> (scale: Double, offsetXFraction: Double, offsetYFraction: Double) {
        transformParameters(movement: movement, t: t)
    }

    private static func transformParameters(movement: CameraMovementType, t: Double) -> (scale: Double, offsetXFraction: Double, offsetYFraction: Double) {
        switch movement {
        case .dollyIn:
            // Progressive zoom-in: 1.0x -> 1.25x scale, crop window stays centered.
            return (scale: 1.0 + 0.25 * t, offsetXFraction: 0.5, offsetYFraction: 0.5)
        case .tiltUp:
            // Fixed 1.2x scale (headroom for the crop window to slide within),
            // crop window slides from the bottom of the frame toward the top.
            return (scale: 1.2, offsetXFraction: 0.5, offsetYFraction: 1.0 - t)
        }
    }

    /// Same CGContext draw-into-an-offset-rect technique as
    /// FrameLoad.resizeAspectFillCenterCrop, parameterized by `t`.
    private static func renderFrame(_ base: CGImage, movement: CameraMovementType, t: Double, targetWidth: Int, targetHeight: Int) -> CGImage {
        let (scale, offsetXFraction, offsetYFraction) = transformParameters(movement: movement, t: t)
        let dstW = Double(targetWidth), dstH = Double(targetHeight)
        let scaledW = dstW * scale, scaledH = dstH * scale
        let originX = (scaledW - dstW) * offsetXFraction
        let originY = (scaledH - dstH) * offsetYFraction

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        guard let ctx = CGContext(
            data: nil, width: targetWidth, height: targetHeight, bitsPerComponent: 8,
            bytesPerRow: targetWidth * 4, space: colorSpace, bitmapInfo: bitmapInfo
        ) else { return base }
        ctx.interpolationQuality = .high
        ctx.draw(base, in: CGRect(x: -originX, y: -originY, width: scaledW, height: scaledH))
        return ctx.makeImage() ?? base
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/ltx-video-director && swift test --filter SyntheticCameraReferenceTests )`
Expected: PASS, 5/5 tests.

- [ ] **Step 5: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirector/SyntheticCameraReference.swift swift/ltx-video-director/Tests/LTXVideoDirectorTests/SyntheticCameraReferenceTests.swift
git commit -m "feat(ltx-video-director): add SyntheticCameraReference (native dolly_in/tilt_up synthesis)"
```

---

### Task 2: `NativeUpscaleStage.generateCameraControl` — IC-LoRA conditioning + fresh audio

**Files:**
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirector/NativeUpscaleStage.swift`
- Test: `swift/ltx-video-director/Tests/LTXVideoDirectorTests/NativeUpscaleStageRealCheckpointTests.swift`

- [ ] **Step 1: Write the failing test**

Add to `NativeUpscaleStageRealCheckpointTests.swift` (mirrors `testGenerateRestyleMissingLoraThrowsNamedError`, fail-fast only — no real checkpoint needed):

```swift
    func testGenerateCameraControlMissingLoraThrowsNamedError() throws {
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_camera_control_out_\(UUID().uuidString)")
        let missingLoraURL = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).safetensors")
        defer { try? FileManager.default.removeItem(at: outputDir) }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        let ctx = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 64 * 4, space: colorSpace, bitmapInfo: bitmapInfo)!
        ctx.setFillColor(red: 0.5, green: 0.5, blue: 0.5, alpha: 1.0)
        ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        let referenceFrames = [CGImage](repeating: ctx.makeImage()!, count: 9)

        XCTAssertThrowsError(try NativeUpscaleStage().generateCameraControl(
            referenceFrames: referenceFrames, outputDir: outputDir, prompt: "a test prompt",
            loraURL: missingLoraURL)
        ) { error in
            guard let stageError = error as? NativeUpscaleStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .cameraLoraNotFound(let url) = stageError {
                XCTAssertEqual(url, missingLoraURL)
            } else {
                XCTFail("expected .cameraLoraNotFound, got \(stageError)")
            }
        }
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd swift/ltx-video-director && swift test --filter testGenerateCameraControlMissingLoraThrowsNamedError )`
Expected: FAIL to build — `generateCameraControl`/`.cameraLoraNotFound` don't exist yet.

- [ ] **Step 3: Add the `cameraLoraNotFound` StageError case**

In `NativeUpscaleStage.swift`, in `StageError`'s case list (after `case lipdubLoraNotFound(URL)` at line 62):

```swift
        case lipdubLoraNotFound(URL)
        case cameraLoraNotFound(URL)
```

And in `description`'s switch (after the `.lipdubLoraNotFound` case):

```swift
            case .lipdubLoraNotFound(let url): return "NativeUpscaleStage: LipDub IC-LoRA not found at \(url.path) — download Lightricks/LTX-2.3-22b-IC-LoRA-LipDub from HuggingFace (HF-gated) and pass its path via --lora"
            case .cameraLoraNotFound(let url): return "NativeUpscaleStage: camera-control IC-LoRA not found at \(url.path) — import Cameraman v2 into mlx-models/lora/camera-control-cameraman-v2/ (see docs/superpowers/specs/2026-07-27-camera-control-lora-relay-design.md)"
```

- [ ] **Step 4: Write `generateCameraControl`**

Add after `generateRestyle` (after the closing brace at line 672, before the `generateIngredients` doc comment):

```swift
    /// `native-relay`'s per-segment camera-control-LoRA path (v1: dolly_in/
    /// tilt_up only — see SyntheticCameraReference.swift for how the
    /// reference frames are built). Mirrors `generateRestyle`'s IC-LoRA
    /// reference-conditioning recipe for VIDEO (VAE-encode reference frames
    /// -> fuse IC-LoRA -> denoise with VideoConditionByReferenceLatent) but,
    /// unlike `generateRestyle`, GENERATES fresh audio via the joint
    /// transformer (denoiseMask=1, real decode through
    /// AudioVAEDecoder+VocoderWithBWE — the same pattern
    /// NativeI2VStage.generate uses) instead of preserving an existing audio
    /// track — a fresh relay segment has no prior audio to keep.
    ///
    /// `referenceFrames.count` becomes the generation's own output frame
    /// count (same "output length derives from the reference clip" behavior
    /// `generateRestyle` has) — callers MUST pass exactly the segment's own
    /// LTX frame count (8k+1), e.g. `NativeI2VStage.Request.frames`.
    public func generateCameraControl(
        referenceFrames: [CGImage], outputDir: URL, prompt: String,
        loraURL: URL, fps: Double = 24.0, textMaxLength: Int = 128, seed: UInt64 = 42,
        loraStrength: Float = 1.0
    ) throws -> CameraControlResult {
        let fm = FileManager.default
        guard !referenceFrames.isEmpty else {
            throw StageError.invalidDimensions("generateCameraControl: referenceFrames must not be empty")
        }
        guard fm.fileExists(atPath: loraURL.path) else {
            throw StageError.cameraLoraNotFound(loraURL)
        }
        try fm.createDirectory(at: outputDir, withIntermediateDirectories: true)

        print("[camera-control] encoding \(referenceFrames.count) synthetic reference frames...")
        let width = referenceFrames[0].width, height = referenceFrames[0].height
        let frameArrays = referenceFrames.map { FrameLoad.toArray($0) }  // each (1, 3, H, W) [0, 1]
        let stacked = MLX.stacked(frameArrays.map { $0[0] }, axis: 1)  // (3, F, H, W)
        let pixelsBCFHW = (stacked.asType(.float32) * 2.0 - 1.0).expandedDimensions(axis: 0)

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
        let videoEncoder = VideoEncoder(weights: encWeights)
        let referenceLatentRaw = videoEncoder(pixelsBCFHW)
        MLX.eval(referenceLatentRaw)
        let (referenceTokens, dims) = VideoLatentPatchifier.patchify(referenceLatentRaw)
        let videoPositions = Positions.computeVideoPositions(numFrames: dims.f, height: dims.h, width: dims.w, frameRate: Float(fps))
        let genTokenCount = dims.f * dims.h * dims.w

        print("[camera-control] LoRA: loading + fusing Cameraman IC-LoRA into distilled transformer...")
        let loraSources: [(weights: LoRAWeights, strength: Float)] = [
            (weights: try LoRAWeights.load(url: loraURL), strength: loraStrength),
        ]

        let noise = MLXRandom.normal([1, genTokenCount, 128], key: MLXRandom.key(seed))
        let baseVideoState = LatentState(
            latent: noise, cleanLatent: MLXArray.zeros([1, genTokenCount, 128]),
            denoiseMask: MLXArray.ones([1, genTokenCount, 1]), positions: videoPositions)
        let videoState = VideoConditionByReferenceLatent(
            referenceLatent: referenceTokens, referencePositions: videoPositions,
            downscaleFactor: 1, strength: 1.0
        ).apply(to: baseVideoState)

        // Fresh audio generation (denoiseMask=1) — the key difference from
        // generateRestyle's preserve-existing-audio behavior. numAudioTokens
        // is derived from referenceFrames.count (the PIXEL frame count),
        // NOT dims.f (the VAE-compressed LATENT frame count) — same
        // convention NativeI2VStage.generate uses with request.frames.
        let numAudioTokens = Positions.computeAudioTokenCount(numVideoFrames: referenceFrames.count, frameRate: Float(fps))
        let audioNoise = MLXRandom.normal([1, numAudioTokens, 128], key: MLXRandom.key(seed &+ 1))
        let audioPositions = Positions.computeAudioPositions(numTokens: numAudioTokens)
        let audioState = LatentState(latent: audioNoise, cleanLatent: audioNoise, denoiseMask: MLXArray.ones([1, numAudioTokens, 1]), positions: audioPositions)

        let textStage = NativeTextEncodeStage(maxLength: textMaxLength)
        let textResult = try textStage.encode(prompt)

        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        guard fm.fileExists(atPath: transformerURL.path) else {
            throw StageError.transformerCheckpointNotFound(transformerURL)
        }
        let rawTransformer = try MLX.loadArrays(url: transformerURL)
        var strippedTransformer: [String: MLXArray] = [:]
        for (key, value) in rawTransformer {
            guard key.hasPrefix("transformer.") else { continue }
            strippedTransformer[String(key.dropFirst("transformer.".count))] = value
        }

        let numLayers = 48
        let cfg = distilledConfig(numLayers: numLayers)
        let model = TransformerCheckpointLoader.makeModel(
            TransformerCheckpointLoader.topLevelWeights(raw: strippedTransformer, loraSources: loraSources),
            config: cfg, transformerBlocks: [])

        let denoiseResult = DenoiseLoop.runStreaming(
            model: model, numLayers: numLayers,
            blockProvider: { idx in
                TransformerCheckpointLoader.makeBlock(
                    TransformerCheckpointLoader.blockWeights(raw: strippedTransformer, blockIndex: idx, loraSources: loraSources),
                    config: cfg)
            },
            videoState: videoState, audioState: audioState,
            videoTextEmbeds: textResult.videoEmbeds, audioTextEmbeds: textResult.audioEmbeds,
            sigmas: SigmaSchedule.distilledSigmas)
        MLX.eval(denoiseResult.videoLatent, denoiseResult.audioLatent)

        let genTokens = denoiseResult.videoLatent[0..., 0..<genTokenCount, 0...]
        let generatedLatent = VideoLatentPatchifier.unpatchify(genTokens, dims: dims)

        print("[camera-control] decoding generated latent to \(width)x\(height) frames...")
        let videoDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        guard fm.fileExists(atPath: videoDecoderURL.path) else {
            throw StageError.videoDecoderCheckpointNotFound(videoDecoderURL)
        }
        let videoDecoder = try VideoDecoderLoader.loadReal(checkpointURL: videoDecoderURL)
        let pixels = videoDecoder(generatedLatent.asType(.float32))
        MLX.eval(pixels)
        let frameDir = outputDir.appendingPathComponent("frames")
        let frameCount = try PNGFrameWriter.writeFrames(pixels, to: frameDir)

        let audioLatentB8T16 = AudioPatchifier.unpatchify(denoiseResult.audioLatent)
        let audioDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        guard fm.fileExists(atPath: audioDecoderURL.path) else {
            throw StageError.audioEncoderCheckpointNotFound(audioDecoderURL)
        }
        let audioDecoder = try AudioVAEDecoderLoader.loadReal(checkpointURL: audioDecoderURL)
        let mel = audioDecoder(audioLatentB8T16.asType(.float32))
        MLX.eval(mel)
        let vocoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/vocoder.safetensors")
        let vocoder = try VocoderWithBWELoader.loadReal(checkpointURL: vocoderURL)
        let waveform = vocoder(mel)
        MLX.eval(waveform)
        let numChannels = waveform.dim(1)
        var channels: [[Float]] = []
        for c in 0..<numChannels {
            channels.append(waveform[0, c, 0...].asArray(Float.self))
        }
        let audioURL = outputDir.appendingPathComponent("audio.wav")
        try WAVWriter.write(channels: channels, sampleRate: 48000, to: audioURL)

        return CameraControlResult(frameDirectory: frameDir, frameCount: frameCount, audioURL: audioURL)
    }

    /// `generateCameraControl`'s own result type — includes `audioURL`
    /// (generated fresh), unlike the shared `Result` type `generateHD`/
    /// `generateRestyle` use (which never produce new audio).
    public struct CameraControlResult {
        public let frameDirectory: URL
        public let frameCount: Int
        public let audioURL: URL
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd swift/ltx-video-director && swift build && swift test --filter testGenerateCameraControlMissingLoraThrowsNamedError )`
Expected: PASS.

- [ ] **Step 6: Full-file build check**

Run: `( cd swift/ltx-video-director && swift build )`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirector/NativeUpscaleStage.swift swift/ltx-video-director/Tests/LTXVideoDirectorTests/NativeUpscaleStageRealCheckpointTests.swift
git commit -m "feat(ltx-video-director): add NativeUpscaleStage.generateCameraControl (fresh-audio IC-LoRA reference conditioning)"
```

---

### Task 3: `NativeRelayStage` wiring — per-segment camera-control branch

**Files:**
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirector/NativeRelayStage.swift`
- Test: `swift/ltx-video-director/Tests/LTXVideoDirectorTests/NativeRelayStageTests.swift`

- [ ] **Step 1: Write the failing tests**

Add to `NativeRelayStageTests.swift` (mirrors `testSecondsPerSegmentCountMismatchThrows`/`testSegmentContinuityCountMismatchThrows`):

```swift
    func testCameraMovementsCountMismatchThrows() {
        let stage = NativeRelayStage()
        var request = NativeRelayStage.Request(prompts: ["a red ball", "a blue ball"])
        request.cameraMovements = ["dolly_in"] // 1 entry, need 2
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_relay_camera_movements_mismatch_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeRelayStage.StageError else {
                XCTFail("expected StageError, got \(error)")
                return
            }
            if case .cameraMovementsCountMismatch(let count, let segments) = stageError {
                XCTAssertEqual(count, 1)
                XCTAssertEqual(segments, 2)
            } else {
                XCTFail("expected .cameraMovementsCountMismatch, got \(stageError)")
            }
        }
    }

    /// A v1-supported movement with no cameraLoraPath must fail fast, before
    /// any model loading — surfaced up front (unlike the per-segment
    /// fallback-with-warning behavior for unsupported movements or missing
    /// start images, which only apply mid-loop).
    func testSupportedCameraMovementWithoutLoraPathThrows() {
        let stage = NativeRelayStage()
        var request = NativeRelayStage.Request(prompts: ["a red ball"])
        request.cameraMovements = ["dolly_in"]
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_relay_camera_lora_missing_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeRelayStage.StageError else {
                XCTFail("expected StageError, got \(error)")
                return
            }
            if case .cameraLoraRequiredForSupportedMovement(let movement) = stageError {
                XCTAssertEqual(movement, "dolly_in")
            } else {
                XCTFail("expected .cameraLoraRequiredForSupportedMovement, got \(stageError)")
            }
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd swift/ltx-video-director && swift test --filter NativeRelayStageTests )`
Expected: FAIL to build — `cameraMovements`/`cameraLoraPath`/new StageError cases don't exist yet.

- [ ] **Step 3: Add `Request` fields and `StageError` cases**

In `NativeRelayStage.swift`, add to `StageError`'s case list (after `case segmentContinuityCountMismatch(count: Int, segments: Int)` at line 39):

```swift
        case segmentContinuityCountMismatch(count: Int, segments: Int)
        case cameraMovementsCountMismatch(count: Int, segments: Int)
        case cameraLoraRequiredForSupportedMovement(movement: String)
```

And to `description`'s switch (after the `.segmentContinuityCountMismatch` case):

```swift
            case .segmentContinuityCountMismatch(let count, let segments):
                return "NativeRelayStage: segmentContinuity has \(count) entries, expected \(segments) (one per segment/prompt)"
            case .cameraMovementsCountMismatch(let count, let segments):
                return "NativeRelayStage: cameraMovements has \(count) entries, expected \(segments) (one per segment/prompt)"
            case .cameraLoraRequiredForSupportedMovement(let movement):
                return "NativeRelayStage: segment requests camera_movement '\(movement)' (v1-supported) but cameraLoraPath is nil — pass --camera-lora"
```

Add to `Request` (after `public var segmentGridStrengths: [Float]?` at line 134):

```swift
        /// Per-segment shot_language.camera_movement value (raw string from
        /// scene_plan, e.g. "dolly_in"), one entry per `prompts.count` when
        /// given. Values outside SyntheticCameraReference's v1-supported set
        /// (currently "dolly_in", "tilt_up"), "none"/empty, hard-cut
        /// storyboard segments, and segments with no known start image are
        /// ALL no-ops — that segment generates exactly as it does today
        /// (a warning is printed, not an error, for the last two cases).
        /// Omitted (nil) -> no segment gets camera-control conditioning
        /// (unchanged default).
        public var cameraMovements: [String]?
        /// Cameraman v2 IC-LoRA checkpoint path — REQUIRED when any entry in
        /// `cameraMovements` names a v1-supported movement (fails fast if
        /// nil in that case); ignored otherwise.
        public var cameraLoraPath: URL?
```

- [ ] **Step 4: Add validation**

In `generate()`, after the `segmentContinuity` count-mismatch check (after line 207's closing `}`):

```swift
        if let cameraMovements = request.cameraMovements {
            guard cameraMovements.count == request.prompts.count else {
                throw StageError.cameraMovementsCountMismatch(count: cameraMovements.count, segments: request.prompts.count)
            }
            for movement in cameraMovements where SyntheticCameraReference.isSupported(movement) {
                guard request.cameraLoraPath != nil else {
                    throw StageError.cameraLoraRequiredForSupportedMovement(movement: movement)
                }
            }
        }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd swift/ltx-video-director && swift build && swift test --filter NativeRelayStageTests )`
Expected: PASS, all existing + 2 new tests green.

- [ ] **Step 6: Wire the per-segment loop branch**

Replace the loop body's tail — from `let result = try stage.generate(segRequest, outputDir: segDir)` (line 277) through the `nextInputImage = lastFrameURL` line (line 284) — with:

```swift
            var isHardCutStoryboardSegment = false
            if request.segmentGridPanels != nil, index < (request.segmentGridPanels?.count ?? 0) {
                isHardCutStoryboardSegment = true
            }

            let requestedMovement = request.cameraMovements?[index]
            let cameraMovement = requestedMovement.flatMap { CameraMovementType(rawValue: $0) }
            let result: NativeI2VStage.Result
            if let cameraMovement, !isHardCutStoryboardSegment, let startImagePath = segRequest.inputImagePath {
                print("[relay] segment \(segNum): camera-control-LoRA (\(cameraMovement.rawValue)) — synthesizing reference clip")
                guard let cameraLoraPath = request.cameraLoraPath else {
                    // Already validated up front in generate() — unreachable in practice, kept as a defensive guard.
                    throw StageError.cameraLoraRequiredForSupportedMovement(movement: cameraMovement.rawValue)
                }
                guard let startImage = FrameLoad.loadCGImage(from: startImagePath) else {
                    throw StageError.cameraControlStartImageUnreadable(startImagePath)
                }
                let referenceFrames = SyntheticCameraReference.synthesize(
                    startImage: startImage, movement: cameraMovement,
                    frameCount: segRequest.frames, targetWidth: request.width, targetHeight: request.height)
                let ccResult = try NativeUpscaleStage().generateCameraControl(
                    referenceFrames: referenceFrames, outputDir: segDir, prompt: prompt,
                    loraURL: cameraLoraPath, fps: request.fps, textMaxLength: request.textMaxLength,
                    seed: request.seed &+ UInt64(index))
                result = NativeI2VStage.Result(
                    sourceImageURL: startImagePath, frameDirectory: ccResult.frameDirectory,
                    frameCount: ccResult.frameCount, audioURL: ccResult.audioURL)
            } else {
                if let requestedMovement, !requestedMovement.isEmpty, requestedMovement != "none", cameraMovement == nil {
                    print("[relay] segment \(segNum): camera_movement '\(requestedMovement)' not in the v1-supported set (dolly_in, tilt_up) — generating with plain prompt text instead")
                } else if let cameraMovement, isHardCutStoryboardSegment || segRequest.inputImagePath == nil {
                    print("[relay] segment \(segNum): camera_movement '\(cameraMovement.rawValue)' requested but no start image available (hard-cut/fresh-T2I segment) — generating with plain prompt text instead")
                }
                result = try stage.generate(segRequest, outputDir: segDir)
            }
            segmentResults.append(result)
            segmentDurations.append(Double(result.frameCount) / request.fps)

            let lastFrameURL = result.frameDirectory.appendingPathComponent(
                String(format: "frame_%04d.png", result.frameCount - 1))
            print("[relay] segment \(segNum) last frame: \(lastFrameURL.lastPathComponent) — feeding forward as segment \(segNum + 1)'s --input-image")
            nextInputImage = lastFrameURL
```

Add the one new `StageError` case this references, `cameraControlStartImageUnreadable`, alongside the others from Step 3:

```swift
        case cameraLoraRequiredForSupportedMovement(movement: String)
        case cameraControlStartImageUnreadable(URL)
```

```swift
            case .cameraLoraRequiredForSupportedMovement(let movement):
                return "NativeRelayStage: segment requests camera_movement '\(movement)' (v1-supported) but cameraLoraPath is nil — pass --camera-lora"
            case .cameraControlStartImageUnreadable(let url):
                return "NativeRelayStage: could not load start image for camera-control synthesis at \(url.path)"
```

- [ ] **Step 7: Full build + full existing relay test suite**

Run: `( cd swift/ltx-video-director && swift build && swift test --filter NativeRelayStageTests )`
Expected: PASS, all 8 tests (6 existing + 2 new) green — proves the untouched-segment path (no `cameraMovements` set) still behaves exactly as before, since none of these tests set it.

- [ ] **Step 8: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirector/NativeRelayStage.swift swift/ltx-video-director/Tests/LTXVideoDirectorTests/NativeRelayStageTests.swift
git commit -m "feat(ltx-video-director): wire camera-control-LoRA into NativeRelayStage's per-segment loop"
```

---

### Task 4: `native-relay` CLI flags

**Files:**
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirectorCLI/NativeRelayCommand.swift`

- [ ] **Step 1: Add the two new `@Option` fields**

After `var gridStrengths: [Double] = []` (line 109):

```swift
    @Option(name: .customLong("camera-movements"), parsing: .upToNextOption,
            help: "Per-segment shot_language.camera_movement value, one per --prompts entry (e.g. 'dolly_in', 'tilt_up'). Only dolly_in/tilt_up are supported in v1 — other values, 'none', or omitted entries generate exactly as they do today. Requires --camera-lora when any entry names a supported movement.")
    var cameraMovements: [String] = []

    @Option(name: .customLong("camera-lora"),
            help: "Path to the Cameraman v2 IC-LoRA checkpoint. Defaults to the bundled import at mlx-models/lora/camera-control-cameraman-v2/ when a supported --camera-movements entry is present and this is omitted.")
    var cameraLora: String?
```

- [ ] **Step 2: Wire them into `baseRequest()`**

After `if !segmentContinuity.isEmpty { request.segmentContinuity = segmentContinuity }` (line 154):

```swift
        if !cameraMovements.isEmpty { request.cameraMovements = cameraMovements }
        request.cameraLoraPath = cameraLora.map { URL(fileURLWithPath: $0) }
            ?? RepoPaths.mlxModelsRoot.appendingPathComponent("lora/camera-control-cameraman-v2/LTX2.3-22B_IC-LoRA-Cameraman_v2_14000.safetensors")
```

- [ ] **Step 3: Build**

Run: `( cd swift/ltx-video-director && swift build )`
Expected: zero errors.

- [ ] **Step 4: Manual smoke check of `--help`**

Run: `( cd swift/ltx-video-director && swift run ltx-video native-relay --help )`
Expected: output includes `--camera-movements` and `--camera-lora` with the help text from Step 1.

- [ ] **Step 5: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirectorCLI/NativeRelayCommand.swift
git commit -m "feat(ltx-video-director): expose --camera-movements/--camera-lora on native-relay"
```

---

### Task 5: Import the Cameraman v2 checkpoint (one-time repo-setup step)

This is a one-time asset-provisioning step using the existing Python model-import tool (`import-lora-image.py`) — NOT a runtime CLI path the TS agent bridge calls, so it does not violate the Swift-native-only-for-production rule (same category as `scripts/setup-repo-deps.sh`). Skip this task if the checkpoint is already imported (check first).

- [ ] **Step 1: Check whether it's already imported**

Run: `ls mlx-models/lora/camera-control-cameraman-v2/ 2>&1`
Expected (if not yet imported): `No such file or directory`.

- [ ] **Step 2: Download the checkpoint to a scratch location**

```bash
curl -L -o /tmp/LTX2.3-22B_IC-LoRA-Cameraman_v2_14000.safetensors \
  https://huggingface.co/Cseti/LTX2.3-22B_IC-LoRA-Cameraman_v2/resolve/main/LTX2.3-22B_IC-LoRA-Cameraman_v2_14000.safetensors
```
Expected: file downloads, ~654,443,424 bytes.

- [ ] **Step 3: Import via `run.py import-lora-image`**

```bash
python/venv/bin/python python/mlx-movie-director/run.py import-lora-image \
  /tmp/LTX2.3-22B_IC-LoRA-Cameraman_v2_14000.safetensors \
  --arch ltx-2.3 --name camera-control-cameraman-v2 --no-ai \
  --description "Cseti Cameraman v2 IC-LoRA for camera-movement conditioning (dolly_in/tilt_up in v1)"
```
Expected: `[import-lora-image] Imported: camera-control-cameraman-v2`, and `mlx-models/lora/camera-control-cameraman-v2/` now contains a symlink to the external store plus `manifest.json`/`README.md`.

- [ ] **Step 4: Verify the path Task 4's default expects**

Run: `ls -la mlx-models/lora/camera-control-cameraman-v2/LTX2.3-22B_IC-LoRA-Cameraman_v2_14000.safetensors`
Expected: a symlink resolving to a real file in the external store (`../video_generation__models/<md5>`), not a broken link.

- [ ] **Step 5: Clean up the scratch download**

```bash
rm -f /tmp/LTX2.3-22B_IC-LoRA-Cameraman_v2_14000.safetensors
```

- [ ] **Step 6: Commit the imported manifest/symlink**

```bash
git add mlx-models/lora/camera-control-cameraman-v2/
git commit -m "chore(mlx-models): import Cameraman v2 IC-LoRA for camera-control-LoRA (dolly_in/tilt_up)"
```

---

### Task 6: `pi-agent-ext-ltx` — `native-relay` command spec fields

**Files:**
- Modify: `bun-apps/pi-agent-ext-ltx/src/commands.ts`

- [ ] **Step 1: Add the two new fields**

In `commands.ts`'s `"native-relay"` entry, after `gridStrengths: { ... }` (line 248, just before the closing `},` at line 249):

```typescript
      cameraMovements: { flag: "--camera-movements", type: "string[]", description: "Per-segment shot_language.camera_movement value, one per prompts entry (e.g. 'dolly_in', 'tilt_up'). Only dolly_in/tilt_up are supported in v1 — other values, 'none', or omitted entries generate exactly as they do today. Requires cameraLora when any entry names a supported movement." },
      cameraLora: { flag: "--camera-lora", type: "string", isPath: true, description: "Path to the Cameraman v2 IC-LoRA checkpoint. Defaults to the bundled import under mlx-models/lora/camera-control-cameraman-v2/ when a supported cameraMovements entry is present and this is omitted." },
```

- [ ] **Step 2: Run the flag-parity check**

Run: `( cd bun-apps/pi-agent-ext-ltx && bun run check:flags )`
Expected: `native-relay` reports 0 drift against the real `ltx-video native-relay --help` (requires Task 4's binary already built — rebuild first with `( cd swift/ltx-video-director && swift build )` if stale).

- [ ] **Step 3: Run the package's test suite**

Run: `( cd bun-apps/pi-agent-ext-ltx && bun test )`
Expected: PASS, no regressions.

- [ ] **Step 4: Commit**

```bash
git add bun-apps/pi-agent-ext-ltx/src/commands.ts
git commit -m "feat(pi-agent-ext-ltx): add cameraMovements/cameraLora fields to native-relay"
```

---

### Task 7: `pi-agent-ext-movie-director` — thread `camera_movement` through the asset plan

**Files:**
- Modify: `bun-apps/pi-agent-ext-movie-director/src/assets-encoder.ts`
- Modify: `bun-apps/pi-agent-ext-movie-director/src/driver-wiring.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/assets-encoder.test.ts`
- Test: `bun-apps/pi-agent-ext-movie-director/src/driver-wiring.test.ts`

- [ ] **Step 1: Write the failing test for `assets-encoder.ts`**

Add to `assets-encoder.test.ts`, inside (or after) the `describe("planAssetGeneration — relay links", ...)` block:

```typescript
test("passes shot_language.camera_movement through to every relay link of that scene", () => {
	const plan = planAssetGeneration(
		{ scenes: [scene({ end_seconds: 16, shot_language: { camera_movement: "dolly_in" } })] } as any,
		script as any,
		{ maxCallSeconds: 8 },
	);
	expect(plan.relayLinks.length).toBe(2); // 16s / 8s ceiling = 2 links, same scene
	expect(plan.relayLinks.every((l) => l.cameraMovement === "dolly_in")).toBe(true);
});

test("omits cameraMovement when shot_language.camera_movement is absent", () => {
	const plan = planAssetGeneration({ scenes: [scene({ end_seconds: 6 })] } as any, script as any, { maxCallSeconds: 8 });
	expect(plan.relayLinks[0]!.cameraMovement).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/assets-encoder.test.ts )`
Expected: FAIL — `plan.relayLinks[0].cameraMovement` is `undefined` even when `shot_language.camera_movement` is set (field doesn't exist on `SceneLike`/`RelayLink` yet), so the first new test's assertion fails.

- [ ] **Step 3: Extend `SceneLike` and `RelayLink` in `assets-encoder.ts`**

In `RelayLink` (after `continuity: boolean;` at line 29):

```typescript
	continuity: boolean;
	/** shot_language.camera_movement passthrough from scene_plan, e.g. "dolly_in".
	 *  Undefined when the scene has no shot_language.camera_movement set. Only
	 *  "dolly_in"/"tilt_up" get real IC-LoRA conditioning in v1 (see native-relay's
	 *  --camera-movements) — every other value still reaches generation as plain
	 *  prompt text via applyShotLanguage elsewhere, unaffected by this field. */
	cameraMovement?: string;
```

In `SceneLike` (after `continuity?: "continue" | "cut";` at line 56):

```typescript
	continuity?: "continue" | "cut";
	shot_language?: { camera_movement?: string };
```

- [ ] **Step 4: Copy the field through in `planAssetGeneration`**

In the `relayLinks.push({...})` call (lines 84-93), add the new field:

```typescript
			relayLinks.push({
				sceneId: scene.id,
				chainIndex: i,
				prompt: scene.description,
				seconds: perLinkSeconds,
				continuity: i === 0 ? scene.continuity !== "cut" : true,
				cameraMovement: scene.shot_language?.camera_movement,
			});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/assets-encoder.test.ts )`
Expected: PASS, all tests including the 2 new ones.

- [ ] **Step 6: Write the failing test for `driver-wiring.ts`**

Add to `driver-wiring.test.ts`, inside the existing `describe("wireProduce — assets execution (single native-relay call for the whole movie)", ...)` block (which already declares the local `assetsDeps()` helper used below), right after the existing `"a scene with continuity:'cut' sets that scene's first link to false, others stay true"` test:

```typescript
	test("forwards cameraMovements to the native-relay dispatch options, defaulting missing entries to 'none'", async () => {
		const { deps, genCalls } = assetsDeps();
		await wireProduce(deps)("assets", {
			scene_plan: {
				scenes: [
					{ id: "s1", type: "generated", description: "a cube", start_seconds: 0, end_seconds: 8, shot_language: { camera_movement: "dolly_in" } },
					{ id: "s2", type: "generated", description: "a sphere", start_seconds: 8, end_seconds: 16 },
				],
			},
			script: { sections: [{ id: "s1", text: "hi" }] },
		});
		const relayCall = genCalls.find((c) => c.command === "native-relay")!;
		expect((relayCall.options as Record<string, unknown>).cameraMovements).toEqual(["dolly_in", "none"]);
	});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/driver-wiring.test.ts )`
Expected: FAIL — `relayCall.options.cameraMovements` is `undefined` (not wired yet).

- [ ] **Step 8: Wire `cameraMovements` into the `native-relay` dispatch call**

In `driver-wiring.ts`'s `produceAssets`, in the `native-relay` dispatch's `options` object (lines 172-178):

```typescript
			options: {
				prompts: plan.relayLinks.map((l) => l.prompt),
				secondsPerSegment: plan.relayLinks.map((l) => l.seconds),
				segmentContinuity: plan.relayLinks.map((l) => l.continuity),
				cameraMovements: plan.relayLinks.map((l) => l.cameraMovement ?? "none"),
				fps,
				...(narrationPath ? { relayAudio: narrationPath } : {}),
			},
```

- [ ] **Step 9: Run test to verify it passes**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test src/driver-wiring.test.ts )`
Expected: PASS.

- [ ] **Step 10: Run the full package test suite + typecheck**

Run: `( cd bun-apps/pi-agent-ext-movie-director && bun test )`
Run: `bun run --cwd bun-apps/gui-movie-director check:schema`
Expected: both green, no regressions in other tests that construct `AssetPlan`/`RelayLink` literals (check for any that would now need the new optional field — it's optional, so existing object literals without it remain valid).

- [ ] **Step 11: Commit**

```bash
git add bun-apps/pi-agent-ext-movie-director/src/assets-encoder.ts bun-apps/pi-agent-ext-movie-director/src/driver-wiring.ts bun-apps/pi-agent-ext-movie-director/src/assets-encoder.test.ts bun-apps/pi-agent-ext-movie-director/src/driver-wiring.test.ts
git commit -m "feat(pi-agent-ext-movie-director): thread shot_language.camera_movement into the native-relay dispatch"
```

---

### Task 8: Manual real-generation verification + docs

No automated end-to-end test exists for `NativeRelayStage`'s real chaining behavior today (see `NativeRelayStageTests.swift`'s own header — it's verified manually per-session). Follow the same convention here.

- [ ] **Step 1: Rebuild the release binary**

Run: `( cd swift/ltx-video-director && swift build -c release )`
Expected: zero errors.

- [ ] **Step 2: Run a real 2-segment chain, one segment with `dolly_in`, one with `none`**

```bash
swift/ltx-video-director/.build/release/ltx-video native-relay \
  --prompts "a woman walking down a hallway" "the hallway continues past a window" \
  --camera-movements dolly_in none \
  --seconds 1.0 --width 1088 --height 576 \
  --output /tmp/camera-control-verify
```
Expected: completes without error; `/tmp/camera-control-verify/seg01/` and `seg02/` each contain `frames/`/`audio.wav`; `/tmp/camera-control-verify/relay.mp4` exists.

- [ ] **Step 3: Cross-check the dolly_in segment's direction signal**

Write a standalone script (this recreates the PR #890/#896 spikes' Farneback classifier — it did not live in the repo, only in a since-cleaned scratchpad, so it must be rewritten here rather than referenced):

```python
# /tmp/flow_direction.py
import sys, glob
import cv2
import numpy as np

def analyze(frame_dir, sample_stride=2):
    paths = sorted(glob.glob(f"{frame_dir}/frame_*.png"))
    frames = [cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2GRAY) for p in paths[::sample_stride]]
    h, w = frames[0].shape
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = w / 2.0, h / 2.0
    radial_x = (xx - cx) / max(w, h)
    radial_y = (yy - cy) / max(w, h)
    pans, tilts, zooms = [], [], []
    for a, b in zip(frames[:-1], frames[1:]):
        flow = cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        pans.append(float(np.mean(flow[..., 0])))
        tilts.append(float(np.mean(flow[..., 1])))
        zooms.append(float(np.mean(flow[..., 0] * radial_x + flow[..., 1] * radial_y)))
    return {"pan": float(np.mean(pans)), "tilt": float(np.mean(tilts)), "zoom": float(np.mean(zooms))}

if __name__ == "__main__":
    print(analyze(sys.argv[1]))
```

Run: `python/venv/bin/python /tmp/flow_direction.py /tmp/camera-control-verify/seg01/frames`

Compare the printed `zoom` value against PR #896's isolated `native-restyle` dolly_in measurement (treatment reached 85-94% of ground truth zoom magnitude, correctly signed). Expected: a comparable negative-signed zoom value of similar order of magnitude — confirming the in-chain result matches the isolated-call result (no regression from wiring into `native-relay`).

- [ ] **Step 4: Confirm the `none` segment is unaffected**

Run the same 2-segment chain WITHOUT `--camera-movements` at all, same seeds/prompts. Compare `seg02/frames/frame_0000.png` between the two runs (byte-diff or visual check). Expected: identical — segment 2 (`none`) is untouched by the feature being present on segment 1.

- [ ] **Step 5: Update the capability matrix**

In `docs/openmontage-capability-matrix.md`'s `camera_direction` row, add a dated note: camera-control-LoRA is now wired into the real production `native-relay` path (not just the isolated `native-i2v`/`native-restyle` pair from PR #890/#896), v1 scoped to `dolly_in`/`tilt_up`, with the Step 3 cross-check numbers.

- [ ] **Step 6: Update the standing memory**

Append a dated section to the user's `project_camera_control_lora_research.md` memory file recording: Phase 2 shipped, `native-relay` now supports `--camera-movements`/`--camera-lora`, scene_plan's `shot_language.camera_movement` is wired end-to-end for `dolly_in`/`tilt_up`, and the remaining backlog (the other 16 movement types, none of which have a reference-sourcing strategy yet).

- [ ] **Step 7: Commit the docs**

```bash
git add docs/openmontage-capability-matrix.md
git commit -m "docs: record camera-control-LoRA native-relay integration (Phase 2 shipped)"
```

---

## Explicitly out of scope (do not implement as part of this plan)

- `pan_right` and the 5 untested affine-mappable movements (`dolly_out`, `pan_left`, `tilt_down`, `zoom_in`, `zoom_out`) — no `CameraMovementType` case, no synthesis logic. A future plan, after running the missing spike measurements.
- The 11 non-affine-mappable movement types (`tracking_*`, `crane_*`, `handheld`, `steadicam`, `whip_pan`, `orbital`, `rack_focus`) — no reference-sourcing strategy exists.
- Any Python-side work — every runtime code path in this plan is Swift or TypeScript.
