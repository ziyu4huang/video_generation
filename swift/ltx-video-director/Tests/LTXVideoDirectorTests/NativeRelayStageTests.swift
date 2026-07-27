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

    func testMissingAudioOverlayThrowsNamedError() {
        let stage = NativeRelayStage()
        var request = NativeRelayStage.Request(prompts: ["a red ball on a table"])
        request.audioOverlayPath = FileManager.default.temporaryDirectory.appendingPathComponent("does_not_exist_\(UUID().uuidString).wav")
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_relay_missing_audio_overlay_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeRelayStage.StageError else {
                XCTFail("expected StageError, got \(error)")
                return
            }
            if case .audioOverlayNotFound = stageError {} else {
                XCTFail("expected .audioOverlayNotFound, got \(stageError)")
            }
        }
    }

    /// Grid-guide config is forwarded to every segment's NativeI2VStage.Request
    /// (see NativeRelayStage.swift's generate() loop), so a mismatched
    /// gridFrameIndices count surfaces as NativeI2VStage's own fail-fast
    /// error on segment 1 — before any model loading, same as the checks
    /// above. Real grid-guide *conditioning* behavior is covered end-to-end
    /// by NativeI2VStageGridGuideTests (needs real checkpoints); this only
    /// proves the relay-level plumbing forwards the config at all.
    func testGridConfigMismatchThrowsThroughFirstSegment() {
        let stage = NativeRelayStage()
        var request = NativeRelayStage.Request(prompts: ["a red ball on a table"])
        let gridURL = FileManager.default.temporaryDirectory.appendingPathComponent("grid_\(UUID().uuidString).png")
        FileManager.default.createFile(atPath: gridURL.path, contents: Data())
        defer { try? FileManager.default.removeItem(at: gridURL) }
        request.gridImagePath = gridURL
        request.gridColumns = 2
        request.gridRows = 2
        // Deliberately wrong: only 3 indices for a 2x2 (4-panel) grid.
        request.gridFrameIndices = [0, 1, 2]
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_relay_grid_mismatch_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeI2VStage.StageError else {
                XCTFail("expected NativeI2VStage.StageError, got \(error)")
                return
            }
            if case .gridConfigMismatch = stageError {} else {
                XCTFail("expected .gridConfigMismatch, got \(stageError)")
            }
        }
    }

    func testSecondsPerSegmentCountMismatchThrows() {
        let stage = NativeRelayStage()
        var request = NativeRelayStage.Request(prompts: ["a red ball", "a blue ball"])
        request.secondsPerSegment = [2.0] // 1 entry, need 2
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_relay_seconds_mismatch_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeRelayStage.StageError else {
                XCTFail("expected StageError, got \(error)")
                return
            }
            if case .secondsPerSegmentCountMismatch(let count, let segments) = stageError {
                XCTAssertEqual(count, 1)
                XCTAssertEqual(segments, 2)
            } else {
                XCTFail("expected .secondsPerSegmentCountMismatch, got \(stageError)")
            }
        }
    }

    func testSegmentContinuityCountMismatchThrows() {
        let stage = NativeRelayStage()
        var request = NativeRelayStage.Request(prompts: ["a red ball", "a blue ball"])
        request.segmentContinuity = [true] // 1 entry, need 2
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_relay_continuity_mismatch_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeRelayStage.StageError else {
                XCTFail("expected StageError, got \(error)")
                return
            }
            if case .segmentContinuityCountMismatch(let count, let segments) = stageError {
                XCTAssertEqual(count, 1)
                XCTAssertEqual(segments, 2)
            } else {
                XCTFail("expected .segmentContinuityCountMismatch, got \(stageError)")
            }
        }
    }

    func testCameraMovementsCountMismatchThrows() {
        let stage = NativeRelayStage()
        var request = NativeRelayStage.Request(prompts: ["a red ball", "a blue ball"])
        request.cameraMovements = ["dolly_in"] // 1 entry, need 2
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_relay_camera_movements_mismatch_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeRelayStage.StageError else {
                XCTFail("expected StageError, got \(error)")
                return
            }
            if case .cameraMovementsCountMismatch(let count, let segments) = stageError {
                XCTAssertEqual(count, 1)
                XCTAssertEqual(segments, 2)
            } else {
                XCTFail("expected .cameraMovementsCountMismatch, got \(stageError)")
            }
        }
    }

    /// A v1-supported movement with no cameraLoraPath must fail fast, before
    /// any model loading — surfaced up front (unlike the per-segment
    /// fallback-with-warning behavior for unsupported movements or missing
    /// start images, which only apply mid-loop).
    func testSupportedCameraMovementWithoutLoraPathThrows() {
        let stage = NativeRelayStage()
        var request = NativeRelayStage.Request(prompts: ["a red ball"])
        request.cameraMovements = ["dolly_in"]
        let outputDir = FileManager.default.temporaryDirectory.appendingPathComponent("native_relay_camera_lora_missing_\(UUID().uuidString)")
        XCTAssertThrowsError(try stage.generate(request, outputDir: outputDir)) { error in
            guard let stageError = error as? NativeRelayStage.StageError else {
                XCTFail("expected StageError, got \(error)")
                return
            }
            if case .cameraLoraRequiredForSupportedMovement(let movement) = stageError {
                XCTAssertEqual(movement, "dolly_in")
            } else {
                XCTFail("expected .cameraLoraRequiredForSupportedMovement, got \(stageError)")
            }
        }
    }
}
