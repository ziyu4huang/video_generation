# Swift LipDub Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port Python's LipDub IC-LoRA reference-video lip-dubbing pipeline to Swift as a new `native-lipdub` CLI command, closing the `lip_sync` capability-matrix gap.

**Architecture:** A new audio-side conditioning primitive (`AudioConditionByReferenceLatent`, the sibling of the existing `VideoConditionByReferenceLatent`) plus a new video-audio-track extractor (`VideoAudioReader`) feed a new two-stage `NativeUpscaleStage.generateLipdub` method (half-res IC-LoRA-conditioned denoise → 2x `LatentUpsampler` → full-res IC-LoRA-conditioned refine, LoRA fused through both stages, audio frozen after stage 1), exposed via a new `native-lipdub` CLI command.

**Tech Stack:** Swift, MLX (Swift bindings), AVFoundation, swift-argument-parser. See `docs/superpowers/specs/2026-07-26-swift-lipdub-port-design.md` for the full design and architecture discovery.

---

## Task 1: `AudioConditionByReferenceLatent` conditioning primitive

**Files:**
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirector/Sampling/LatentConditioning.swift`
- Test: `swift/ltx-video-director/Tests/LTXVideoDirectorTests/AudioConditionByReferenceLatentTests.swift` (create)

- [ ] **Step 1: Write the failing tests**

Create `swift/ltx-video-director/Tests/LTXVideoDirectorTests/AudioConditionByReferenceLatentTests.swift`:

```swift
import XCTest
import MLX
@testable import LTXVideoDirector

final class AudioConditionByReferenceLatentTests: XCTestCase {
    func testAppendsReferenceTokensWithPreservedMask() {
        let latent = MLXArray.zeros([1, 4, 2])
        let state = LatentState(
            latent: latent, cleanLatent: latent,
            denoiseMask: MLXArray.ones([1, 4, 1]),
            positions: MLXArray([0.0, 1.0, 2.0, 3.0], [1, 4, 1]))
        let refLatent = MLXArray.zeros([1, 2, 2])
        let refPositions = MLXArray([10.0, 11.0], [1, 2, 1])

        let conditioner = AudioConditionByReferenceLatent(
            referenceLatent: refLatent, referencePositions: refPositions,
            strength: 1.0, negativePositions: false)
        let newState = conditioner.apply(to: state)
        MLX.eval(newState.latent, newState.cleanLatent, newState.denoiseMask, newState.positions!)

        XCTAssertEqual(newState.latent.shape, [1, 6, 2])
        let mask = newState.denoiseMask.reshaped([-1]).asArray(Float.self)
        // First 4 tokens: original mask (1.0, generate). Last 2 (appended reference): mask = 0 (preserved).
        XCTAssertEqual(mask, [1, 1, 1, 1, 0, 0])
    }

    func testNegativePositionsShiftsReferenceStrictlyBeforeZero() {
        let latent = MLXArray.zeros([1, 4, 2])
        let state = LatentState(
            latent: latent, cleanLatent: latent,
            denoiseMask: MLXArray.ones([1, 4, 1]),
            positions: MLXArray([0.0, 1.0, 2.0, 3.0], [1, 4, 1]))
        let refLatent = MLXArray.zeros([1, 3, 2])
        // Reference's OWN positions span [0, 5] before the shift is applied.
        let refPositions = MLXArray([0.0, 2.5, 5.0], [1, 3, 1])

        let conditioner = AudioConditionByReferenceLatent(
            referenceLatent: refLatent, referencePositions: refPositions,
            strength: 1.0, negativePositions: true)
        let newState = conditioner.apply(to: state)
        MLX.eval(newState.positions!)

        let positions = newState.positions!.reshaped([-1]).asArray(Float.self)
        let appendedPositions = Array(positions[4...])
        // Shifted to end at -0.04 (max(refPositions)=5.0 -> shifted max = 5.0 - (5.0 + 0.04) = -0.04).
        XCTAssertEqual(appendedPositions, [-5.04, -2.54, -0.04], accuracy: 1e-5)
        for p in appendedPositions {
            XCTAssertLessThan(p, 0.0)
        }
    }

    func testMaskValueReflectsStrength() {
        let latent = MLXArray.zeros([1, 4, 2])
        let state = LatentState(
            latent: latent, cleanLatent: latent, denoiseMask: MLXArray.ones([1, 4, 1]),
            positions: MLXArray([0.0, 1.0, 2.0, 3.0], [1, 4, 1]))
        let refLatent = MLXArray.zeros([1, 2, 2])
        let refPositions = MLXArray([10.0, 11.0], [1, 2, 1])
        let conditioner = AudioConditionByReferenceLatent(
            referenceLatent: refLatent, referencePositions: refPositions,
            strength: 0.25, negativePositions: false)
        let newState = conditioner.apply(to: state)
        MLX.eval(newState.denoiseMask)
        let mask = newState.denoiseMask.reshaped([-1]).asArray(Float.self)
        XCTAssertEqual(mask, [1, 1, 1, 1, 0.75, 0.75])
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd swift/ltx-video-director && swift test --filter AudioConditionByReferenceLatentTests )`
Expected: FAIL to compile — `AudioConditionByReferenceLatent` does not exist yet.

- [ ] **Step 3: Implement `AudioConditionByReferenceLatent`**

Append to `swift/ltx-video-director/Sources/LTXVideoDirector/Sampling/LatentConditioning.swift` (after the existing `VideoConditionByReferenceLatent` struct, i.e. after its closing `}` currently at line 150):

```swift

/// Native port of `ltx_core_mlx.conditioning.types.reference_audio_cond
/// .AudioConditionByReferenceLatent` — the audio-side sibling of
/// `VideoConditionByReferenceLatent` above. APPENDS a reference clip's
/// audio latent tokens to the end of the audio sequence as always-preserved
/// (denoiseMask=0, when strength=1.0) context, same append-not-replace
/// shape, but for 1-axis audio positions `(B, T, 1)` instead of 3-axis
/// video positions.
///
/// When `negativePositions` is true (the only mode `NativeUpscaleStage
/// .generateLipdub` uses), the reference's own positions are shifted into
/// negative time — `positions - (max(positions) + 0.04)` — before being
/// appended, mirroring `ltx_pipelines_mlx.lipdub
/// .patchify_lipdub_audio_reference_latent`: the model reads the reference
/// audio as off-screen context strictly before the generated audio
/// sequence's own time-0 origin, not overlapping it.
///
/// Scope: same restriction `VideoConditionByReferenceLatent` documents for
/// itself — only `strength == 1.0` (fully preserved reference, no partial
/// attention mask) is exercised by any current call site.
public struct AudioConditionByReferenceLatent {
    public let referenceLatent: MLXArray      // (B, Tr, C)
    public let referencePositions: MLXArray   // (B, Tr, 1), already shifted if negativePositions
    public let strength: Float                // 1.0 = fully preserved (mask=0)
    public let negativePositions: Bool

