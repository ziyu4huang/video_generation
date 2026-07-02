import XCTest
import MLX
@testable import LTXVideoDirector

/// Integration smoke test: load the REAL production LTX-2.3 transformer
/// checkpoint and run ONE real transformer block (not all 48 — the full
/// checkpoint is ~19GB, block weights are MLX-quantized int8/group64, and
/// dequantizing all 48 blocks to float32 for a test would need far more
/// memory than is reasonable to hold resident just to smoke-test loading).
/// Confirms: (1) the real checkpoint's quantized weights can be located and
/// dequantized via QuantizedWeights, (2) the real production config
/// (video_dim=4096, audio_dim=2048, 32 heads, etc. — confirmed against
/// mlx-models/ltx-mlx/distilled/embedded_config.json) produces a real block
/// forward pass with finite, correctly-shaped output. Skips gracefully if
/// the checkpoint isn't present (external model store, gitignored).
final class LTXModelRealCheckpointTests: XCTestCase {
    private func makeAdaLN(_ arrays: [String: MLXArray], prefix: String) -> AdaLayerNormSingle {
        let embedder = TimestepEmbedder(
            linear1Weight: arrays["\(prefix).emb.timestep_embedder.linear1.weight"]!,
            linear1Bias: arrays["\(prefix).emb.timestep_embedder.linear1.bias"]!,
            linear2Weight: arrays["\(prefix).emb.timestep_embedder.linear2.weight"]!,
            linear2Bias: arrays["\(prefix).emb.timestep_embedder.linear2.bias"]!)
        return AdaLayerNormSingle(emb: embedder, linearWeight: arrays["\(prefix).linear.weight"]!, linearBias: arrays["\(prefix).linear.bias"]!)
    }

    private func makeAttention(_ arrays: [String: MLXArray], prefix: String, numHeads: Int, headDim: Int, useRope: Bool) -> Attention {
        Attention(
            numHeads: numHeads, headDim: headDim, useRope: useRope,
            toQWeight: arrays["\(prefix).to_q.weight"]!, toQBias: arrays["\(prefix).to_q.bias"],
            toKWeight: arrays["\(prefix).to_k.weight"]!, toKBias: arrays["\(prefix).to_k.bias"],
            toVWeight: arrays["\(prefix).to_v.weight"]!, toVBias: arrays["\(prefix).to_v.bias"],
            toOutWeight: arrays["\(prefix).to_out.weight"]!, toOutBias: arrays["\(prefix).to_out.bias"]!,
            toGateLogitsWeight: arrays["\(prefix).to_gate_logits.weight"], toGateLogitsBias: arrays["\(prefix).to_gate_logits.bias"],
            qNormWeight: arrays["\(prefix).q_norm.weight"]!, kNormWeight: arrays["\(prefix).k_norm.weight"]!)
    }

    private func makeFF(_ arrays: [String: MLXArray], prefix: String) -> FeedForward {
        FeedForward(
            projInWeight: arrays["\(prefix).proj_in.weight"]!, projInBias: arrays["\(prefix).proj_in.bias"]!,
            projOutWeight: arrays["\(prefix).proj_out.weight"]!, projOutBias: arrays["\(prefix).proj_out.bias"]!)
    }

