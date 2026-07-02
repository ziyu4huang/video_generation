import XCTest
import MLX
@testable import LTXVideoDirector

/// Numerical parity check against ltx_core_mlx.text_encoders.gemma.
/// embeddings_connector.Embeddings1DConnector (attention_mask=None path —
/// registers appended, not left-padding replacement). See
/// scripts/dump_connector_reference.py, PLAN.md's text-encoder work.
final class EmbeddingsConnectorParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/connector")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/connector")
    }

    func testConnectorAppendRegistersPath() throws {
        let arrays = try MLX.loadArrays(url: refsDir.appendingPathComponent("connector.safetensors"))
        let dim = 16, numHeads = 2, headDim = 8, numLayers = 2

        func makeBlock(_ idx: Int) -> ConnectorTransformerBlock {
            let prefix = "transformer_1d_blocks.\(idx)"
            let attn = Attention(
                numHeads: numHeads, headDim: headDim, useRope: true,
                toQWeight: arrays["\(prefix).attn1.to_q.weight"]!, toQBias: arrays["\(prefix).attn1.to_q.bias"],
                toKWeight: arrays["\(prefix).attn1.to_k.weight"]!, toKBias: arrays["\(prefix).attn1.to_k.bias"],
                toVWeight: arrays["\(prefix).attn1.to_v.weight"]!, toVBias: arrays["\(prefix).attn1.to_v.bias"],
                toOutWeight: arrays["\(prefix).attn1.to_out.0.weight"]!, toOutBias: arrays["\(prefix).attn1.to_out.0.bias"]!,
                toGateLogitsWeight: arrays["\(prefix).attn1.to_gate_logits.weight"], toGateLogitsBias: arrays["\(prefix).attn1.to_gate_logits.bias"],
                qNormWeight: arrays["\(prefix).attn1.q_norm.weight"]!, kNormWeight: arrays["\(prefix).attn1.k_norm.weight"]!)
            let ff = FeedForward(
                projInWeight: arrays["\(prefix).ff.net.0.proj.weight"]!, projInBias: arrays["\(prefix).ff.net.0.proj.bias"]!,
                projOutWeight: arrays["\(prefix).ff.net.2.weight"]!, projOutBias: arrays["\(prefix).ff.net.2.bias"]!)
            return ConnectorTransformerBlock(attn: attn, ff: ff, normEps: 1e-6)
        }

        let blocks = (0..<numLayers).map(makeBlock)
        let connector = Embeddings1DConnector(
            learnableRegisters: arrays["learnable_registers"]!, blocks: blocks,
            dim: dim, headDim: headDim, maxPos: 64, normOutput: true)

        let actual = connector(arrays["hidden_states"]!)
        MLX.eval(actual)

        let expected = arrays["output"]!
        XCTAssertEqual(actual.shape, expected.shape)
        let diff = MLX.abs(actual.asType(.float32) - expected.asType(.float32)).max().item(Float.self)
        XCTAssertLessThan(diff, 1e-3, "max abs diff \(diff)")
    }
}
