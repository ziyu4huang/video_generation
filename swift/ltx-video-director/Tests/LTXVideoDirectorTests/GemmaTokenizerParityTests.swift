import XCTest
import MLX
@testable import LTXVideoDirector

/// Verifies the standalone Gemma SentencePiece-BPE tokenizer produces the
/// EXACT token_ids + attention_mask the reference GemmaLanguageModel.tokenize()
/// produced for the dump prompt. Closes the last piece of the native
/// text → hidden states path.
final class GemmaTokenizerParityTests: XCTestCase {
    private var refsDir: URL {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 {
            let c = dir.appendingPathComponent("test_refs/gemma")
            if FileManager.default.fileExists(atPath: c.path) { return c }
            dir = dir.deletingLastPathComponent()
        }
        return URL(fileURLWithPath: "test_refs/gemma")
    }

    func testTokenizeMatchesReference() throws {
        let ref = try MLX.loadArrays(url: refsDir.appendingPathComponent("ref.safetensors"))
        let expectedIds = ref["token_ids"]!
        let expectedMask = ref["attention_mask"]!

        let snapshot = try GemmaCheckpointLoader.snapshotDir()
        var tok = try GemmaTokenizer(
            tokenizerJSON: snapshot.appendingPathComponent("tokenizer.json"), maxLength: 64)

        let prompt = "<start_of_turn>user\nA woman waves on a city street.<end_of_turn>\n<start_of_turn>model\n"
        let (ids, mask) = tok.tokenize(prompt)

        XCTAssertEqual(ids.shape, expectedIds.shape, "token_ids shape")
        let dIds = MLX.abs(ids - expectedIds).max().item(Int32.self)
        let dMask = MLX.abs(mask - expectedMask).max().item(Int32.self)
        XCTAssertEqual(dIds, 0, "token_ids differ from reference (max \(dIds))")
        XCTAssertEqual(dMask, 0, "attention_mask differ from reference (max \(dMask))")
    }
}
