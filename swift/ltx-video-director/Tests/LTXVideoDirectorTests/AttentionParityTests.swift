import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.model.transformer.
/// attention.Attention — covers both attention "shapes" the 48-layer DiT
/// uses: self-attention with RoPE, and cross-attention without RoPE (video
/// <-> text/audio). See scripts/dump_attention_reference.py, PLAN.md Phase 2.
final class AttentionParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/attention")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/attention")
    }

    private func makeAttention(from arrays: [String: MLXArray], numHeads: Int, headDim: Int, useRope: Bool) -> Attention {
        Attention(
            numHeads: numHeads, headDim: headDim, useRope: useRope,
            toQWeight: arrays["to_q.weight"]!, toQBias: arrays["to_q.bias"],
            toKWeight: arrays["to_k.weight"]!, toKBias: arrays["to_k.bias"],
            toVWeight: arrays["to_v.weight"]!, toVBias: arrays["to_v.bias"],
            toOutWeight: arrays["to_out.weight"]!, toOutBias: arrays["to_out.bias"]!,
            toGateLogitsWeight: arrays["to_gate_logits.weight"], toGateLogitsBias: arrays["to_gate_logits.bias"],
            qNormWeight: arrays["q_norm.weight"]!, kNormWeight: arrays["k_norm.weight"]!)
    }

    func testSelfAttentionWithRoPE() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("self_attn_rope.safetensors"))
        guard let input = arrays["input"], let cos = arrays["cos"], let sin = arrays["sin"],
              let expected = arrays["output"] else {
            XCTFail("missing tensors")
            return
        }
        let attn = makeAttention(from: arrays, numHeads: 4, headDim: 8, useRope: true)
        let actual = attn(input, ropeFreqs: RoPE.Freqs(cos: cos, sin: sin))
        MLX.eval(actual)

        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-3, "max abs diff \(diff)")
    }

    func testCrossAttentionWithoutRoPE() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("cross_attn.safetensors"))
        guard let input = arrays["input"], let encoderHiddenStates = arrays["encoder_hidden_states"],
              let expected = arrays["output"] else {
            XCTFail("missing tensors")
            return
        }
        let attn = makeAttention(from: arrays, numHeads: 4, headDim: 8, useRope: false)
        let actual = attn(input, encoderHiddenStates: encoderHiddenStates)
        MLX.eval(actual)

        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-3, "max abs diff \(diff)")
    }
}
