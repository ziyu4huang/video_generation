import XCTest
import MLX
@testable import LTXVideoDirector

/// End-to-end parity check of the FULL top-level LTXModel assembly against
/// the real ltx_core_mlx.model.transformer.model.LTXModel class (real
/// wiring: patchify -> 8 top-level AdaLN modules -> N transformer blocks ->
/// output block), small 2-layer config, fixed-seed weights. This is the
/// top of Phase 2 — everything built in this phase (RoPE, TimestepEmbedding,
/// AdaLayerNormSingle, FeedForward, Attention, Modality,
/// BasicAVTransformerBlock) gets exercised together here. See
/// scripts/dump_ltxmodel_reference.py, PLAN.md Phase 2.
final class LTXModelParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/ltx_model")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/ltx_model")
    }

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

    private func makeBlock(_ arrays: [String: MLXArray], prefix: String, cfg: LTXModelConfig) -> BasicAVTransformerBlock {
        BasicAVTransformerBlock(
            attn1: makeAttention(arrays, prefix: "\(prefix).attn1", numHeads: cfg.videoNumHeads, headDim: cfg.videoHeadDim, useRope: true),
            audioAttn1: makeAttention(arrays, prefix: "\(prefix).audio_attn1", numHeads: cfg.audioNumHeads, headDim: cfg.audioHeadDim, useRope: true),
            attn2: makeAttention(arrays, prefix: "\(prefix).attn2", numHeads: cfg.videoNumHeads, headDim: cfg.videoHeadDim, useRope: false),
            audioAttn2: makeAttention(arrays, prefix: "\(prefix).audio_attn2", numHeads: cfg.audioNumHeads, headDim: cfg.audioHeadDim, useRope: false),
            audioToVideoAttn: makeAttention(arrays, prefix: "\(prefix).audio_to_video_attn", numHeads: cfg.avCrossNumHeads, headDim: cfg.avCrossHeadDim, useRope: true),
            videoToAudioAttn: makeAttention(arrays, prefix: "\(prefix).video_to_audio_attn", numHeads: cfg.avCrossNumHeads, headDim: cfg.avCrossHeadDim, useRope: true),
            ff: makeFF(arrays, prefix: "\(prefix).ff"),
            audioFF: makeFF(arrays, prefix: "\(prefix).audio_ff"),
            scaleShiftTable: arrays["\(prefix).scale_shift_table"]!,
            audioScaleShiftTable: arrays["\(prefix).audio_scale_shift_table"]!,
            promptScaleShiftTable: arrays["\(prefix).prompt_scale_shift_table"]!,
            audioPromptScaleShiftTable: arrays["\(prefix).audio_prompt_scale_shift_table"]!,
            scaleShiftTableA2VCAVideo: arrays["\(prefix).scale_shift_table_a2v_ca_video"]!,
            scaleShiftTableA2VCAAudio: arrays["\(prefix).scale_shift_table_a2v_ca_audio"]!)
    }

    func testFullModelForwardPass() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("model.safetensors"))

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

        let blocks = (0..<cfg.numLayers).map { makeBlock(arrays, prefix: "transformer_blocks.\($0)", cfg: cfg) }

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
            transformerBlocks: blocks)

        let (videoOut, audioOut) = model(
            videoLatent: arrays["video_latent"]!, audioLatent: arrays["audio_latent"]!, timestep: arrays["timestep"]!,
            videoTextEmbeds: arrays["video_text_embeds"], audioTextEmbeds: arrays["audio_text_embeds"],
            videoPositions: arrays["video_positions"]!.asType(.int32), audioPositions: arrays["audio_positions"]!.asType(.int32))
        MLX.eval(videoOut, audioOut)

        let expectedVideo = arrays["video_output"]!
        let expectedAudio = arrays["audio_output"]!

        XCTAssertEqual(videoOut.shape, expectedVideo.shape)
        let videoDiff = MLX.abs(videoOut.asType(.float32) - expectedVideo.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(videoDiff, 5e-3, "video output max abs diff \(videoDiff)")

        XCTAssertEqual(audioOut.shape, expectedAudio.shape)
        let audioDiff = MLX.abs(audioOut.asType(.float32) - expectedAudio.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(audioDiff, 5e-3, "audio output max abs diff \(audioDiff)")
    }

    /// Milestone 2c wiring check: `isolateModality: true` must actually
    /// disable BOTH cross-modal attention directions (reference:
    /// `mod_perturbations = [SKIP_A2V_CROSS_ATTN, SKIP_V2A_CROSS_ATTN]`,
    /// `blocks=None` — i.e. every block, both directions). Uses the same
    /// real-parity fixture as `testFullModelForwardPass`; asserts the
    /// isolated-modality pass diverges from the normal pass (proving the
    /// flag reaches every block and changes the computation) rather than
    /// checking a specific expected value (no reference dump exists for
    /// this branch).
    func testIsolateModalityDisablesCrossModalAttention() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("model.safetensors"))

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

        let blocks = (0..<cfg.numLayers).map { makeBlock(arrays, prefix: "transformer_blocks.\($0)", cfg: cfg) }

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
            transformerBlocks: blocks)

        let commonArgs: (videoLatent: MLXArray, audioLatent: MLXArray, timestep: MLXArray, videoPositions: MLXArray, audioPositions: MLXArray) = (
            arrays["video_latent"]!, arrays["audio_latent"]!, arrays["timestep"]!,
            arrays["video_positions"]!.asType(.int32), arrays["audio_positions"]!.asType(.int32))

        let (normalVideo, normalAudio) = model(
            videoLatent: commonArgs.videoLatent, audioLatent: commonArgs.audioLatent, timestep: commonArgs.timestep,
            videoTextEmbeds: arrays["video_text_embeds"], audioTextEmbeds: arrays["audio_text_embeds"],
            videoPositions: commonArgs.videoPositions, audioPositions: commonArgs.audioPositions)

        let (isolatedVideo, isolatedAudio) = model(
            videoLatent: commonArgs.videoLatent, audioLatent: commonArgs.audioLatent, timestep: commonArgs.timestep,
            videoTextEmbeds: arrays["video_text_embeds"], audioTextEmbeds: arrays["audio_text_embeds"],
            videoPositions: commonArgs.videoPositions, audioPositions: commonArgs.audioPositions,
            isolateModality: true)
        MLX.eval(normalVideo, normalAudio, isolatedVideo, isolatedAudio)

        XCTAssertEqual(isolatedVideo.shape, normalVideo.shape)
        XCTAssertEqual(isolatedAudio.shape, normalAudio.shape)

        let videoDiff = MLX.abs(isolatedVideo.asType(.float32) - normalVideo.asType(.float32)).max().item(Float.self)
        let audioDiff = MLX.abs(isolatedAudio.asType(.float32) - normalAudio.asType(.float32)).max().item(Float.self)
        XCTAssertGreaterThan(videoDiff, 1e-5, "isolating cross-modal attention should change video output")
        XCTAssertGreaterThan(audioDiff, 1e-5, "isolating cross-modal attention should change audio output")
    }
}
