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

    /// STG (Milestone 2b): `perturbationMask` should blend the raw
    /// attention output with the value projection — `out*mask + v*(1-mask)`
    /// (reference: `ltx_core_mlx.model.transformer.attention.Attention
    /// .__call__`'s `perturbation_mask` branch). No fixture needed: this
    /// checks the blend algebra itself against a from-scratch value
    /// projection, using random weights and no gate (so the only
    /// post-attention op is `to_out`, keeping the manual comparison exact).
    func testSTGPerturbationMaskBlendsToValueProjection() throws {
        let numHeads = 2, headDim = 4, innerDim = numHeads * headDim, queryDim = 6
        let x = MLXRandom.normal([1, 5, queryDim])
        func randLinear(_ inDim: Int, _ outDim: Int) -> MLXArray { MLXRandom.normal([outDim, inDim]) * 0.1 }
        let toQWeight = randLinear(queryDim, innerDim), toKWeight = randLinear(queryDim, innerDim), toVWeight = randLinear(queryDim, innerDim)
        let toOutWeight = randLinear(innerDim, queryDim)
        let attn = Attention(
            numHeads: numHeads, headDim: headDim, useRope: false,
            toQWeight: toQWeight, toQBias: nil,
            toKWeight: toKWeight, toKBias: nil,
            toVWeight: toVWeight, toVBias: nil,
            toOutWeight: toOutWeight, toOutBias: MLXArray.zeros([queryDim]),
            toGateLogitsWeight: nil, toGateLogitsBias: nil,
            qNormWeight: MLXArray.ones([innerDim]), kNormWeight: MLXArray.ones([innerDim]))

        // mask=1.0 (no perturbation) must be identical to the unperturbed call.
        let unperturbed = attn(x)
        let maskOne = attn(x, perturbationMask: MLXArray(Float(1.0)))
        MLX.eval(unperturbed, maskOne)
        XCTAssertLessThan(MLX.abs(unperturbed - maskOne).max().item(Float.self), 1e-6)

        // mask=0.0 (full perturbation) must equal to_out(v) exactly, since
        // there's no gate here to complicate the comparison.
        let maskZero = attn(x, perturbationMask: MLXArray(Float(0.0)))
        let v = MLX.matmul(x, toVWeight.transposed(1, 0))
        let expectedFromV = MLX.matmul(v, toOutWeight.transposed(1, 0))
        MLX.eval(maskZero, expectedFromV)
        let diff = MLX.abs(maskZero - expectedFromV).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-4, "max abs diff \(diff)")

        // Sanity: perturbation must actually change the output relative to
        // the unperturbed pass (a no-op blend would silently defeat STG).
        XCTAssertGreaterThan(MLX.abs(maskZero - unperturbed).max().item(Float.self), 1e-3)
    }
}
