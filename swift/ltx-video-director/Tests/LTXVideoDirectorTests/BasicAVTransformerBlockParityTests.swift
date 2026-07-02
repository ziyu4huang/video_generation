import XCTest
import MLX
@testable import LTXVideoDirector

/// End-to-end parity check of the FULL joint audio+video transformer block
/// against the real ltx_core_mlx.model.transformer.transformer.
/// BasicAVTransformerBlock class (real architecture, fixed-seed random
/// weights, small dims). This is the block stacked 48x into the actual
/// LTX-2.3 DiT — the single largest validation in the whole port so far,
/// exercising every component built in Phase 2 (RoPE, TimestepEmbedding-
/// derived AdaLN params, Attention x6 instances, FeedForward x2) wired
/// together exactly as the reference does. See
/// scripts/dump_basicavblock_reference.py, PLAN.md Phase 2.
final class BasicAVTransformerBlockParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/basic_av_block")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/basic_av_block")
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

    func testFullBlockForwardPass() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("block.safetensors"))

        let videoNumHeads = 4, videoHeadDim = 8
        let audioNumHeads = 4, audioHeadDim = 4
        let avCrossNumHeads = 4, avCrossHeadDim = 4

        let block = BasicAVTransformerBlock(
            attn1: makeAttention(arrays, prefix: "attn1", numHeads: videoNumHeads, headDim: videoHeadDim, useRope: true),
            audioAttn1: makeAttention(arrays, prefix: "audio_attn1", numHeads: audioNumHeads, headDim: audioHeadDim, useRope: true),
            attn2: makeAttention(arrays, prefix: "attn2", numHeads: videoNumHeads, headDim: videoHeadDim, useRope: false),
            audioAttn2: makeAttention(arrays, prefix: "audio_attn2", numHeads: audioNumHeads, headDim: audioHeadDim, useRope: false),
            audioToVideoAttn: makeAttention(arrays, prefix: "audio_to_video_attn", numHeads: avCrossNumHeads, headDim: avCrossHeadDim, useRope: true),
            videoToAudioAttn: makeAttention(arrays, prefix: "video_to_audio_attn", numHeads: avCrossNumHeads, headDim: avCrossHeadDim, useRope: true),
            ff: makeFF(arrays, prefix: "ff"),
            audioFF: makeFF(arrays, prefix: "audio_ff"),
            scaleShiftTable: arrays["scale_shift_table"]!,
            audioScaleShiftTable: arrays["audio_scale_shift_table"]!,
            promptScaleShiftTable: arrays["prompt_scale_shift_table"]!,
            audioPromptScaleShiftTable: arrays["audio_prompt_scale_shift_table"]!,
            scaleShiftTableA2VCAVideo: arrays["scale_shift_table_a2v_ca_video"]!,
            scaleShiftTableA2VCAAudio: arrays["scale_shift_table_a2v_ca_audio"]!)

        let (videoOut, audioOut) = block(
            videoHidden: arrays["video_hidden"]!, audioHidden: arrays["audio_hidden"]!,
            videoAdaLNParams: arrays["video_adaln_params"]!, audioAdaLNParams: arrays["audio_adaln_params"]!,
            videoPromptAdaLNParams: arrays["video_prompt_adaln_params"]!, audioPromptAdaLNParams: arrays["audio_prompt_adaln_params"]!,
            avCAVideoParams: arrays["av_ca_video_params"]!, avCAAudioParams: arrays["av_ca_audio_params"]!,
            avCAA2VGateParams: arrays["av_ca_a2v_gate_params"]!, avCAV2AGateParams: arrays["av_ca_v2a_gate_params"]!,
            videoTextEmbeds: arrays["video_text_embeds"], audioTextEmbeds: arrays["audio_text_embeds"],
            videoRopeFreqs: RoPE.Freqs(cos: arrays["video_rope_cos"]!, sin: arrays["video_rope_sin"]!),
            audioRopeFreqs: RoPE.Freqs(cos: arrays["audio_rope_cos"]!, sin: arrays["audio_rope_sin"]!),
            videoCrossRopeFreqs: RoPE.Freqs(cos: arrays["video_cross_rope_cos"]!, sin: arrays["video_cross_rope_sin"]!),
            audioCrossRopeFreqs: RoPE.Freqs(cos: arrays["audio_cross_rope_cos"]!, sin: arrays["audio_cross_rope_sin"]!)
        )
        MLX.eval(videoOut, audioOut)

        let expectedVideo = arrays["video_output"]!
        let expectedAudio = arrays["audio_output"]!

        XCTAssertEqual(videoOut.shape, expectedVideo.shape)
        let videoDiff = MLX.abs(videoOut.asType(.float32) - expectedVideo.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(videoDiff, 2e-3, "video output max abs diff \(videoDiff)")

        XCTAssertEqual(audioOut.shape, expectedAudio.shape)
        let audioDiff = MLX.abs(audioOut.asType(.float32) - expectedAudio.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(audioDiff, 2e-3, "audio output max abs diff \(audioDiff)")
    }
}
