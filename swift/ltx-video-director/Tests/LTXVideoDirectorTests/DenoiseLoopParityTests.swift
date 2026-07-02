import XCTest
import MLX
@testable import LTXVideoDirector

/// End-to-end parity check of the full sampling loop (X0Model + Euler
/// stepping + sigma schedule) against the REAL
/// ltx_pipelines_mlx.utils.samplers.denoise_loop function wrapping a real
/// X0Model/LTXModel, with a uniform (all-ones) denoise mask — matching
/// DenoiseLoop.swift's scope (full generation, no partial conditioning).
/// This is the point where every Phase 2 + Phase 3 component combines
/// into something that actually denoises a latent from noise toward a
/// clean sample. See scripts/dump_denoiseloop_reference.py, PLAN.md Phase 3.
final class DenoiseLoopParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/denoise_loop")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/denoise_loop")
    }

    func testFullDenoiseLoop() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("loop.safetensors"))

        var cfg = LTXModelConfig()
        cfg.numLayers = 2
        cfg.videoDim = 32; cfg.audioDim = 16
        cfg.videoNumHeads = 4; cfg.audioNumHeads = 4
        cfg.videoHeadDim = 8; cfg.audioHeadDim = 4
        cfg.avCrossNumHeads = 4; cfg.avCrossHeadDim = 4
        cfg.videoPatchChannels = 6; cfg.audioPatchChannels = 5
        cfg.timestepEmbeddingDim = 32
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

        let sigmas: [Float] = [1.0, 0.6, 0.25, 0.0]

        let result = DenoiseLoop.run(
            model: x0Model,
            videoLatent: arrays["video_noise"]!, audioLatent: arrays["audio_noise"]!,
            videoTextEmbeds: arrays["video_text_embeds"]!, audioTextEmbeds: arrays["audio_text_embeds"]!,
            sigmas: sigmas,
            videoPositions: arrays["video_positions"]!.asType(.int32),
            audioPositions: arrays["audio_positions"]!.asType(.int32))
        MLX.eval(result.videoLatent, result.audioLatent)

        let expectedVideo = arrays["video_output"]!
        let expectedAudio = arrays["audio_output"]!

        XCTAssertEqual(result.videoLatent.shape, expectedVideo.shape)
        let videoDiff = MLX.abs(result.videoLatent.asType(.float32) - expectedVideo.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(videoDiff, 1e-2, "video output max abs diff \(videoDiff)")

        XCTAssertEqual(result.audioLatent.shape, expectedAudio.shape)
        let audioDiff = MLX.abs(result.audioLatent.asType(.float32) - expectedAudio.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(audioDiff, 1e-2, "audio output max abs diff \(audioDiff)")
    }
}
