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
}
