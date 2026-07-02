import XCTest
import MLX
@testable import LTXVideoDirector

/// Integration smoke tests against the REAL production LTX-2.3 transformer
/// checkpoint (mlx-models/transformer/ltx-2.3-distilled-q8/
/// transformer-distilled-1.1.safetensors, 19GB, 7450 tensors, MLX-quantized
/// int8/group64 block weights — see QuantizedWeights.swift). Both tests
/// skip gracefully if the checkpoint isn't present (external model store,
/// gitignored).
final class LTXModelRealCheckpointTests: XCTestCase {
    /// Real production config, confirmed against
    /// mlx-models/ltx-mlx/distilled/embedded_config.json (not assumed).
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
        cfg.avCaTimestepScaleMultiplier = 1000.0  // embedded_config.json: both are 1000, factor=1.0
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

    func testOneRealBlockProducesFiniteOutput() throws {
        guard let raw = try loadRawCheckpoint() else {
            throw XCTSkip("real checkpoint not found — skipping integration smoke test")
        }
        let cfg = realConfig(numLayers: 1)

        let topLevel = TransformerCheckpointLoader.topLevelWeights(raw: raw)
        let blockWeights = TransformerCheckpointLoader.blockWeights(raw: raw, blockIndex: 0)
        let block = TransformerCheckpointLoader.makeBlock(blockWeights, config: cfg)
        let model = TransformerCheckpointLoader.makeModel(topLevel, config: cfg, transformerBlocks: [block])

        let B = 1, Nv = 4, Na = 2
        let videoLatent = MLXArray.zeros([B, Nv, cfg.videoPatchChannels]).asType(.float32)
        let audioLatent = MLXArray.zeros([B, Na, cfg.audioPatchChannels]).asType(.float32)
        let timestep = MLXArray([Float(0.5)])
        let videoPositions = MLXArray.zeros([B, Nv, 3]).asType(.int32)
        let audioPositions = MLXArray.zeros([B, Na, 1]).asType(.int32)

        let (videoOut, audioOut) = model(
            videoLatent: videoLatent, audioLatent: audioLatent, timestep: timestep,
            videoPositions: videoPositions, audioPositions: audioPositions)
        MLX.eval(videoOut, audioOut)

        XCTAssertEqual(videoOut.shape, [B, Nv, cfg.videoPatchChannels])
        XCTAssertEqual(audioOut.shape, [B, Na, cfg.audioPatchChannels])
        XCTAssertTrue(videoOut.asArray(Float.self).allSatisfy { $0.isFinite }, "real-checkpoint video output has NaN/Inf")
        XCTAssertTrue(audioOut.asArray(Float.self).allSatisfy { $0.isFinite }, "real-checkpoint audio output has NaN/Inf")
    }

    /// Streams all 48 REAL transformer blocks (not just block 0) — each
    /// block's weights are dequantized fresh from the checkpoint slice,
    /// used, then released before the next block is built (see
    /// LTXModel.streamingForward). Proves the full-depth forward pass is
    /// actually feasible against the real checkpoint, not just one block.
    func testAll48RealBlocksStreamWithBoundedMemory() throws {
        guard let raw = try loadRawCheckpoint() else {
            throw XCTSkip("real checkpoint not found — skipping integration smoke test")
        }
        let cfg = realConfig(numLayers: 48)
        let topLevel = TransformerCheckpointLoader.makeModel(
            TransformerCheckpointLoader.topLevelWeights(raw: raw), config: cfg, transformerBlocks: [])

        let B = 1, Nv = 4, Na = 2
        let videoLatent = MLXArray.zeros([B, Nv, cfg.videoPatchChannels]).asType(.float32)
        let audioLatent = MLXArray.zeros([B, Na, cfg.audioPatchChannels]).asType(.float32)
        let timestep = MLXArray([Float(0.5)])
        let videoPositions = MLXArray.zeros([B, Nv, 3]).asType(.int32)
        let audioPositions = MLXArray.zeros([B, Na, 1]).asType(.int32)

        let (videoOut, audioOut) = topLevel.streamingForward(
            videoLatent: videoLatent, audioLatent: audioLatent, timestep: timestep,
            numLayers: cfg.numLayers,
            blockProvider: { idx in
                let weights = TransformerCheckpointLoader.blockWeights(raw: raw, blockIndex: idx)
                return TransformerCheckpointLoader.makeBlock(weights, config: cfg)
            },
            videoPositions: videoPositions, audioPositions: audioPositions)
        MLX.eval(videoOut, audioOut)

        XCTAssertEqual(videoOut.shape, [B, Nv, cfg.videoPatchChannels])
        XCTAssertEqual(audioOut.shape, [B, Na, cfg.audioPatchChannels])
        XCTAssertTrue(videoOut.asArray(Float.self).allSatisfy { $0.isFinite }, "48-block real-checkpoint video output has NaN/Inf")
        XCTAssertTrue(audioOut.asArray(Float.self).allSatisfy { $0.isFinite }, "48-block real-checkpoint audio output has NaN/Inf")
    }
}
