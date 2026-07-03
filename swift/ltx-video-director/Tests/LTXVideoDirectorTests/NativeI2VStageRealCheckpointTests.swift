import XCTest
import MLX
@testable import LTXVideoDirector

/// Integration smoke test for the full native I2V assembly: NativeT2IStage
/// -> VideoEncoder (conditioning) -> NativeTextEncodeStage ->
/// DenoiseLoop.runStreaming (real 48-block distilled transformer) ->
/// VideoDecoder + AudioVAEDecoder + VocoderWithBWE -> PNG frames + WAV.
/// Every piece has its own parity/real-checkpoint test already; this only
/// proves the ASSEMBLY runs to completion end-to-end with real production
/// checkpoints and produces a real, playable (frame sequence + WAV)
/// result — no run.py, no Python anywhere in this call chain. Smallest
/// possible request (single 8k+1 frame chunk, no VLM expansion) to keep
/// this from being a multi-minute test; still exercises all 48 real
/// transformer blocks x 8 real sigma steps. Skips gracefully if any of
/// the several checkpoints involved isn't present.
final class NativeI2VStageRealCheckpointTests: XCTestCase {
    func testGenerateProducesRealFramesAndAudio() throws {
        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        guard FileManager.default.fileExists(atPath: transformerURL.path) else {
            throw XCTSkip("real distilled transformer checkpoint not found — skipping integration smoke test")
        }
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        guard FileManager.default.fileExists(atPath: vaeEncoderURL.path) else {
            throw XCTSkip("real video VAE encoder checkpoint not found — skipping integration smoke test")
        }

        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_i2v_smoke_\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: outputDir) }

        let stage = NativeI2VStage()
        var request = NativeI2VStage.Request(prompt: "a woman smiles at the camera", seconds: 9.0 / 24.0, width: 320, height: 320, textMaxLength: 8)
        request.fps = 24.0

        let result = try stage.generate(request, outputDir: outputDir)

        XCTAssertTrue(FileManager.default.fileExists(atPath: result.sourceImageURL.path))
        XCTAssertGreaterThan(result.frameCount, 0)
        let frameFiles = (try? FileManager.default.contentsOfDirectory(atPath: result.frameDirectory.path)) ?? []
        XCTAssertEqual(frameFiles.count, result.frameCount)
        XCTAssertTrue(FileManager.default.fileExists(atPath: result.audioURL.path))

        let audioData = try Data(contentsOf: result.audioURL)
        XCTAssertGreaterThan(audioData.count, 44, "WAV file should have more than just the header")
    }

    /// A misaligned request (not a multiple of 32) must be auto-snapped by
    /// ResolutionResolver rather than rejected — see NativeI2VStage.generate's
    /// resolution-adjustment step. Reuses the same tiny/fast config as the
    /// happy-path test above so this stays quick.
    func testMisalignedResolutionIsAutoSnappedNotRejected() throws {
        let transformerURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        guard FileManager.default.fileExists(atPath: transformerURL.path) else {
            throw XCTSkip("real distilled transformer checkpoint not found — skipping integration smoke test")
        }
        let vaeEncoderURL = RepoPaths.mlxModelsRoot.appendingPathComponent("vae/ltx-2.3-vae/vae_encoder.safetensors")
        guard FileManager.default.fileExists(atPath: vaeEncoderURL.path) else {
            throw XCTSkip("real video VAE encoder checkpoint not found — skipping integration smoke test")
        }

        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_i2v_misaligned_\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: outputDir) }

        let stage = NativeI2VStage()
        // 300x310 is not a multiple of 32 in either axis — should snap to
        // 288x320 (nearest 32-multiples) instead of throwing.
        var request = NativeI2VStage.Request(prompt: "a woman smiles at the camera", seconds: 9.0 / 24.0, width: 300, height: 310, textMaxLength: 8)
        request.fps = 24.0

        let result = try stage.generate(request, outputDir: outputDir)
        XCTAssertGreaterThan(result.frameCount, 0)
    }

    /// Degenerate (non-positive) dimensions still fail fast, before any
    /// checkpoint loading — this doesn't need real checkpoints at all.
    func testNonPositiveDimensionsThrowInvalidDimensions() {
        let stage = NativeI2VStage()
        let request = NativeI2VStage.Request(prompt: "x", seconds: 9.0 / 24.0, width: 0, height: 320)
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_i2v_bad_dims_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeI2VStage.StageError else {
                XCTFail("expected StageError, got \(error)")
                return
            }
            if case .invalidDimensions = stageError {} else {
                XCTFail("expected .invalidDimensions, got \(stageError)")
            }
        }
    }
}
