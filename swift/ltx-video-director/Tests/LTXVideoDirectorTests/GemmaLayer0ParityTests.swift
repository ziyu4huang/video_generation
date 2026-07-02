import XCTest
import MLX
@testable import LTXVideoDirector

/// End-to-end parity check of the Gemma-3-12b encode path's atomic first unit
/// against REAL production weights: tokenizer output (token_ids from the dump)
/// → embed_tokens + sqrt(hidden) scaling → layer-0 transformer block.
///
/// Diffs against the h0_embedding / h1_layer0 tensors captured by
/// scripts/dump_gemma_reference.py (which ran the REAL GemmaLanguageModel).
/// Looser tolerance than synthetic-weight tests: the reference ran in bfloat16
/// and the dump stored fp16; our port runs fp32. See PLAN.md's Gemma section.
final class GemmaLayer0ParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("test_refs/gemma")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/gemma")
    }

    func testEmbedAndLayer0MatchReference() throws {
        let ref = try MLX.loadArrays(url: refsDir.appendingPathComponent("ref.safetensors"))
        let tokenIds = ref["token_ids"]!
        let attnMask = ref["attention_mask"]!
        let h0Expected = ref["h0_embedding"]!.asType(.float32)
        let h1Expected = ref["h1_layer0"]!.asType(.float32)

        // Load REAL Gemma weights from the HF cache (~7.5 GB, one-time per run).
        let raw = try GemmaCheckpointLoader.loadRaw()

        let config = GemmaConfig()
        let embed = GemmaEmbedding(
            embedWeight: GemmaCheckpointLoader.embedTokens(raw), hiddenSize: Float(config.hiddenSize))
        let h0 = embed(tokenIds)
        MLX.eval(h0)

        // h0: embed output has small magnitude (absmax ~40); absolute tolerance OK.
        let h0f = h0.asType(.float32)
        XCTAssertEqual(h0f.shape, h0Expected.shape, "h0 shape")
        let diffH0 = MLX.abs(h0f - h0Expected).max().item(Float.self)
        XCTAssertLessThan(diffH0, 5e-2, "h0 (embed+scale) max abs diff \(diffH0)")

        // Layer 0.
        let block = GemmaCheckpointLoader.block(raw, layerIdx: 0, config: config)
        let mask = GemmaMask.causalCombined(tokenIds: tokenIds, attentionMask: attnMask)
        let h1 = block(h0, mask: mask)
        MLX.eval(h1)

        let h1f = h1.asType(.float32)
        XCTAssertEqual(h1f.shape, h1Expected.shape, "h1 shape")
        // Gemma's residual stream is NOT re-normalized between layers, so |h1|
        // grows large (absmax ~10000). Absolute diff is meaningless at that
        // scale — use RELATIVE error (diff / absmax). The reference ran in
        // bfloat16 and was stored fp16; this fp32 port legitimately differs by
        // ~0.3% relative. 5% headroom absorbs the few blow-up elements from
        // near-zero-RMS tokens. (Diagnostic: every intermediate step is
        // 0.1-1.6% relative — see GemmaLayer0DiagnosticTests.)
        let absMaxH1 = MLX.abs(h1Expected).max().item(Float.self)
        let diffH1 = MLX.abs(h1f - h1Expected).max().item(Float.self)
        XCTAssertLessThan(diffH1 / absMaxH1, 0.05, "h1 (layer-0) relative diff \(diffH1)/\(absMaxH1) = \(diffH1/absMaxH1*100)%")
    }
}