    public init(referenceLatent: MLXArray, referencePositions: MLXArray, strength: Float = 1.0, negativePositions: Bool = true) {
        self.referenceLatent = referenceLatent
        self.strength = strength
        self.negativePositions = negativePositions
        if negativePositions {
            let maxPos = referencePositions.max().item(Float.self)
            self.referencePositions = referencePositions - (maxPos + 0.04)
        } else {
            self.referencePositions = referencePositions
        }
    }

    public func apply(to state: LatentState) -> LatentState {
        let numRef = referenceLatent.dim(1)
        let maskValue = 1.0 - strength

        let newLatent = MLX.concatenated([state.latent, referenceLatent], axis: 1)
        let newClean = MLX.concatenated([state.cleanLatent, referenceLatent], axis: 1)

        let b = state.denoiseMask.dim(0)
        let refMask = MLXArray(Array(repeating: maskValue, count: b * numRef)).reshaped([b, numRef, 1])
        let newMask = MLX.concatenated([state.denoiseMask, refMask], axis: 1)

        var newPositions = state.positions
        if let statePositions = state.positions {
            newPositions = MLX.concatenated([statePositions, referencePositions], axis: 1)
        }

        return LatentState(latent: newLatent, cleanLatent: newClean, denoiseMask: newMask, positions: newPositions, attentionMask: state.attentionMask)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/ltx-video-director && swift test --filter AudioConditionByReferenceLatentTests )`
Expected: PASS (3/3 tests).

- [ ] **Step 5: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirector/Sampling/LatentConditioning.swift swift/ltx-video-director/Tests/LTXVideoDirectorTests/AudioConditionByReferenceLatentTests.swift
git commit -m "feat(ltx-video-director): add AudioConditionByReferenceLatent conditioning primitive"
```

---

## Task 2: `VideoAudioReader` — extract a reference video's own audio track

**Files:**
- Create: `swift/ltx-video-director/Sources/LTXVideoDirector/VideoAudioReader.swift`
- Test: `swift/ltx-video-director/Tests/LTXVideoDirectorTests/VideoAudioReaderTests.swift` (create)

- [ ] **Step 1: Write the failing tests**

Create `swift/ltx-video-director/Tests/LTXVideoDirectorTests/VideoAudioReaderTests.swift`:

```swift
import XCTest
import MLX
@testable import LTXVideoDirector

final class VideoAudioReaderTests: XCTestCase {
    func testReadExtractsAudioTrackMatchingSourceWAV() throws {
        let frameDir = FileManager.default.temporaryDirectory.appendingPathComponent("video_audio_reader_frames_\(UUID().uuidString)")
        let wavURL = FileManager.default.temporaryDirectory.appendingPathComponent("video_audio_reader_source_\(UUID().uuidString).wav")
        let mp4URL = FileManager.default.temporaryDirectory.appendingPathComponent("video_audio_reader_test_\(UUID().uuidString).mp4")
        defer {
            try? FileManager.default.removeItem(at: frameDir)
            try? FileManager.default.removeItem(at: wavURL)
            try? FileManager.default.removeItem(at: mp4URL)
        }

        // Known source: a 0.5s 440Hz sine tone, written via the existing (already-tested) WAVWriter.
        let sampleRate = 44100
        let frameCount = sampleRate / 2
        var sine = [Float](repeating: 0, count: frameCount)
        for i in 0..<frameCount {
            sine[i] = sin(2.0 * Float.pi * 440.0 * Float(i) / Float(sampleRate))
        }
        try WAVWriter.write(channels: [sine, sine], sampleRate: sampleRate, to: wavURL)

        // Mux it into a real mp4 via the existing MP4Writer (a few solid-color frames + the WAV above).
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 12, 64, 64], key: MLXRandom.key(5)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: frameDir)
        try MP4Writer.write(frameDirectory: frameDir, audioURL: wavURL, fps: 24.0, to: mp4URL)

        let extracted = try VideoAudioReader.read(url: mp4URL)
        let original = try WAVReader.read(url: wavURL)

        XCTAssertEqual(extracted.channels.count, original.channels.count)
        // mp4 muxing may resample/re-encode — compare via correlation, not exact equality.
        let n = min(extracted.channels[0].count, original.channels[0].count)
        XCTAssertGreaterThan(n, 0)
        var dot: Float = 0, normA: Float = 0, normB: Float = 0
        for i in 0..<n {
            dot += extracted.channels[0][i] * original.channels[0][i]
            normA += extracted.channels[0][i] * extracted.channels[0][i]
            normB += original.channels[0][i] * original.channels[0][i]
        }
        let correlation = dot / (sqrt(normA) * sqrt(normB) + 1e-9)
        XCTAssertGreaterThan(correlation, 0.9, "extracted audio should closely match the source WAV muxed into the mp4")
    }

    func testReadThrowsOnVideoWithNoAudioTrack() throws {
        let frameDir = FileManager.default.temporaryDirectory.appendingPathComponent("video_audio_reader_novideo_\(UUID().uuidString)")
        let mp4URL = FileManager.default.temporaryDirectory.appendingPathComponent("video_audio_reader_novideo_\(UUID().uuidString).mp4")
        defer {
            try? FileManager.default.removeItem(at: frameDir)
            try? FileManager.default.removeItem(at: mp4URL)
        }
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 1, 64, 64], key: MLXRandom.key(3)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: frameDir)
        try MP4Writer.write(frameDirectory: frameDir, audioURL: nil, fps: 24.0, to: mp4URL)

        XCTAssertThrowsError(try VideoAudioReader.read(url: mp4URL)) { error in
            guard case VideoAudioReaderError.noAudioTrack = error else {
                XCTFail("expected .noAudioTrack, got \(error)"); return
            }
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd swift/ltx-video-director && swift test --filter VideoAudioReaderTests )`
Expected: FAIL to compile — `VideoAudioReader`/`VideoAudioReaderError` do not exist yet.

- [ ] **Step 3: Implement `VideoAudioReader`**

Create `swift/ltx-video-director/Sources/LTXVideoDirector/VideoAudioReader.swift`:

```swift
//
//  VideoAudioReader.swift
//  LTXVideoDirector
//
//  Extracts a video file's own audio track to raw Float32 PCM per channel —
//  the same shape WAVReader.Result produces for standalone .wav files — so
//  NativeUpscaleStage.generateLipdub can feed a reference VIDEO's audio
//  straight into the same resample-then-AudioVAEEncoderLoader-encode code
//  generateRestyle/generateHD/refine already all repeat for standalone WAVs.
//  Same AVAssetReader extraction pattern AudioProbe.analyze already uses,
//  returning raw samples instead of collapsing them to loudness stats.
//

import AVFoundation
import Foundation

public enum VideoAudioReaderError: Error, CustomStringConvertible {
    case noAudioTrack(URL)
    public var description: String {
        switch self {
        case .noAudioTrack(let url): return "VideoAudioReader: no audio track in \(url.path)"
        }
    }
}

public enum VideoAudioReader {
    public static func read(url: URL) throws -> WAVReader.Result {
        let asset = AVURLAsset(url: url)
        guard let track = asset.tracks(withMediaType: .audio).first else {
            throw VideoAudioReaderError.noAudioTrack(url)
        }
        let formatDescriptions = track.formatDescriptions as? [CMFormatDescription] ?? []
        let streamDesc = formatDescriptions.first.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
        let sampleRate = Int(streamDesc?.mSampleRate ?? 44100)
        let numChannels = max(1, Int(streamDesc?.mChannelsPerFrame ?? 1))

        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVNumberOfChannelsKey: numChannels,
        ]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        reader.add(output)
        reader.startReading()

        var interleaved: [Float] = []
        while let buffer = output.copyNextSampleBuffer() {
            guard let blockBuffer = CMSampleBufferGetDataBuffer(buffer) else { continue }
            let length = CMBlockBufferGetDataLength(blockBuffer)
            var data = [UInt8](repeating: 0, count: length)
            CMBlockBufferCopyDataBytes(blockBuffer, atOffset: 0, dataLength: length, destination: &data)
            data.withUnsafeBytes { raw in
                let floats = raw.bindMemory(to: Float32.self)
                interleaved.append(contentsOf: floats)
            }
        }

        let frameCount = interleaved.count / numChannels
        var channels = [[Float]](repeating: [Float](repeating: 0, count: frameCount), count: numChannels)
        for frame in 0..<frameCount {
            for ch in 0..<numChannels {
                channels[ch][frame] = interleaved[frame * numChannels + ch]
            }
        }
        return WAVReader.Result(channels: channels, sampleRate: sampleRate)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `( cd swift/ltx-video-director && swift test --filter VideoAudioReaderTests )`
Expected: PASS (2/2 tests).

- [ ] **Step 5: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirector/VideoAudioReader.swift swift/ltx-video-director/Tests/LTXVideoDirectorTests/VideoAudioReaderTests.swift
git commit -m "feat(ltx-video-director): add VideoAudioReader to extract audio from a video file's own track"
```

---

## Task 3: `NativeUpscaleStage.generateLipdub` — two-stage engine method

**Files:**
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirector/NativeUpscaleStage.swift`
- Test: `swift/ltx-video-director/Tests/LTXVideoDirectorTests/NativeUpscaleStageRealCheckpointTests.swift`

- [ ] **Step 1: Write the failing tests**

Append to `swift/ltx-video-director/Tests/LTXVideoDirectorTests/NativeUpscaleStageRealCheckpointTests.swift` (inside the existing `NativeUpscaleStageRealCheckpointTests` class, alongside the other `testGenerateIngredients...` tests):

```swift
    func testGenerateLipdubMissingReferenceVideoThrowsNamedError() throws {
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_lipdub_out_\(UUID().uuidString)")
        let missingVideoURL = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).mp4")
        let missingLoraURL = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).safetensors")
        defer { try? FileManager.default.removeItem(at: outputDir) }

        XCTAssertThrowsError(try NativeUpscaleStage().generateLipdub(
            referenceVideoURL: missingVideoURL, outputDir: outputDir, prompt: "a test prompt",
            loraURL: missingLoraURL, width: 64, height: 64)
        ) { error in
            guard let stageError = error as? NativeUpscaleStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .referenceVideoNotFound(let url) = stageError {
                XCTAssertEqual(url, missingVideoURL)
            } else {
                XCTFail("expected .referenceVideoNotFound, got \(stageError)")
            }
        }
    }

    func testGenerateLipdubMissingLoraThrowsNamedError() throws {
        let frameDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_lipdub_ref_frames_\(UUID().uuidString)")
        let referenceVideoURL = FileManager.default.temporaryDirectory.appendingPathComponent("native_lipdub_ref_\(UUID().uuidString).mp4")
        let wavURL = FileManager.default.temporaryDirectory.appendingPathComponent("native_lipdub_ref_\(UUID().uuidString).wav")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_lipdub_out_\(UUID().uuidString)")
        let missingLoraURL = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).safetensors")
        defer {
            try? FileManager.default.removeItem(at: frameDir)
            try? FileManager.default.removeItem(at: referenceVideoURL)
            try? FileManager.default.removeItem(at: wavURL)
            try? FileManager.default.removeItem(at: outputDir)
        }
        try WAVWriter.write(channels: [[0.1, 0.2, 0.1], [0.1, 0.2, 0.1]], sampleRate: 16000, to: wavURL)
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 9, 64, 64], key: MLXRandom.key(11)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: frameDir)
        try MP4Writer.write(frameDirectory: frameDir, audioURL: wavURL, fps: 24.0, to: referenceVideoURL)

        XCTAssertThrowsError(try NativeUpscaleStage().generateLipdub(
            referenceVideoURL: referenceVideoURL, outputDir: outputDir, prompt: "a test prompt",
            loraURL: missingLoraURL, width: 64, height: 64)
        ) { error in
            guard let stageError = error as? NativeUpscaleStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .lipdubLoraNotFound(let url) = stageError {
                XCTAssertEqual(url, missingLoraURL)
            } else {
                XCTFail("expected .lipdubLoraNotFound, got \(stageError)")
            }
        }
    }

    func testGenerateLipdubReferenceVideoNoAudioThrowsNamedError() throws {
        let frameDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_lipdub_silent_frames_\(UUID().uuidString)")
        let referenceVideoURL = FileManager.default.temporaryDirectory.appendingPathComponent("native_lipdub_silent_\(UUID().uuidString).mp4")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_lipdub_out_\(UUID().uuidString)")
        let loraURL = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).safetensors")
        defer {
            try? FileManager.default.removeItem(at: frameDir)
            try? FileManager.default.removeItem(at: referenceVideoURL)
            try? FileManager.default.removeItem(at: outputDir)
        }
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 9, 64, 64], key: MLXRandom.key(13)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: frameDir)
        try MP4Writer.write(frameDirectory: frameDir, audioURL: nil, fps: 24.0, to: referenceVideoURL)

        XCTAssertThrowsError(try NativeUpscaleStage().generateLipdub(
            referenceVideoURL: referenceVideoURL, outputDir: outputDir, prompt: "a test prompt",
            loraURL: loraURL, width: 64, height: 64)
        ) { error in
            guard let stageError = error as? NativeUpscaleStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .referenceVideoNoAudioTrack(let url) = stageError {
                XCTAssertEqual(url, referenceVideoURL)
            } else {
                XCTFail("expected .referenceVideoNoAudioTrack, got \(stageError)")
            }
        }
    }

    func testGenerateLipdubProducesRealOutput() throws {
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        let vaeDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        let upsamplerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors")
        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        let audioURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        let vocoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/vocoder.safetensors")
        let loraURL = RepoPaths.mlxModelsRoot.appendingPathComponent("lora/ltx-2-3-lipdub/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors")
        for url in [vaeEncoderURL, vaeDecoderURL, upsamplerURL, transformerURL, audioURL, vocoderURL, loraURL] {
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw XCTSkip("checkpoint not found at \(url.path) — skipping integration smoke test")
            }
        }

        let frameDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_lipdub_smoke_frames_\(UUID().uuidString)")
        let referenceVideoURL = FileManager.default.temporaryDirectory.appendingPathComponent("native_lipdub_smoke_ref_\(UUID().uuidString).mp4")
        let wavURL = FileManager.default.temporaryDirectory.appendingPathComponent("native_lipdub_smoke_ref_\(UUID().uuidString).wav")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_lipdub_smoke_out_\(UUID().uuidString)")
        defer {
            try? FileManager.default.removeItem(at: frameDir)
            try? FileManager.default.removeItem(at: referenceVideoURL)
            try? FileManager.default.removeItem(at: wavURL)
            try? FileManager.default.removeItem(at: outputDir)
        }

        let sampleRate = 16000
        let sineCount = sampleRate / 2
        var sine = [Float](repeating: 0, count: sineCount)
        for i in 0..<sineCount { sine[i] = 0.2 * sin(2.0 * Float.pi * 220.0 * Float(i) / Float(sampleRate)) }
        try WAVWriter.write(channels: [sine, sine], sampleRate: sampleRate, to: wavURL)

        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 9, 64, 64], key: MLXRandom.key(23)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: frameDir)
        try MP4Writer.write(frameDirectory: frameDir, audioURL: wavURL, fps: 24.0, to: referenceVideoURL)

        let result = try NativeUpscaleStage().generateLipdub(
            referenceVideoURL: referenceVideoURL, outputDir: outputDir, prompt: "a person speaking to the camera",
            loraURL: loraURL, width: 64, height: 64, seed: 42)

        XCTAssertGreaterThan(result.frameCount, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.audioURL.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.frameDirectory.appendingPathComponent("frame_0000.png").path))
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `( cd swift/ltx-video-director && swift build 2>&1 | tail -30 )`
Expected: FAIL to compile — `generateLipdub`, `StageError.referenceVideoNotFound`/`.lipdubLoraNotFound`/`.referenceVideoNoAudioTrack`, and `LipdubResult` don't exist yet.

