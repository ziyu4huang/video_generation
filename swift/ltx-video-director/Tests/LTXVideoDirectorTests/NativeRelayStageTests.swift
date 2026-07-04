import XCTest
@testable import LTXVideoDirector

/// Fast, no-checkpoint-needed contract tests for NativeRelayStage's
/// fail-fast validation, mirroring NativeI2VStageRealCheckpointTests'
/// testNonPositiveDimensionsThrowInvalidDimensions pattern. The real
/// end-to-end chaining behavior (segment N's last frame feeding segment
/// N+1's --input-image, final concatenation) needs a real distilled
/// transformer + video VAE checkpoint and two full generations, so it's
/// intentionally NOT covered here — verified manually this session via a
/// real `ltx-video native-relay` run (see PLAN.md's matching milestone).
final class NativeRelayStageTests: XCTestCase {
    func testNoPromptsThrowsNoSegments() {
        let stage = NativeRelayStage()
        let request = NativeRelayStage.Request(prompts: [])
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_relay_no_prompts_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeRelayStage.StageError else {
                XCTFail("expected StageError, got \(error)")
                return
            }
            if case .noSegments = stageError {} else {
                XCTFail("expected .noSegments, got \(stageError)")
            }
        }
    }

    func testMissingFirstImageThrowsNamedError() {
        let stage = NativeRelayStage()
        var request = NativeRelayStage.Request(prompts: ["a red ball on a table"])
        request.firstImagePath = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).png")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_relay_missing_first_image_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeRelayStage.StageError else {
                XCTFail("expected StageError, got \(error)")
                return
            }
            if case .firstImageNotFound = stageError {} else {
                XCTFail("expected .firstImageNotFound, got \(stageError)")
            }
        }
    }
}