    func testOneRealBlockProducesFiniteOutput() throws {
        let checkpointURL = RepoPaths.mlxModelsRoot.appendingPathComponent("transformer/ltx-2.3-distilled-q8/transformer-distilled-1.1.safetensors")
        guard FileManager.default.fileExists(atPath: checkpointURL.path) else {
            throw XCTSkip("real checkpoint not found at \(checkpointURL.path) — skipping integration smoke test")
        }

        let raw = try MLX.loadArrays(url: checkpointURL)
        // Strip the "transformer." prefix; keep only top-level modules +
        // transformer_blocks.0 (dequantizing all 48 blocks would need far
        // more memory than a smoke test warrants).
        var stripped: [String: MLXArray] = [:]
        for (key, value) in raw {
            guard key.hasPrefix("transformer.") else { continue }
            let rest = String(key.dropFirst("transformer.".count))
            if rest.hasPrefix("transformer_blocks.") && !rest.hasPrefix("transformer_blocks.0.") {
                continue  // skip blocks 1-47
            }
            stripped[rest] = value
        }
        let arrays = QuantizedWeights.dequantizeLinearWeights(stripped)

        // Real production config (confirmed against embedded_config.json).
        var cfg = LTXModelConfig()
        cfg.numLayers = 1
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

        let block = BasicAVTransformerBlock(
            attn1: makeAttention(arrays, prefix: "transformer_blocks.0.attn1", numHeads: cfg.videoNumHeads, headDim: cfg.videoHeadDim, useRope: true),
            audioAttn1: makeAttention(arrays, prefix: "transformer_blocks.0.audio_attn1", numHeads: cfg.audioNumHeads, headDim: cfg.audioHeadDim, useRope: true),
            attn2: makeAttention(arrays, prefix: "transformer_blocks.0.attn2", numHeads: cfg.videoNumHeads, headDim: cfg.videoHeadDim, useRope: false),
            audioAttn2: makeAttention(arrays, prefix: "transformer_blocks.0.audio_attn2", numHeads: cfg.audioNumHeads, headDim: cfg.audioHeadDim, useRope: false),
            audioToVideoAttn: makeAttention(arrays, prefix: "transformer_blocks.0.audio_to_video_attn", numHeads: cfg.avCrossNumHeads, headDim: cfg.avCrossHeadDim, useRope: true),
            videoToAudioAttn: makeAttention(arrays, prefix: "transformer_blocks.0.video_to_audio_attn", numHeads: cfg.avCrossNumHeads, headDim: cfg.avCrossHeadDim, useRope: true),
            ff: makeFF(arrays, prefix: "transformer_blocks.0.ff"),
            audioFF: makeFF(arrays, prefix: "transformer_blocks.0.audio_ff"),
            scaleShiftTable: arrays["transformer_blocks.0.scale_shift_table"]!,
            audioScaleShiftTable: arrays["transformer_blocks.0.audio_scale_shift_table"]!,
            promptScaleShiftTable: arrays["transformer_blocks.0.prompt_scale_shift_table"]!,
            audioPromptScaleShiftTable: arrays["transformer_blocks.0.audio_prompt_scale_shift_table"]!,
            scaleShiftTableA2VCAVideo: arrays["transformer_blocks.0.scale_shift_table_a2v_ca_video"]!,
            scaleShiftTableA2VCAAudio: arrays["transformer_blocks.0.scale_shift_table_a2v_ca_audio"]!,
            normEps: cfg.normEps)

        let model = LTXModel(
            config: cfg,
            patchifyProjWeight: arrays["patchify_proj.weight"]!, patchifyProjBias: arrays["patchify_proj.bias"]!,
            audioPatchifyProjWeight: arrays["audio_patchify_proj.weight"]!, audioPatchifyProjBias: arrays["audio_patchify_proj.bias"]!,
            projOutWeight: arrays["proj_out.weight"]!, projOutBias: arrays["proj_out.bias"]!,
            audioProjOutWeight: arrays["audio_proj_out.weight"]!, audioProjOutBias: arrays["audio_proj_out.bias"]!,
            scaleShiftTable: arrays["scale_shift_table"]!, audioScaleShiftTable: arrays["audio_scale_shift_table"]!,
            adalnSingle: makeAdaLN(arrays, prefix: "adaln_single"),
            audioAdalnSingle: makeAdaLN(arrays, prefix: "audio_adaln_single"),
            promptAdalnSingle: makeAdaLN(arrays, prefix: "prompt_adaln_single"),
            audioPromptAdalnSingle: makeAdaLN(arrays, prefix: "audio_prompt_adaln_single"),
            avCaVideoScaleShiftAdalnSingle: makeAdaLN(arrays, prefix: "av_ca_video_scale_shift_adaln_single"),
            avCaAudioScaleShiftAdalnSingle: makeAdaLN(arrays, prefix: "av_ca_audio_scale_shift_adaln_single"),
            avCaA2VGateAdalnSingle: makeAdaLN(arrays, prefix: "av_ca_a2v_gate_adaln_single"),
            avCaV2AGateAdalnSingle: makeAdaLN(arrays, prefix: "av_ca_v2a_gate_adaln_single"),
            transformerBlocks: [block])

        // Tiny synthetic tokens at the REAL patch-channel width (128 for
        // both modalities) — proves the real weights run end-to-end without
        // crashing or producing NaN/Inf, not that output matches any
        // particular video.
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
}
