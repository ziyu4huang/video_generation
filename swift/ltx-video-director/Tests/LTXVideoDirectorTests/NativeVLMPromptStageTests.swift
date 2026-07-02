import XCTest
@testable import LTXVideoDirector

/// Unit tests for NativeVLMPromptStage.parse — the pure, network-free part
/// of the VLM prompt-expansion stage. (expand() itself calls LM Studio, not
/// parity-tested here — same convention as VLMVerify's network path.) Covers
/// the three real failure modes the VLM exhibits: markdown-fence-wrapped JSON,
/// non-JSON content, and the `estimated_seconds` field arriving as a float
/// (some models emit `10.0` instead of `10`).
final class NativeVLMPromptStageTests: XCTestCase {
    func testParsesCleanJSON() throws {
        let raw = #"{"prompt":"a woman turns","voice_lang":"zh_TW","motion_summary":"head turn","estimated_seconds":10}"#
        let p = try NativeVLMPromptStage.parse(raw)
        XCTAssertEqual(p.prompt, "a woman turns")
        XCTAssertEqual(p.voiceLang, "zh_TW")
        XCTAssertEqual(p.motionSummary, "head turn")
        XCTAssertEqual(p.estimatedSeconds, 10)
    }

    func testStripsMarkdownFences() throws {
        let raw = """
        ```json
        {"prompt":"x","voice_lang":"zh_TW","motion_summary":"m","estimated_seconds":8}
        ```
        """
        let p = try NativeVLMPromptStage.parse(raw)
        XCTAssertEqual(p.prompt, "x")
        XCTAssertEqual(p.estimatedSeconds, 8)
    }

    func testEstimatedSecondsAsFloat() throws {
        // Some models emit estimated_seconds as a float despite the schema;
        // JSONSerialization reads it as NSNumber → truncates to Int.
        let raw = #"{"prompt":"x","estimated_seconds":12.0}"#
        let p = try NativeVLMPromptStage.parse(raw)
        XCTAssertEqual(p.estimatedSeconds, 12)
        // Defaults for omitted optional fields.
        XCTAssertEqual(p.voiceLang, "zh_TW")
        XCTAssertEqual(p.motionSummary, "")
    }

    func testRejectsNonJSON() {
        XCTAssertThrowsError(try NativeVLMPromptStage.parse("not json at all")) { err in
            guard case .notJSON = (err as? NativeVLMPromptStage.StageError) else {
                XCTFail("expected .notJSON, got \(err)")
                return
            }
        }
    }

    func testRejectsMissingPrompt() {
        let raw = #"{"voice_lang":"zh_TW"}"#  // no prompt field
        XCTAssertThrowsError(try NativeVLMPromptStage.parse(raw)) { err in
            guard case .missingField("prompt", _) = (err as? NativeVLMPromptStage.StageError) else {
                XCTFail("expected .missingField(prompt), got \(err)")
                return
            }
        }
    }
}
