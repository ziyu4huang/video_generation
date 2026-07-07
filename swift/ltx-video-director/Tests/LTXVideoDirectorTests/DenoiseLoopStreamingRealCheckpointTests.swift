import XCTest
import MLX
@testable import LTXVideoDirector

/// Integration smoke test: DenoiseLoop.runStreaming against the REAL
/// production LTX-2.3 transformer checkpoint (19GB, 48 blocks,
/// int8/group64) across MULTIPLE sigma steps — proves the streaming
/// block-provider pattern LTXModelRealCheckpointTests only exercised for
/// a single forward pass also works inside the denoise loop, i.e. that a
/// real generation run doesn't require holding all 48 blocks' dequantized
/// weights resident simultaneously. No reference output to diff against
/// (no single Python entry point runs this exact tiny synthetic-shape
/// composition); only proves it runs to completion with finite output —
/// matching the established real-checkpoint smoke-test convention.
/// Skips gracefully if the checkpoint isn't present.
final class DenoiseLoopStreamingRealCheckpointTests: XCTestCase {
    private func realConfig(numLayers: Int) -> LTXModelConfig {
        var cfg = LTXModelConfig()
        cfg.numLayers = numLayers
        cfg.videoDim = 4096; cfg.audioDim = 2048
        cfg.videoNumHeads = 32; cfg.audioNumHeads = 32
        cfg.videoHeadDim = 128; cfg.audioHeadDim = 64
        cfg.avCrossNumHeads = 32; cfg.avCrossHeadDim = 64
        cfg.videoPatchChannels = 128; cfg.audioPatchChannels = 128
        cfg.timestepEmbeddingDim = 256
        cfg.timestepScaleMultiplier = 1000.0
        cfg.avCaTimestepScaleMultiplier = 1000.0
        cfg.ropeTheta = 10000.0
        cfg.positionalEmbeddingMaxPos = [20, 2048, 2048]
        cfg.audioPositionalEmbeddingMaxPos = [20]
        return cfg
    }

    private func loadRawCheckpoint() throws -> [String: MLXArray]? {
        let checkpointURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else { return nil }
        let raw = try MLX.loadArrays(url: checkpointURL)
        var stripped: [String: MLXArray] = [:]
        for (key, value) in raw {
            guard key.hasPrefix("transformer.") else { continue }
            stripped[String(key.dropFirst("transformer.".count))] = value
        }
        return stripped
    }

    /// Only 2 steps (not the production 8) and 2 real blocks (not 48) —
    /// keeps this test fast while still proving the streaming loop
    /// mechanics (rebuild blocks -> eval -> release, every step) work
    /// against real weights, not synthetic ones.
    func testStreamingLoopRunsMultipleStepsWithRealBlocks() throws {
        guard let raw = try loadRawCheckpoint() else {
            throw XCTSkip("real checkpoint not found — skipping integration smoke test")
        }
        let numLayers = 2
        let cfg = realConfig(numLayers: numLayers)
        let model = TransformerCheckpointLoader.makeModel(
            TransformerCheckpointLoader.topLevelWeights(raw: raw), config: cfg, transformerBlocks: [])

        let B = 1, Nv = 4, Na = 2
        let videoNoise = MLXArray.zeros([B, Nv, cfg.videoPatchChannels]).asType(.float32)
        let audioNoise = MLXArray.zeros([B, Na, cfg.audioPatchChannels]).asType(.float32)
        let videoPositions = MLXArray.zeros([B, Nv, 3]).asType(.int32)
        let audioPositions = MLXArray.zeros([B, Na, 1]).asType(.int32)

        let videoState = LatentState(latent: videoNoise, cleanLatent: videoNoise, denoiseMask: MLXArray.ones([B, Nv, 1]), positions: videoPositions)
        let audioState = LatentState(latent: audioNoise, cleanLatent: audioNoise, denoiseMask: MLXArray.ones([B, Na, 1]), positions: audioPositions)

        let videoTextEmbeds = MLXArray.zeros([B, 1, cfg.videoDim]).asType(.float32)
        let audioTextEmbeds = MLXArray.zeros([B, 1, cfg.audioDim]).asType(.float32)

        let sigmas: [Float] = [1.0, 0.5, 0.0]

        let result = DenoiseLoop.runStreaming(
            model: model, numLayers: numLayers,
            blockProvider: { idx in
                TransformerCheckpointLoader.makeBlock(TransformerCheckpointLoader.blockWeights(raw: raw, blockIndex: idx), config: cfg)
            },
            videoState: videoState, audioState: audioState,
            videoTextEmbeds: videoTextEmbeds, audioTextEmbeds: audioTextEmbeds,
            sigmas: sigmas)
        MLX.eval(result.videoLatent, result.audioLatent)

        XCTAssertEqual(result.videoLatent.shape, [B, Nv, cfg.videoPatchChannels])
        XCTAssertEqual(result.audioLatent.shape, [B, Na, cfg.audioPatchChannels])
        XCTAssertTrue(result.videoLatent.asArray(Float.self).allSatisfy { $0.isFinite }, "streaming denoise video output has NaN/Inf")
        XCTAssertTrue(result.audioLatent.asArray(Float.self).allSatisfy { $0.isFinite }, "streaming denoise audio output has NaN/Inf")
    }

