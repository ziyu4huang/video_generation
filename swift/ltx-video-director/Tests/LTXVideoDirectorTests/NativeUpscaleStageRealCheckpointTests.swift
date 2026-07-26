import XCTest
import MLX
@testable import LTXVideoDirector

/// Integration smoke test for NativeUpscaleStage: VideoEncoder -> denormalize
/// -> LatentUpsampler -> renormalize -> VideoDecoder -> PNG frames, all real
/// checkpoints, no run.py. Builds its own tiny synthetic input frame sequence
/// (doesn't depend on native-i2v having run first) by writing solid-color
/// PNGs directly. Skips gracefully if any checkpoint is missing.
final class NativeUpscaleStageRealCheckpointTests: XCTestCase {
    func testGenerateProducesDoubledResolutionFrames() throws {
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        let vaeDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        let upsamplerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors")
        for url in [vaeEncoderURL, vaeDecoderURL, upsamplerURL] {
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw XCTSkip("checkpoint not found at \(url.path) — skipping integration smoke test")
            }
        }

        let inputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_input_\(UUID().uuidString)")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_output_\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: inputDir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: inputDir)
            try? FileManager.default.removeItem(at: outputDir)
        }

        // 9 frames (8k+1) of tiny 64x64 synthetic pixel noise, written as a
        // real PNG sequence via PNGFrameWriter (same writer native-i2v uses)
        // so this test exercises the actual FrameLoad.loadCGImage read path.
        let key = MLXRandom.key(7)
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 9, 64, 64], key: key).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: inputDir)

        let stage = NativeUpscaleStage()
        let result = try stage.generate(inputFrameDirectory: inputDir, outputDir: outputDir)

        XCTAssertEqual(result.inputSize.width, 64)
        XCTAssertEqual(result.inputSize.height, 64)
        XCTAssertEqual(result.outputSize.width, 128)
        XCTAssertEqual(result.outputSize.height, 128)
        XCTAssertEqual(result.frameCount, 9)

        let frameFiles = (try? FileManager.default.contentsOfDirectory(atPath: result.frameDirectory.path)) ?? []
        XCTAssertEqual(frameFiles.count, 9)

        guard let firstFrame = FrameLoad.loadCGImage(from: result.frameDirectory.appendingPathComponent("frame_0000.png")) else {
            XCTFail("failed to read back written frame")
            return
        }
        XCTAssertEqual(firstFrame.width, 128)
        XCTAssertEqual(firstFrame.height, 128)
    }

    /// End-to-end check that the optional refine pass (low-strength denoise
    /// after the neural upscale — see NativeUpscaleStage.swift's header)
    /// actually runs and changes the output vs. upscale-only, the same
    /// "prove it's wired, not silently skipped" bar
    /// NativeI2VStageAudioTrackTests uses for --audio-track.
    func testGenerateWithRefineProducesDifferentOutputThanUpscaleOnly() throws {
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        let vaeDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        let upsamplerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors")
        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        let audioVAEURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        for url in [vaeEncoderURL, vaeDecoderURL, upsamplerURL, transformerURL, audioVAEURL] {
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw XCTSkip("checkpoint not found at \(url.path) — skipping refine integration test")
            }
        }

        let inputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_refine_input_\(UUID().uuidString)")
        let baseOutputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_refine_base_\(UUID().uuidString)")
        let refineOutputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_refine_out_\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: inputDir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: inputDir)
            try? FileManager.default.removeItem(at: baseOutputDir)
            try? FileManager.default.removeItem(at: refineOutputDir)
        }

        let key = MLXRandom.key(11)
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 9, 64, 64], key: key).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: inputDir)

        let audioURL = inputDir.appendingPathComponent("audio.wav")
        let sampleCount = 16000
        var tone = [Float](repeating: 0, count: sampleCount)
        for i in 0..<sampleCount { tone[i] = Float(0.5 * sin(2.0 * Double.pi * 440.0 * Double(i) / 16000.0)) }
        try WAVWriter.write(channels: [tone, tone], sampleRate: 16000, to: audioURL)

        let baseResult = try NativeUpscaleStage().generate(inputFrameDirectory: inputDir, outputDir: baseOutputDir)
        let refineResult = try NativeUpscaleStage().generate(
            inputFrameDirectory: inputDir, outputDir: refineOutputDir,
            refinePrompt: "a woman smiles at the camera", refineAudioURL: audioURL)

        XCTAssertEqual(refineResult.outputSize.width, baseResult.outputSize.width)
        XCTAssertEqual(refineResult.outputSize.height, baseResult.outputSize.height)

        guard let baseFrame = FrameLoad.loadCGImage(from: baseResult.frameDirectory.appendingPathComponent("frame_0000.png")),
              let refineFrame = FrameLoad.loadCGImage(from: refineResult.frameDirectory.appendingPathComponent("frame_0000.png")) else {
            XCTFail("failed to read back written frames")
            return
        }
        let baseArr = FrameLoad.toArray(baseFrame)
        let refineArr = FrameLoad.toArray(refineFrame)
        let meanAbsDiff = MLX.abs(baseArr - refineArr).mean().item(Float.self)
        XCTAssertTrue(baseArr.asArray(Float.self).allSatisfy { $0.isFinite })
        XCTAssertTrue(refineArr.asArray(Float.self).allSatisfy { $0.isFinite })
        XCTAssertGreaterThan(meanAbsDiff, 1e-4, "refine pass should measurably change the upscaled output (mean abs diff \(meanAbsDiff)) — got near-identical output, refine may not be wired")
    }

    func testRefinePromptWithoutAudioThrowsClearError() throws {
        let inputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_refine_noaudio_\(UUID().uuidString)")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_refine_noaudio_out_\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: inputDir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: inputDir)
            try? FileManager.default.removeItem(at: outputDir)
        }
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 9, 64, 64], key: MLXRandom.key(3)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: inputDir)

        XCTAssertThrowsError(try NativeUpscaleStage().generate(
            inputFrameDirectory: inputDir, outputDir: outputDir, refinePrompt: "a prompt")
        ) { error in
            guard let stageError = error as? NativeUpscaleStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .refineNeedsAudioTrack = stageError {} else {
                XCTFail("expected .refineNeedsAudioTrack, got \(stageError)")
            }
        }
    }

    /// True N-stage cascade (docs/reference/comfyui_workflows/README.md's
    /// second pass, "True N-stage cascade" finding): a SECOND upscale+refine
    /// pass chained after the first, mirroring the reference 3-stage FFLF
    /// workflow's Stage #3. Uses `.x2Again` (reuses the already-verified x2
    /// checkpoint a second time) rather than `.x1_5` here since this test
    /// only needs to prove the CASCADE mechanism is wired — the x1_5
    /// checkpoint's own correctness has its own dedicated parity test
    /// (LatentUpsamplerX1_5RealCheckpointParityTests).
    func testGenerateWithSecondStageCascadeProducesQuadrupleResolution() throws {
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        let vaeDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        let upsamplerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors")
        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        let audioVAEURL = RepoPaths.mlxModelsRoot.appendingPathComponent("audio/ltx-2.3-audio/audio_vae.safetensors")
        for url in [vaeEncoderURL, vaeDecoderURL, upsamplerURL, transformerURL, audioVAEURL] {
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw XCTSkip("checkpoint not found at \(url.path) — skipping cascade integration test")
            }
        }

        let inputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_cascade_input_\(UUID().uuidString)")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_cascade_output_\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: inputDir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: inputDir)
            try? FileManager.default.removeItem(at: outputDir)
        }

        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 9, 64, 64], key: MLXRandom.key(13)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: inputDir)

        let audioURL = inputDir.appendingPathComponent("audio.wav")
        let sampleCount = 16000
        var tone = [Float](repeating: 0, count: sampleCount)
        for i in 0..<sampleCount { tone[i] = Float(0.5 * sin(2.0 * Double.pi * 440.0 * Double(i) / 16000.0)) }
        try WAVWriter.write(channels: [tone, tone], sampleRate: 16000, to: audioURL)

        let result = try NativeUpscaleStage().generate(
            inputFrameDirectory: inputDir, outputDir: outputDir,
            refinePrompt: "a woman smiles at the camera", refineAudioURL: audioURL,
            secondStage: .x2Again)

        XCTAssertEqual(result.inputSize.width, 64)
        XCTAssertEqual(result.inputSize.height, 64)
        // 2x (stage 1) * 2x (cascaded second stage) = 4x total.
        XCTAssertEqual(result.outputSize.width, 256)
        XCTAssertEqual(result.outputSize.height, 256)
        XCTAssertEqual(result.frameCount, 9)

        guard let firstFrame = FrameLoad.loadCGImage(from: result.frameDirectory.appendingPathComponent("frame_0000.png")) else {
            XCTFail("failed to read back written frame")
            return
        }
        XCTAssertEqual(firstFrame.width, 256)
        XCTAssertEqual(firstFrame.height, 256)
    }

    func testSecondStageWithoutRefineThrowsClearError() throws {
        let inputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_cascade_norefine_\(UUID().uuidString)")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_cascade_norefine_out_\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: inputDir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: inputDir)
            try? FileManager.default.removeItem(at: outputDir)
        }
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 9, 64, 64], key: MLXRandom.key(17)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: inputDir)

        XCTAssertThrowsError(try NativeUpscaleStage().generate(
            inputFrameDirectory: inputDir, outputDir: outputDir, secondStage: .x1_5)
        ) { error in
            guard let stageError = error as? NativeUpscaleStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .secondStageNeedsRefine = stageError {} else {
                XCTFail("expected .secondStageNeedsRefine, got \(stageError)")
            }
        }
    }

    /// `generateHD`'s restoration IC-LoRA files are user-downloaded,
    /// gitignored external binaries (see mlx-models/lora/ltx-2.3-restore/
    /// README.md) — not present in CI/dev environments without a manual
    /// download. This exercises the ONE path fully reachable without them:
    /// a clear, typed error naming the exact missing file, instead of a
    /// generic crash deep in LoRAWeights.load — the same contract every
    /// other checkpoint-gated stage in this package already guarantees
    /// (videoEncoderCheckpointNotFound, transformerCheckpointNotFound, etc).
    func testGenerateHDMissingLoraThrowsNamedError() throws {
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        guard FileManager.default.fileExists(atPath: vaeEncoderURL.path) else {
            throw XCTSkip("checkpoint not found at \(vaeEncoderURL.path) — skipping")
        }
        let restorationLoraURL = RepoPaths.mlxModelsRoot.appendingPathComponent("lora/ltx-2.3-restore/ltx2.3-video-restoration-general.safetensors")
        guard !FileManager.default.fileExists(atPath: restorationLoraURL.path) else {
            throw XCTSkip("restoration LoRA IS present in this environment — the missing-file path this test targets doesn't apply")
        }

        let inputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_hd_\(UUID().uuidString)")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_hd_out_\(UUID().uuidString)")
        let audioURL = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_hd_audio_\(UUID().uuidString).wav")
        try FileManager.default.createDirectory(at: inputDir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: inputDir)
            try? FileManager.default.removeItem(at: outputDir)
            try? FileManager.default.removeItem(at: audioURL)
        }
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 9, 64, 64], key: MLXRandom.key(11)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: inputDir)
        try WAVWriter.write(channels: [[Float](repeating: 0, count: 1600)], sampleRate: 16000, to: audioURL)

        XCTAssertThrowsError(try NativeUpscaleStage().generateHD(
            inputFrameDirectory: inputDir, outputDir: outputDir, prompt: "a test prompt", audioURL: audioURL)
        ) { error in
            guard let stageError = error as? NativeUpscaleStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .restorationLoraNotFound = stageError {} else {
                XCTFail("expected .restorationLoraNotFound, got \(stageError)")
            }
        }
    }

    /// Real-checkpoint SUCCESS path for `generateHD`, now that a working
    /// restoration+upscale IC-LoRA pair has been located and verified (a
    /// non-gated community release, `joyfox/LTX2.3-ICEdit-Insight` on
    /// HuggingFace — apache-2.0, exact filename match with this package's
    /// expected `ltx2.3-video-restoration-general.safetensors` /
    /// `ltx2.3-ic-video-upscale-general.safetensors`, unlike the earlier
    /// gated Lightricks official release). Two full sessions of prior
    /// search found no exact-match checkpoint at all; this closes that gap.
    /// Skips gracefully if the LoRA pair isn't present in this environment
    /// (still a manual/external download, per mlx-models/lora/ltx-2.3-restore/README.md).
    func testGenerateHDProducesRestoredUpscaledFrames() throws {
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        let vaeDecoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_decoder.safetensors")
        let upsamplerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/spatial_upscaler_x2_v1_1.safetensors")
        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        let restorationLoraURL = RepoPaths.mlxModelsRoot.appendingPathComponent("lora/ltx-2.3-restore/ltx2.3-video-restoration-general.safetensors")
        let upscaleLoraURL = RepoPaths.mlxModelsRoot.appendingPathComponent("lora/ltx-2.3-restore/ltx2.3-ic-video-upscale-general.safetensors")
        for url in [vaeEncoderURL, vaeDecoderURL, upsamplerURL, transformerURL, restorationLoraURL, upscaleLoraURL] {
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw XCTSkip("checkpoint/LoRA not found at \(url.path) — skipping generateHD real-checkpoint test")
            }
        }

        let inputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_hd_success_\(UUID().uuidString)")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_hd_success_out_\(UUID().uuidString)")
        let audioURL = FileManager.default.temporaryDirectory.appendingPathComponent("native_upscale_hd_success_audio_\(UUID().uuidString).wav")
        try FileManager.default.createDirectory(at: inputDir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: inputDir)
            try? FileManager.default.removeItem(at: outputDir)
            try? FileManager.default.removeItem(at: audioURL)
        }

        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 9, 64, 64], key: MLXRandom.key(13)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: inputDir)
        try WAVWriter.write(channels: [[Float](repeating: 0, count: 1600)], sampleRate: 16000, to: audioURL)

        let result = try NativeUpscaleStage().generateHD(
            inputFrameDirectory: inputDir, outputDir: outputDir, prompt: "a test scene", audioURL: audioURL)

        // generateHD is the RESTORATION pass only — same resolution in and
        // out. Chaining the separate fast-mode 2x upscale afterward (what
        // `native-upscale --mode hd` does at the CLI level) is a distinct
        // stage.generate() call, not part of generateHD itself.
        XCTAssertEqual(result.inputSize.width, 64)
        XCTAssertEqual(result.inputSize.height, 64)
        XCTAssertEqual(result.outputSize.width, 64)
        XCTAssertEqual(result.outputSize.height, 64)
        XCTAssertEqual(result.frameCount, 9)
        let frameFiles = (try? FileManager.default.contentsOfDirectory(atPath: result.frameDirectory.path)) ?? []
        XCTAssertEqual(frameFiles.count, 9)
    }

    /// `generateRestyle` (V2V restyle — see NativeUpscaleStage.swift's
    /// header) has NO bundled default LoRA at all, unlike `generateHD`'s
    /// restoration pair — `loraURL` is always user-supplied. This checks
    /// the same "named error, not a generic crash" contract for a
    /// definitely-nonexistent path, reachable in every environment (no
    /// checkpoint download needed to exercise this specific path).
    func testGenerateRestyleMissingLoraThrowsNamedError() throws {
        let inputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_restyle_\(UUID().uuidString)")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_restyle_out_\(UUID().uuidString)")
        let audioURL = FileManager.default.temporaryDirectory.appendingPathComponent("native_restyle_audio_\(UUID().uuidString).wav")
        let missingLoraURL = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).safetensors")
        try FileManager.default.createDirectory(at: inputDir, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: inputDir)
            try? FileManager.default.removeItem(at: outputDir)
            try? FileManager.default.removeItem(at: audioURL)
        }
        let pixels = MLXRandom.uniform(low: -1.0, high: 1.0, [1, 3, 9, 64, 64], key: MLXRandom.key(13)).asType(.float32)
        MLX.eval(pixels)
        _ = try PNGFrameWriter.writeFrames(pixels, to: inputDir)
        try WAVWriter.write(channels: [[Float](repeating: 0, count: 1600)], sampleRate: 16000, to: audioURL)

        XCTAssertThrowsError(try NativeUpscaleStage().generateRestyle(
            inputFrameDirectory: inputDir, outputDir: outputDir, prompt: "a test prompt",
            audioURL: audioURL, loraURL: missingLoraURL)
        ) { error in
            guard let stageError = error as? NativeUpscaleStage.StageError else {
                XCTFail("expected StageError, got \(error)"); return
            }
            if case .restyleLoraNotFound(let url) = stageError {
                XCTAssertEqual(url, missingLoraURL)
            } else {
                XCTFail("expected .restyleLoraNotFound, got \(stageError)")
            }
        }
    }

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
}
