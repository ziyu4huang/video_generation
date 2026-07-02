import XCTest
import MLX
@testable import LTXVideoDirector

/// Full 48-layer Gemma encoder parity: runs embed + all 48 streaming blocks
/// and diffs the LAST hidden state (h48) against the real reference dump.
/// Confirms the ~0.3% per-layer bf16-vs-fp32 error accumulates to a bounded
/// relative error over the full 48-layer depth (no pathological blow-up).
final class GemmaFullEncoderParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let c = dir.appendingPathComponent("test_refs/gemma")
            if FileManager.default.fileExists(atPath: c.path) { return c }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/gemma")
    }

    func testFullEncoderLastLayerMatches() throws {
        let ref = try MLX.loadArrays(url: refsDir.appendingPathComponent("ref.safetensors"))
        let tokenIds = ref["token_ids"]!
        let attnMask = ref["attention_mask"]!
        let h48Expected = ref["h48_last"]!.asType(.float32)

        let raw = try GemmaCheckpointLoader.loadRaw()
        let config = GemmaConfig()

        let embed = GemmaEmbedding(
            embedWeight: GemmaCheckpointLoader.embedTokens(raw), hiddenSize: Float(config.hiddenSize))
        var h = embed(tokenIds)
        let mask = GemmaMask.causalCombined(tokenIds: tokenIds, attentionMask: attnMask)

        for layerIdx in 0..<config.numHiddenLayers {
            let block = GemmaCheckpointLoader.block(raw, layerIdx: layerIdx, config: config)
            h = block(h, mask: mask)
            MLX.eval(h)
        }
        // h is now the layer-47 output = states[48] = h48.

        XCTAssertEqual(h.shape, h48Expected.shape, "h48 shape")
        let absMax = MLX.abs(h48Expected).max().item(Float.self)
        let diff = MLX.abs(h.asType(.float32) - h48Expected).max().item(Float.self)
        let rel = diff / absMax
        // 48 layers of ~0.3% bf16-vs-fp32 accumulation. Allow 5% headroom for
        // the un-normalized residual stream's blow-up elements.
        XCTAssertLessThan(rel, 0.05, "h48 relative diff \(diff)/\(absMax) = \(rel*100)%")
    }
}