- [ ] **Step 3: Add new `StageError` cases and `LipdubResult`**

In `swift/ltx-video-director/Sources/LTXVideoDirector/NativeUpscaleStage.swift`, add three new cases to `StageError` (in the `enum StageError` block starting at line 44, after `case noReferenceImages`):

```swift
        case referenceVideoNotFound(URL)
        case referenceVideoNoAudioTrack(URL)
        case lipdubLoraNotFound(URL)
```

And their descriptions (in the `switch self` block, after the `.noReferenceImages` case):

```swift
            case .referenceVideoNotFound(let url): return "NativeUpscaleStage: lipdub reference video not found at \(url.path)"
            case .referenceVideoNoAudioTrack(let url): return "NativeUpscaleStage: lipdub reference video has no audio stream (LipDub needs the target speech from the reference) at \(url.path)"
            case .lipdubLoraNotFound(let url): return "NativeUpscaleStage: LipDub IC-LoRA not found at \(url.path) — download Lightricks/LTX-2.3-22b-IC-LoRA-LipDub from HuggingFace (HF-gated) and pass its path via --lora"
```

Add `LipdubResult` next to `IngredientsResult` (after its closing `}` around line 142):

```swift

    /// `generateLipdub`'s own result type — same shape as `IngredientsResult`
    /// plus `fps` (derived from the reference video, not caller-supplied, so
    /// callers muxing an mp4 afterward need it back).
    public struct LipdubResult {
        public let frameDirectory: URL
        public let frameCount: Int
        public let outputSize: (width: Int, height: Int)
        public let audioURL: URL
        public let fps: Double
    }
```