    /// Milestone 2b (STG): proves `stgScale`/`stgBlocks` actually reach the
    /// real block stack (via `LTXModel.streamingForward`'s per-block
    /// perturbation mask) and change the denoised output — same real
    /// 2-block streaming setup as above, `stgBlocks: [0]` (this test's
    /// stack only has 2 layers, not production's 48, so block 28 doesn't
    /// exist here).
    func testStreamingLoopSTGChangesOutputAndDefaultIsUnchanged() throws {
        guard let raw = try loadRawCheckpoint() else {
            throw XCTSkip("real checkpoint not found — skipping integration smoke test")
        }
        let numLayers = 2
        let cfg = realConfig(numLayers: numLayers)
        let model = TransformerCheckpointLoader.makeModel(
            TransformerCheckpointLoader.topLevelWeights(raw: raw), config: cfg, transformerBlocks: [])

        let B = 1, Nv = 4, Na = 2
        let videoNoise = MLXRandom.normal([B, Nv, cfg.videoPatchChannels]).asType(.float32)
        let audioNoise = MLXRandom.normal([B, Na, cfg.audioPatchChannels]).asType(.float32)
        let videoPositions = MLXArray.zeros([B, Nv, 3]).asType(.int32)
        let audioPositions = MLXArray.zeros([B, Na, 1]).asType(.int32)

        let videoState = LatentState(latent: videoNoise, cleanLatent: videoNoise, denoiseMask: MLXArray.ones([B, Nv, 1]), positions: videoPositions)
        let audioState = LatentState(latent: audioNoise, cleanLatent: audioNoise, denoiseMask: MLXArray.ones([B, Na, 1]), positions: audioPositions)

        let videoTextEmbeds = MLXRandom.normal([B, 1, cfg.videoDim]).asType(.float32)
        let audioTextEmbeds = MLXArray.zeros([B, 1, cfg.audioDim]).asType(.float32)

        let sigmas: [Float] = [1.0, 0.5, 0.0]

        func run(stgScale: Float, stgBlocks: Set<Int>) -> DenoiseResult {
            let result = DenoiseLoop.runStreaming(
                model: model, numLayers: numLayers,
                blockProvider: { idx in
                    TransformerCheckpointLoader.makeBlock(TransformerCheckpointLoader.blockWeights(raw: raw, blockIndex: idx), config: cfg)
                },
                videoState: videoState, audioState: audioState,
                videoTextEmbeds: videoTextEmbeds, audioTextEmbeds: audioTextEmbeds,
                sigmas: sigmas, stgScale: stgScale, stgBlocks: stgBlocks)
            MLX.eval(result.videoLatent, result.audioLatent)
            return result
        }

        let baseline = run(stgScale: 0.0, stgBlocks: [0])
        let defaultParams = run(stgScale: 0.0, stgBlocks: [28])  // production default, inactive here (stgScale=0)
        XCTAssertEqual(baseline.videoLatent.asArray(Float.self), defaultParams.videoLatent.asArray(Float.self),
                        "stgScale=0.0 must be a behavior-identical no-op regardless of stgBlocks")

        let stgOn = run(stgScale: 1.0, stgBlocks: [0])
        XCTAssertTrue(stgOn.videoLatent.asArray(Float.self).allSatisfy { $0.isFinite }, "STG-guided video output has NaN/Inf")
        XCTAssertTrue(stgOn.audioLatent.asArray(Float.self).allSatisfy { $0.isFinite }, "STG-guided audio output has NaN/Inf")
        let diff = MLX.abs(stgOn.videoLatent - baseline.videoLatent).max().item(Float.self)
        XCTAssertGreaterThan(diff, 1e-4, "active STG must actually change the video output vs. the stgScale=0 baseline")
    }
}
