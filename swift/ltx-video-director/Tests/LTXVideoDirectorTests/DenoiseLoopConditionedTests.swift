import XCTest
import MLX
@testable import LTXVideoDirector

/// Smoke test (not a numerical parity test — see caveat below) for
/// DenoiseLoop's I2V-conditioned overload: builds a small synthetic
/// LTXModel, conditions frame 0 via VideoConditionByLatentIndex, runs the
/// loop, and checks the conditioned frame ends up exactly equal to the
/// clean latent (mask=0 forces this every step via applyDenoiseMask,
/// regardless of what the model predicts) while other frames are finite
/// and have actually moved from their initial noise.
///
/// CAVEAT: this is NOT bit-parity-tested against the real denoise_loop for
/// the non-uniform-mask case, because the reference switches to per-token
/// timesteps when the mask isn't uniform (preserved tokens get AdaLN
/// timestep=0), which X0Model/LTXModel don't implement yet (see
/// LatentConditioning.swift's header). The uniform-mask path IS bit-
/// parity-tested (DenoiseLoopParityTests). This test only checks the
/// conditioning mechanism's own guarantee (preserved tokens stay clean),
/// which holds regardless of the per-token-timestep gap.
final class DenoiseLoopConditionedTests: XCTestCase {
    func testConditionedFramePreservedThroughoutLoop() throws {
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

        func randomWeights(_ shapes: [(String, [Int])]) -> [String: MLXArray] {
            Dictionary(uniqueKeysWithValues: shapes.map { ($0.0, MLX.normal($0.1) * 0.05) })
        }

        // Minimal weight set for a 1-layer model at these tiny dims — reuse
        // TransformerCheckpointLoader's key scheme so makeBlock/makeModel work.
        func attnWeights(_ prefix: String, dim: Int, kvDim: Int, heads: Int, headDim: Int) -> [(String, [Int])] {
            let inner = heads * headDim
            return [
                ("\(prefix).to_q.weight", [inner, dim]), ("\(prefix).to_q.bias", [inner]),
                ("\(prefix).to_k.weight", [inner, kvDim]), ("\(prefix).to_k.bias", [inner]),
                ("\(prefix).to_v.weight", [inner, kvDim]), ("\(prefix).to_v.bias", [inner]),
                ("\(prefix).to_out.weight", [dim, inner]), ("\(prefix).to_out.bias", [dim]),
                ("\(prefix).to_gate_logits.weight", [heads, dim]), ("\(prefix).to_gate_logits.bias", [heads]),
                ("\(prefix).q_norm.weight", [inner]), ("\(prefix).k_norm.weight", [inner]),
            ]
        }
        func ffWeights(_ prefix: String, dim: Int, mult: Int = 4) -> [(String, [Int])] {
            [
                ("\(prefix).proj_in.weight", [dim * mult, dim]), ("\(prefix).proj_in.bias", [dim * mult]),
                ("\(prefix).proj_out.weight", [dim, dim * mult]), ("\(prefix).proj_out.bias", [dim]),
            ]
        }
        func adalnWeights(_ prefix: String, dim: Int, numParams: Int, tDim: Int) -> [(String, [Int])] {
            [
                ("\(prefix).emb.timestep_embedder.linear1.weight", [dim, tDim]), ("\(prefix).emb.timestep_embedder.linear1.bias", [dim]),
                ("\(prefix).emb.timestep_embedder.linear2.weight", [dim, dim]), ("\(prefix).emb.timestep_embedder.linear2.bias", [dim]),
                ("\(prefix).linear.weight", [numParams * dim, dim]), ("\(prefix).linear.bias", [numParams * dim]),
            ]
        }

        var shapes: [(String, [Int])] = []
        shapes += attnWeights("attn1", dim: cfg.videoDim, kvDim: cfg.videoDim, heads: cfg.videoNumHeads, headDim: cfg.videoHeadDim)
        shapes += attnWeights("audio_attn1", dim: cfg.audioDim, kvDim: cfg.audioDim, heads: cfg.audioNumHeads, headDim: cfg.audioHeadDim)
        shapes += attnWeights("attn2", dim: cfg.videoDim, kvDim: cfg.videoDim, heads: cfg.videoNumHeads, headDim: cfg.videoHeadDim)
        shapes += attnWeights("audio_attn2", dim: cfg.audioDim, kvDim: cfg.audioDim, heads: cfg.audioNumHeads, headDim: cfg.audioHeadDim)
        shapes += attnWeights("audio_to_video_attn", dim: cfg.videoDim, kvDim: cfg.audioDim, heads: cfg.avCrossNumHeads, headDim: cfg.avCrossHeadDim)
        shapes += attnWeights("video_to_audio_attn", dim: cfg.audioDim, kvDim: cfg.videoDim, heads: cfg.avCrossNumHeads, headDim: cfg.avCrossHeadDim)
        shapes += ffWeights("ff", dim: cfg.videoDim)
        shapes += ffWeights("audio_ff", dim: cfg.audioDim)
        shapes += [
            ("scale_shift_table", [9, cfg.videoDim]), ("audio_scale_shift_table", [9, cfg.audioDim]),
            ("prompt_scale_shift_table", [2, cfg.videoDim]), ("audio_prompt_scale_shift_table", [2, cfg.audioDim]),
            ("scale_shift_table_a2v_ca_video", [5, cfg.videoDim]), ("scale_shift_table_a2v_ca_audio", [5, cfg.audioDim]),
        ]
        let blockWeights = randomWeights(shapes)
        let block = TransformerCheckpointLoader.makeBlock(blockWeights, config: cfg)

        var topShapes: [(String, [Int])] = [
            ("patchify_proj.weight", [cfg.videoDim, cfg.videoPatchChannels]), ("patchify_proj.bias", [cfg.videoDim]),
            ("audio_patchify_proj.weight", [cfg.audioDim, cfg.audioPatchChannels]), ("audio_patchify_proj.bias", [cfg.audioDim]),
            ("proj_out.weight", [cfg.videoPatchChannels, cfg.videoDim]), ("proj_out.bias", [cfg.videoPatchChannels]),
            ("audio_proj_out.weight", [cfg.audioPatchChannels, cfg.audioDim]), ("audio_proj_out.bias", [cfg.audioPatchChannels]),
            ("scale_shift_table", [2, cfg.videoDim]), ("audio_scale_shift_table", [2, cfg.audioDim]),
        ]
        topShapes += adalnWeights("adaln_single", dim: cfg.videoDim, numParams: 9, tDim: cfg.timestepEmbeddingDim)
        topShapes += adalnWeights("audio_adaln_single", dim: cfg.audioDim, numParams: 9, tDim: cfg.timestepEmbeddingDim)
        topShapes += adalnWeights("prompt_adaln_single", dim: cfg.videoDim, numParams: 2, tDim: cfg.timestepEmbeddingDim)
        topShapes += adalnWeights("audio_prompt_adaln_single", dim: cfg.audioDim, numParams: 2, tDim: cfg.timestepEmbeddingDim)
        topShapes += adalnWeights("av_ca_video_scale_shift_adaln_single", dim: cfg.videoDim, numParams: 4, tDim: cfg.timestepEmbeddingDim)
        topShapes += adalnWeights("av_ca_audio_scale_shift_adaln_single", dim: cfg.audioDim, numParams: 4, tDim: cfg.timestepEmbeddingDim)
        topShapes += adalnWeights("av_ca_a2v_gate_adaln_single", dim: cfg.videoDim, numParams: 1, tDim: cfg.timestepEmbeddingDim)
        topShapes += adalnWeights("av_ca_v2a_gate_adaln_single", dim: cfg.audioDim, numParams: 1, tDim: cfg.timestepEmbeddingDim)
        let topWeights = randomWeights(topShapes)
        let model = TransformerCheckpointLoader.makeModel(topWeights, config: cfg, transformerBlocks: [block])
        let x0Model = X0Model(model: model)

        // I2V: F=3 frames, H=W=2 (tokensPerFrame=4), condition frame 0.
        let b = 1, nv = 12, na = 3, nt = 2, tokensPerFrame = 4
        let videoNoise = MLX.normal([b, nv, cfg.videoPatchChannels])
        let audioNoise = MLX.normal([b, na, cfg.audioPatchChannels])
        let cleanImage = MLX.normal([b, tokensPerFrame, cfg.videoPatchChannels])
        let videoTextEmbeds = MLX.normal([b, nt, cfg.videoDim])
        let audioTextEmbeds = MLX.normal([b, nt, cfg.audioDim])
        let videoPositions = MLXArray.zeros([b, nv, 3]).asType(.int32)
        let audioPositions = MLXArray.zeros([b, na, 1]).asType(.int32)

        let videoState0 = LatentState(latent: videoNoise, cleanLatent: videoNoise, denoiseMask: MLXArray.ones([b, nv, 1]), positions: videoPositions)
        let conditioner = VideoConditionByLatentIndex(frameIndices: [0], cleanLatent: cleanImage, strength: 1.0)
        let videoState = conditioner.apply(to: videoState0, spatialDims: (3, 2, 2))
        let audioState = LatentState(latent: audioNoise, cleanLatent: audioNoise, denoiseMask: MLXArray.ones([b, na, 1]), positions: audioPositions)

        let result = DenoiseLoop.run(
            model: x0Model, videoState: videoState, audioState: audioState,
            videoTextEmbeds: videoTextEmbeds, audioTextEmbeds: audioTextEmbeds,
            sigmas: [1.0, 0.5, 0.0])
        MLX.eval(result.videoLatent, result.audioLatent)

        // Conditioned frame 0 must exactly equal the clean image (mask=0 forces this every step).
        let conditionedFrame = result.videoLatent[0..., 0..<tokensPerFrame, 0...]
        let diff = MLX.abs(conditionedFrame.asType(.float32) - cleanImage.asType(.float32)).max().item(Float.self)
        XCTAssertEqual(diff, 0, accuracy: 1e-6, "conditioned frame 0 drifted from the clean image, diff=\(diff)")

        // Generated frames (1, 2) must be finite and have moved from the initial noise.
        let generatedFrames = result.videoLatent[0..., tokensPerFrame..., 0...]
        XCTAssertTrue(generatedFrames.asArray(Float.self).allSatisfy { $0.isFinite })
        let generatedNoiseOriginal = videoNoise[0..., tokensPerFrame..., 0...]
        let movedDiff = MLX.abs(generatedFrames.asType(.float32) - generatedNoiseOriginal.asType(.float32)).max().item(Float.self)
        XCTAssertGreaterThan(movedDiff, 1e-4, "generated frames didn't change from initial noise")
    }
}
