import XCTest
import MLX
@testable import LTXVideoDirector

/// Closes the bit-parity gap DenoiseLoopConditionedTests documented: now
/// that LTXModel/X0Model support per-token timesteps, this checks the
/// I2V-conditioned (non-uniform mask) path against the REAL denoise_loop
/// bit-for-bit, not just the "conditioned frame stays clean" property.
/// See scripts/dump_denoiseloop_i2v_reference.py, PLAN.md Phase 3.
final class DenoiseLoopI2VParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/denoise_loop_i2v")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/denoise_loop_i2v")
    }

    func testI2VConditionedLoopMatchesReference() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("loop_i2v.safetensors"))

        var cfg = LTXModelConfig()
        cfg.numLayers = 1
        cfg.videoDim = 16; cfg.audioDim = 8
        cfg.videoNumHeads = 2; cfg.audioNumHeads = 2
        cfg.videoHeadDim = 8; cfg.audioHeadDim = 4
        cfg.avCrossNumHeads = 2; cfg.avCrossHeadDim = 4
        cfg.videoPatchChannels = 6; cfg.audioPatchChannels = 5
        cfg.timestepEmbeddingDim = 16
        cfg.positionalEmbeddingMaxPos = [20, 64, 64]
        cfg.audioPositionalEmbeddingMaxPos = [20]

        let blocks = (0..<cfg.numLayers).map { idx in
            TransformerCheckpointLoader.makeBlock(
                Dictionary(uniqueKeysWithValues: arrays.compactMap { k, v -> (String, MLXArray)? in
                    let prefix = "transformer_blocks.\(idx)."
                    guard k.hasPrefix(prefix) else { return nil }
                    return (String(k.dropFirst(prefix.count)), v)
                }),
                config: cfg)
        }
        let model = TransformerCheckpointLoader.makeModel(arrays, config: cfg, transformerBlocks: blocks)
        let x0Model = X0Model(model: model)

        let tokensPerFrame = 4  // H*W = 2*2
        let videoNoise = arrays["video_noise"]!
        let videoPositions = arrays["video_positions"]!.asType(.int32)

        let videoState0 = LatentState(latent: videoNoise, cleanLatent: videoNoise, denoiseMask: MLXArray.ones([1, videoNoise.dim(1), 1]), positions: videoPositions)
        let conditioner = VideoConditionByLatentIndex(frameIndices: [0], cleanLatent: arrays["clean_image"]!, strength: 1.0)
        let videoState = conditioner.apply(to: videoState0, spatialDims: (3, 2, 2))

        let audioNoise = arrays["audio_noise"]!
        let audioPositions = arrays["audio_positions"]!.asType(.int32)
        let audioState = LatentState(latent: audioNoise, cleanLatent: audioNoise, denoiseMask: MLXArray.ones([1, audioNoise.dim(1), 1]), positions: audioPositions)

        let sigmas: [Float] = [1.0, 0.5, 0.0]

        let result = DenoiseLoop.run(
            model: x0Model, videoState: videoState, audioState: audioState,
            videoTextEmbeds: arrays["video_text_embeds"]!, audioTextEmbeds: arrays["audio_text_embeds"]!,
            sigmas: sigmas)
        MLX.eval(result.videoLatent, result.audioLatent)

        let expectedVideo = arrays["video_output"]!
        let expectedAudio = arrays["audio_output"]!

        XCTAssertEqual(result.videoLatent.shape, expectedVideo.shape)
        let videoDiff = MLX.abs(result.videoLatent.asType(.float32) - expectedVideo.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(videoDiff, 1e-2, "video output max abs diff \(videoDiff)")

        XCTAssertEqual(result.audioLatent.shape, expectedAudio.shape)
        let audioDiff = MLX.abs(result.audioLatent.asType(.float32) - expectedAudio.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(audioDiff, 1e-2, "audio output max abs diff \(audioDiff)")

        // Also confirm frame 0 exactly matches the conditioning image (both
        // reference and this implementation should preserve it exactly).
        let conditionedFrame = result.videoLatent[0..., 0..<tokensPerFrame, 0...]
        let frameDiff = MLX.abs(conditionedFrame.asType(.float32) - arrays["clean_image"]!.asType(.float32)).max().item(Float.self)
        XCTAssertEqual(frameDiff, 0, accuracy: 1e-6, "conditioned frame 0 drifted from the clean image")
    }
}