- [ ] **Step 4: Implement `generateLipdub`**

Append the following method to `NativeUpscaleStage` (after `generateIngredients`'s closing `}`, before the private `distilledConfig` helper):

```swift
    /// `native-lipdub`: reference-video lip-dubbing via the LipDub IC-LoRA —
    /// port of Python's `video lipdub` (`app/commands/video-lipdub.py` +
    /// `ltx_pipelines_mlx.lipdub.LipDubPipeline`). The reference video
    /// supplies BOTH the visual structure (IC-LoRA video-reference
    /// conditioning, reapplied at both stages, LoRA fused through both) and
    /// the target speech (its own audio track, reference-conditioned via
    /// the new `AudioConditionByReferenceLatent`, frozen after stage 1).
    /// See docs/superpowers/specs/2026-07-26-swift-lipdub-port-design.md for
    /// the full architecture discovery — this is NOT a composition of
    /// `generateHD`+`refine()` (neither of those reapplies LoRA/reference
    /// conditioning at their second stage the way LipDub genuinely needs).
    ///
    /// Frame count is derived from the reference video itself (snapped down
    /// to the nearest 8k+1), not user-specified. Width/height are snapped to
    /// the nearest multiple of 64 (not just 32, unlike `ResolutionResolver
    /// .optimize`) so that `width/2`/`height/2` stay valid 32-multiple VAE
    /// resolutions for stage 1.
    public func generateLipdub(
        referenceVideoURL: URL, outputDir: URL, prompt: String,
        loraURL: URL, width: Int = 640, height: Int = 960,
        referenceStrength: Float = 1.0, loraStrength: Float = 1.0,
        textMaxLength: Int = 128, seed: UInt64 = 42
    ) throws -> LipdubResult {
        let fm = FileManager.default
        guard fm.fileExists(atPath: referenceVideoURL.path) else {
            throw StageError.referenceVideoNotFound(referenceVideoURL)
        }
        // Audio-track check BEFORE the LoRA check — matches Python's
        // run_lipdub() order (app/commands/video-lipdub.py): the reference
        // video's own audio is the more fundamental precondition (LipDub's
        // whole premise), so it's validated first regardless of whether a
        // LoRA path was even supplied correctly.
        let referenceInfo = try VideoProbe.info(url: referenceVideoURL)
        guard referenceInfo.hasAudioTrack else {
            throw StageError.referenceVideoNoAudioTrack(referenceVideoURL)
        }
        guard fm.fileExists(atPath: loraURL.path) else {
            throw StageError.lipdubLoraNotFound(loraURL)
        }
        guard width > 0, height > 0 else {
            throw StageError.invalidDimensions("width/height must be positive, got \(width)x\(height)")
        }

        func snapTo64(_ v: Int) -> Int { max(64, Int((Double(v) / 64.0).rounded()) * 64) }
        let outW = snapTo64(width), outH = snapTo64(height)
        let halfW = outW / 2, halfH = outH / 2

        let fps = referenceInfo.fps
        let rawFrameCount = referenceInfo.frameCount
        let numFrames = max(1, ((rawFrameCount - 1) / 8) * 8 + 1)
        print("[1/8] Reference video: \(rawFrameCount) frames at \(fps) fps -> \(numFrames) frames (8k+1 snap)")

        print("[2/8] VideoAudioReader: extracting reference video's own audio track...")
        let refWav = try VideoAudioReader.read(url: referenceVideoURL)
        var refChannels = refWav.channels
        if refChannels.count == 1 { refChannels = [refChannels[0], refChannels[0]] }
        refChannels = Array(refChannels.prefix(2))
        let refResampled = refChannels.map { LinearResampler.resample($0, fromRate: refWav.sampleRate, toRate: 16000) }
        let refMinLen = refResampled.map(\.count).min() ?? 0
        let refWaveform = MLX.stacked(refResampled.map { MLXArray($0.prefix(refMinLen)) }, axis: 0)  // (2, T)

        let audioEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        guard fm.fileExists(atPath: audioEncoderURL.path) else {
            throw StageError.audioEncoderCheckpointNotFound(audioEncoderURL)
        }
        let audioEncoder = try AudioVAEEncoderLoader.loadReal(checkpointURL: audioEncoderURL)
        let refMel = AudioProcessor().waveformToMel(refWaveform).expandedDimensions(axis: 0)  // (1, 2, T', 64)
        let refAudioLatent = audioEncoder(refMel)  // (1, 8, T, 16)
        MLX.eval(refAudioLatent)
        let (refAudioTokens, refAudioTokenCount) = AudioPatchifier.patchify(refAudioLatent)
        let refAudioPositionsRaw = Positions.computeAudioPositions(numTokens: refAudioTokenCount)
        let audioRefCond = AudioConditionByReferenceLatent(
            referenceLatent: refAudioTokens, referencePositions: refAudioPositionsRaw,
            strength: 1.0, negativePositions: true)

        print("[3/8] VideoEncoder: loading (reused across both stages)...")
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

        print("[4/8] LoRA + transformer: loading LipDub IC-LoRA (fused for both stages)...")
        let loraSources: [(weights: LoRAWeights, strength: Float)] = [
            (weights: try LoRAWeights.load(url: loraURL), strength: loraStrength),
        ]

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
        let blockProvider: (Int) -> BasicAVTransformerBlock = { idx in
            TransformerCheckpointLoader.makeBlock(
                TransformerCheckpointLoader.blockWeights(raw: strippedTransformer, blockIndex: idx, loraSources: loraSources),
                config: cfg)
        }

        // ===== Stage 1 (half-res) =====
        print("[5/8] Stage 1: half-res (\(halfW)x\(halfH)) IC-LoRA reference-conditioned denoise...")
        let stage1Pixels = try loadReferenceVideoFrames(url: referenceVideoURL, numFrames: numFrames, width: halfW, height: halfH)
        let stage1RefLatentRaw = videoEncoder(stage1Pixels)
        MLX.eval(stage1RefLatentRaw)
        let (stage1RefTokens, stage1Dims) = VideoLatentPatchifier.patchify(stage1RefLatentRaw)
        let stage1Positions = Positions.computeVideoPositions(numFrames: stage1Dims.f, height: stage1Dims.h, width: stage1Dims.w, frameRate: Float(fps))
        let stage1GenTokenCount = stage1Dims.f * stage1Dims.h * stage1Dims.w

        let stage1Noise = MLXRandom.normal([1, stage1GenTokenCount, 128], key: MLXRandom.key(seed))
        let stage1BaseVideoState = LatentState(
            latent: stage1Noise, cleanLatent: MLXArray.zeros([1, stage1GenTokenCount, 128]),
            denoiseMask: MLXArray.ones([1, stage1GenTokenCount, 1]), positions: stage1Positions)
        let stage1VideoState = VideoConditionByReferenceLatent(
            referenceLatent: stage1RefTokens, referencePositions: stage1Positions,
            downscaleFactor: 1, strength: referenceStrength
        ).apply(to: stage1BaseVideoState)

        let stage1AudioNoise = MLXRandom.normal([1, refAudioTokenCount, 128], key: MLXRandom.key(seed &+ 1))
        let stage1BaseAudioState = LatentState(
            latent: stage1AudioNoise, cleanLatent: MLXArray.zeros([1, refAudioTokenCount, 128]),
            denoiseMask: MLXArray.ones([1, refAudioTokenCount, 1]),
            positions: Positions.computeAudioPositions(numTokens: refAudioTokenCount))
        let stage1AudioState = audioRefCond.apply(to: stage1BaseAudioState)

        let stage1Result = DenoiseLoop.runStreaming(
            model: model, numLayers: numLayers, blockProvider: blockProvider,
            videoState: stage1VideoState, audioState: stage1AudioState,
            videoTextEmbeds: textResult.videoEmbeds, audioTextEmbeds: textResult.audioEmbeds,
            sigmas: SigmaSchedule.distilledSigmas)
        MLX.eval(stage1Result.videoLatent, stage1Result.audioLatent)

        let stage1GenVideoTokens = stage1Result.videoLatent[0..., 0..<stage1GenTokenCount, 0...]
        let stage1AudioOutputTokens = stage1Result.audioLatent[0..., 0..<refAudioTokenCount, 0...]

        // ===== Upscale =====
        print("[6/8] LatentUpsampler: 2x spatial upscale...")
        let upsamplerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors")
        guard fm.fileExists(atPath: upsamplerURL.path) else {
            throw StageError.upsamplerCheckpointNotFound(upsamplerURL)
        }
        let upRaw = try MLX.loadArrays(url: upsamplerURL)
        let upPrefix = "spatial_upscaler_x2_v1_1."
        var upWeights: [String: MLXArray] = [:]
        for (key, value) in upRaw {
            let stripped = key.hasPrefix(upPrefix) ? String(key.dropFirst(upPrefix.count)) : key
            upWeights[stripped] = value.asType(.float32)
        }
        let upsampler = LatentUpsampler(weights: upWeights)

        let stage1VideoLatent = VideoLatentPatchifier.unpatchify(stage1GenVideoTokens, dims: stage1Dims)
        let meanC = videoEncoder.meanOfMeans.reshaped([1, -1, 1, 1, 1])
        let stdC = videoEncoder.stdOfMeans.reshaped([1, -1, 1, 1, 1])
        let denormLatent = stage1VideoLatent * stdC + meanC
        let upscaledDenorm = upsampler(denormLatent)
        let upscaledLatent = (upscaledDenorm - meanC) / stdC
        MLX.eval(upscaledLatent)

        // ===== Stage 2 (full-res) =====
        print("[7/8] Stage 2: full-res (\(outW)x\(outH)) IC-LoRA reference-conditioned refine, audio frozen...")
        let stage2Pixels = try loadReferenceVideoFrames(url: referenceVideoURL, numFrames: numFrames, width: outW, height: outH)
        let stage2RefLatentRaw = videoEncoder(stage2Pixels)
        MLX.eval(stage2RefLatentRaw)
        let (stage2RefTokens, stage2Dims) = VideoLatentPatchifier.patchify(stage2RefLatentRaw)
        let stage2Positions = Positions.computeVideoPositions(numFrames: stage2Dims.f, height: stage2Dims.h, width: stage2Dims.w, frameRate: Float(fps))
        let stage2GenTokenCount = stage2Dims.f * stage2Dims.h * stage2Dims.w

        let (stage2VideoTokensUp, upDims) = VideoLatentPatchifier.patchify(upscaledLatent)
        guard upDims.f == stage2Dims.f, upDims.h == stage2Dims.h, upDims.w == stage2Dims.w else {
            throw StageError.invalidDimensions("upscaled latent dims \(upDims) do not match stage-2 reference dims \(stage2Dims) — width/height must be a multiple of 64")
        }

        let sigmas2 = SigmaSchedule.stage2Sigmas
        let startSigma2 = sigmas2[0]
        let stage2VideoNoise = MLXRandom.normal(stage2VideoTokensUp.shape, key: MLXRandom.key(seed &+ 2))
        let stage2NoisyVideoTokens = (1 - startSigma2) * stage2VideoTokensUp + startSigma2 * stage2VideoNoise
        let stage2BaseVideoState = LatentState(
            latent: stage2NoisyVideoTokens, cleanLatent: stage2NoisyVideoTokens,
            denoiseMask: MLXArray.ones([1, stage2GenTokenCount, 1]), positions: stage2Positions)
        let stage2VideoState = VideoConditionByReferenceLatent(
            referenceLatent: stage2RefTokens, referencePositions: stage2Positions,
            downscaleFactor: 1, strength: referenceStrength
        ).apply(to: stage2BaseVideoState)

        // Audio frozen through stage 2: sigma=0 (no-op Euler steps) starting
        // from stage 1's own audio output — matches Python's frozen=True.
        let stage2BaseAudioState = LatentState(
            latent: stage1AudioOutputTokens, cleanLatent: stage1AudioOutputTokens,
            denoiseMask: MLXArray.zeros([1, refAudioTokenCount, 1]),
            positions: Positions.computeAudioPositions(numTokens: refAudioTokenCount))
        let stage2AudioState = audioRefCond.apply(to: stage2BaseAudioState)

        let stage2Result = DenoiseLoop.runStreaming(
            model: model, numLayers: numLayers, blockProvider: blockProvider,
            videoState: stage2VideoState, audioState: stage2AudioState,
            videoTextEmbeds: textResult.videoEmbeds, audioTextEmbeds: textResult.audioEmbeds,
            sigmas: sigmas2)
        MLX.eval(stage2Result.videoLatent)

        let stage2GenVideoTokens = stage2Result.videoLatent[0..., 0..<stage2GenTokenCount, 0...]
        let finalVideoLatent = VideoLatentPatchifier.unpatchify(stage2GenVideoTokens, dims: stage2Dims)

        print("[8/8] Decoding: video from stage 2, audio from stage 1 (frozen, not re-denoised)...")
        let videoDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        guard fm.fileExists(atPath: videoDecoderURL.path) else {
            throw StageError.videoDecoderCheckpointNotFound(videoDecoderURL)
        }
        let videoDecoder = try VideoDecoderLoader.loadReal(checkpointURL: videoDecoderURL)
        let pixels = videoDecoder(finalVideoLatent.asType(.float32))
        MLX.eval(pixels)

        let frameDir = outputDir.appendingPathComponent("frames")
        let frameCount = try PNGFrameWriter.writeFrames(pixels, to: frameDir)

        let audioLatentB8T16 = AudioPatchifier.unpatchify(stage1AudioOutputTokens)
        let audioDecoder = try AudioVAEDecoderLoader.loadReal(checkpointURL: audioEncoderURL)
        let decodedMel = audioDecoder(audioLatentB8T16.asType(.float32))
        MLX.eval(decodedMel)

        let vocoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/vocoder.safetensors")
        let vocoder = try VocoderWithBWELoader.loadReal(checkpointURL: vocoderURL)
        let outWaveform = vocoder(decodedMel)
        MLX.eval(outWaveform)

        let numOutChannels = outWaveform.dim(1)
        var outChannels: [[Float]] = []
        for c in 0..<numOutChannels {
            outChannels.append(outWaveform[0, c, 0...].asArray(Float.self))
        }
        let audioOutURL = outputDir.appendingPathComponent("audio.wav")
        try WAVWriter.write(channels: outChannels, sampleRate: 48000, to: audioOutURL)

        return LipdubResult(frameDirectory: frameDir, frameCount: frameCount, outputSize: (outW, outH), audioURL: audioOutURL, fps: fps)
    }

    /// Extracts exactly `numFrames` frames from `url` (spaced by `1/fps`,
    /// the video's own frame rate), resized to `(width, height)` — the
    /// reference-video counterpart to `generateRestyle`'s PNG-directory
    /// loading loop, sourcing frames directly from an mp4 instead.
    private func loadReferenceVideoFrames(url: URL, numFrames: Int, width: Int, height: Int) throws -> MLXArray {
        let info = try VideoProbe.info(url: url)
        var frameArrays: [MLXArray] = []
        frameArrays.reserveCapacity(numFrames)
        for i in 0..<numFrames {
            let t = info.fps > 0 ? Double(i) / info.fps : 0
            let clampedT = min(t, max(0, info.duration - 0.001))
            let cgImage = try VideoProbe.frame(url: url, at: clampedT)
            let resized = (cgImage.width != width || cgImage.height != height)
                ? FrameLoad.resizeAspectFillCenterCrop(cgImage, targetWidth: width, targetHeight: height)
                : cgImage
            frameArrays.append(FrameLoad.toArray(resized))  // (1, 3, H, W) [0, 1]
        }
        let stacked = MLX.stacked(frameArrays.map { $0[0] }, axis: 1)  // (3, F, H, W)
        return (stacked.asType(.float32) * 2.0 - 1.0).expandedDimensions(axis: 0)  // (1, 3, F, H, W) [-1, 1]
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `( cd swift/ltx-video-director && swift build 2>&1 | tail -30 )`
Expected: builds with 0 errors.

Run: `( cd swift/ltx-video-director && swift test --filter NativeUpscaleStageRealCheckpointTests )`
Expected: the 3 new fast guard tests PASS. `testGenerateLipdubProducesRealOutput` either PASSES (if all 7 checkpoints are present locally — they are, per the design doc's Background section) or SKIPS with a clear message (never FAILs silently).

- [ ] **Step 6: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirector/NativeUpscaleStage.swift swift/ltx-video-director/Tests/LTXVideoDirectorTests/NativeUpscaleStageRealCheckpointTests.swift
git commit -m "feat(ltx-video-director): add NativeUpscaleStage.generateLipdub two-stage engine method"
```

---

## Task 4: `native-lipdub` CLI command

**Files:**
- Create: `swift/ltx-video-director/Sources/LTXVideoDirectorCLI/NativeLipdubCommand.swift`
- Modify: `swift/ltx-video-director/Sources/LTXVideoDirectorCLI/LTXVideoDirectorCLI.swift:43`

- [ ] **Step 1: Create the CLI command**

Create `swift/ltx-video-director/Sources/LTXVideoDirectorCLI/NativeLipdubCommand.swift`:

```swift
//
//  NativeLipdubCommand.swift
//  LTXVideoDirectorCLI
//
//  `ltx-video native-lipdub` — reference-video lip-dubbing via the LipDub
//  IC-LoRA, fully native (no run.py). Port of Python's `video lipdub`
//  (app/commands/video-lipdub.py) — see NativeUpscaleStage.generateLipdub's
//  header and docs/superpowers/specs/2026-07-26-swift-lipdub-port-design.md.
//

import ArgumentParser
import Foundation
import LTXVideoDirector

struct NativeLipdub: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "native-lipdub",
        abstract: "Re-sync a reference video's mouth to its own audio track 100% natively (no run.py) via a user-supplied LipDub IC-LoRA adapter."
    )

    @Option(name: .customLong("reference-video"), help: "Reference talking-head video (supplies visual structure + target speech audio). Must contain an audio stream.")
    var referenceVideo: String

    @Option(name: .shortAndLong, help: "Output directory (frames/ subdirectory holds the generated PNG sequence, audio.wav holds generated audio).")
    var output: String = "native_lipdub_output"

    @Option(help: "Generation prompt describing the target scene.")
    var prompt: String

    @Option(help: "Path to the LipDub IC-LoRA .safetensors checkpoint (e.g. Lightricks/LTX-2.3-22b-IC-LoRA-LipDub's ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors). No bundled default.")
    var lora: String

    @Option(name: .customLong("lora-strength"), help: "Fusion strength for --lora.")
    var loraStrength: Float = 1.0

    @Option(name: .customLong("reference-strength"), help: "IC-LoRA reference-video conditioning strength (applied at both stages).")
    var referenceStrength: Float = 1.0

    @Option(help: "Output width (snapped to a multiple of 64 — stage 1 runs at width/2).")
    var width: Int = 640

    @Option(help: "Output height (snapped to a multiple of 64 — stage 1 runs at height/2).")
    var height: Int = 960

    @Option(help: "Random seed for the denoise passes.")
    var seed: UInt64 = 42

    @Flag(name: .customLong("mp4"), inversion: .prefixedNo,
          help: "Mux the generated PNG frame sequence + generated audio into a real H.264+AAC output.mp4 via AVAssetWriter. On by default.")
    var mp4: Bool = true

    func run() throws {
        let stage = NativeUpscaleStage()
        let wallStart = Date()

        print("→ native lipdub (no run.py): reference=\(referenceVideo) [lora=\(lora)]")
        let result = try stage.generateLipdub(
            referenceVideoURL: URL(fileURLWithPath: referenceVideo),
            outputDir: URL(fileURLWithPath: output),
            prompt: prompt, loraURL: URL(fileURLWithPath: lora),
            width: width, height: height,
            referenceStrength: referenceStrength, loraStrength: loraStrength,
            seed: seed)
        let wallSeconds = Date().timeIntervalSince(wallStart)

        print("\n✅ wall time: \(String(format: "%.1f", wallSeconds))s")
        print("   \(result.outputSize.width)x\(result.outputSize.height) @ \(result.fps)fps")
        print("   \(result.frameCount) frames: \(result.frameDirectory.path)")
        print("   audio: \(result.audioURL.path)")
        print("   100% native Swift/MLX — zero run.py calls.")

        guard mp4 else { return }
        let mp4URL = URL(fileURLWithPath: output).appendingPathComponent("video.mp4")
        do {
            try MP4Writer.write(frameDirectory: result.frameDirectory, audioURL: result.audioURL, fps: result.fps, to: mp4URL)
            print("\n[mp4] muxed: \(mp4URL.path)")
        } catch {
            print("⚠️  mp4 mux failed, PNG frame sequence above is still valid: \(error)")
        }
    }
}
```

- [ ] **Step 2: Register the command**

In `swift/ltx-video-director/Sources/LTXVideoDirectorCLI/LTXVideoDirectorCLI.swift:43`, add `NativeLipdub.self` to the `subcommands` array:

```swift
        subcommands: [I2V.self, NativeI2V.self, NativeRelay.self, NativeStoryboard.self, NativeT2A.self, Vbvr.self, Gate.self, AsrGate.self, Review.self, Compare.self, Quality.self, Verify.self, Upscale.self, NativeUpscale.self, NativeRestyle.self, NativeIngredients.self, NativeLipdub.self, Models.self, AudioDecode.self, VideoDecode.self, T2I.self, Segment.self, Transcribe.self, LipsyncMetricsCommand.self]
```

- [ ] **Step 3: Build and smoke-test `--help`**

Run: `( cd swift/ltx-video-director && swift build 2>&1 | tail -30 )`
Expected: builds with 0 errors.

Run: `( cd swift/ltx-video-director && swift run -c release ltx-video native-lipdub --help )`
Expected: prints the command's usage/options list, including `--reference-video`, `--prompt`, `--lora`, `--reference-strength`, `--lora-strength`, `--width`, `--height`, `--seed`, `--mp4`/`--no-mp4`.

- [ ] **Step 4: Commit**

```bash
git add swift/ltx-video-director/Sources/LTXVideoDirectorCLI/NativeLipdubCommand.swift swift/ltx-video-director/Sources/LTXVideoDirectorCLI/LTXVideoDirectorCLI.swift
git commit -m "feat(ltx-video-director): add native-lipdub CLI command"
```

---

## Task 5: Phase 1 empirical verification + capability matrix update

**Files:**
- Modify: `docs/openmontage-capability-matrix.md` (`lip_sync` row)

This task is manual generation + measurement, not code — run directly (not via a subagent), same as the multi-reference-ingredients plan's empirical-test task.

- [ ] **Step 1: Generate (or reuse) a real ~8s talking-head reference clip with a genuine speech audio track**

If a suitable reference clip already exists on disk from a prior session's LipDub/IA2V measurement, reuse it. Otherwise generate one the same way prior matrix entries did: a Z-Image portrait animated to a short IA2V clip, or `native-i2v --input-image PORTRAIT.png --audio-track SPEECH.wav`, muxed to mp4.

- [ ] **Step 2: Run `native-lipdub` against it**

```bash
( cd swift/ltx-video-director && swift run -c release ltx-video native-lipdub \
    --reference-video /path/to/reference_8s.mp4 \
    --prompt "a person speaking to the camera, natural lip motion" \
    --lora mlx-models/lora/ltx-2-3-lipdub/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors \
    --width 512 --height 512 \
    --output /tmp/native_lipdub_test )
```

- [ ] **Step 3: Recreate `python/sync-venv` if missing, then measure**

```bash
ls python/sync-venv/bin/python 2>/dev/null || uv venv python/sync-venv --python 3.12
# install the same deps app/syncnet_bridge.py's header/README documents (SyncNet + its torch/numpy deps)
python/sync-venv/bin/python python/mlx-movie-director/app/syncnet_bridge.py /tmp/native_lipdub_test/video.mp4
```

Record the reported LSE-D / LSE-C / AV-offset.

- [ ] **Step 4: Update the capability matrix**

Append a new dated paragraph to the `lip_sync` row in `docs/openmontage-capability-matrix.md`, in the same evidence-first style as the row's existing entries: exact command run, exact measured LSE-D/LSE-C/offset, and an honest verdict comparing against the existing table (Python LipDub CelebV-HQ 12.63/2.068/converges, TalkVid 13.13/2.003/−1, Python IA2V 16.8+/no convergence, Swift `--audio-track` 15.66/1.011/no convergence). State plainly whether Phase 2 (pipeline wiring) is or isn't warranted per the design doc's gate — do not soften a negative result.

- [ ] **Step 5: Commit**

```bash
git add docs/openmontage-capability-matrix.md
git commit -m "docs(planning): record Swift LipDub port Phase 1 empirical result"
```

---
