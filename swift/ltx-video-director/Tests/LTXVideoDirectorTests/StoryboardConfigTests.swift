import XCTest
@testable import LTXVideoDirector

final class StoryboardConfigTests: XCTestCase {
    private let baseDir = URL(fileURLWithPath: "/tmp/storyboard-config-tests")

    private func makeConfig(
        transitionMode: StoryboardConfig.TransitionMode,
        segments: [StoryboardConfig.Segment],
        prompt: String? = nil
    ) -> StoryboardConfig {
        StoryboardConfig(
            version: 1,
            transitionMode: transitionMode,
            prompt: prompt,
            width: nil, height: nil, fps: nil, seed: nil,
            t2iTransformer: nil, textMaxLength: nil, seconds: nil,
            grid: .init(image: "grid.png", columns: 2, rows: 2),
            segments: segments,
            loras: nil,
            audio: nil,
            output: nil)
    }

    // MARK: - defaultGridStrength

    func testDefaultGridStrengthPerTransitionMode() {
        XCTAssertEqual(StoryboardConfig.TransitionMode.cameraMove.defaultGridStrength, 0.8)
        XCTAssertEqual(StoryboardConfig.TransitionMode.hardCut.defaultGridStrength, 0.525)
    }

    // MARK: - camera-move

    func testCameraMoveUsesExplicitStrengthWhenGiven() throws {
        let segments = (0..<4).map {
            StoryboardConfig.Segment(panel: $0, prompt: nil, frameIndex: $0 * 32, strength: 0.9)
        }
        let config = makeConfig(transitionMode: .cameraMove, segments: segments, prompt: "a continuous shot")
        let request = try config.toCameraMoveRequest(baseDir: baseDir)
        XCTAssertEqual(request.gridStrengths, [0.9, 0.9, 0.9, 0.9])
    }

    func testCameraMoveFallsBackToModeDefaultStrengthWhenOmitted() throws {
        let segments = (0..<4).map {
            StoryboardConfig.Segment(panel: $0, prompt: nil, frameIndex: $0 * 32, strength: nil)
        }
        let config = makeConfig(transitionMode: .cameraMove, segments: segments, prompt: "a continuous shot")
        let request = try config.toCameraMoveRequest(baseDir: baseDir)
        XCTAssertEqual(request.gridStrengths, Array(repeating: Float(0.8), count: 4))
    }

    func testCameraMoveBuildsFrameIndicesAndPromptAndGridFields() throws {
        let segments = [
            StoryboardConfig.Segment(panel: 0, prompt: nil, frameIndex: 0, strength: nil),
            StoryboardConfig.Segment(panel: 1, prompt: nil, frameIndex: 96, strength: nil),
            StoryboardConfig.Segment(panel: 2, prompt: nil, frameIndex: 192, strength: nil),
            StoryboardConfig.Segment(panel: 3, prompt: nil, frameIndex: 287, strength: nil),
        ]
        let config = makeConfig(transitionMode: .cameraMove, segments: segments, prompt: "one continuous shot")
        let request = try config.toCameraMoveRequest(baseDir: baseDir)
        XCTAssertEqual(request.prompt, "one continuous shot")
        XCTAssertEqual(request.gridFrameIndices, [0, 96, 192, 287])
        XCTAssertEqual(request.gridColumns, 2)
        XCTAssertEqual(request.gridRows, 2)
        XCTAssertEqual(request.gridImagePath, baseDir.appendingPathComponent("grid.png"))
    }

    func testCameraMoveFallsBackToJoinedSegmentPromptsWhenTopLevelPromptMissing() throws {
        let segments = [
            StoryboardConfig.Segment(panel: 0, prompt: "shot one", frameIndex: 0, strength: nil),
            StoryboardConfig.Segment(panel: 1, prompt: "shot two", frameIndex: 96, strength: nil),
            StoryboardConfig.Segment(panel: 2, prompt: nil, frameIndex: 192, strength: nil),
            StoryboardConfig.Segment(panel: 3, prompt: nil, frameIndex: 287, strength: nil),
        ]
        let config = makeConfig(transitionMode: .cameraMove, segments: segments, prompt: nil)
        let request = try config.toCameraMoveRequest(baseDir: baseDir)
        XCTAssertEqual(request.prompt, "shot one. shot two")
    }

    func testCameraMoveMissingFrameIndexThrows() {
        let segments = [StoryboardConfig.Segment(panel: 0, prompt: nil, frameIndex: nil, strength: nil)]
        let config = makeConfig(transitionMode: .cameraMove, segments: segments, prompt: "x")
        XCTAssertThrowsError(try config.toCameraMoveRequest(baseDir: baseDir)) { error in
            guard case StoryboardConfig.ConfigError.cameraMoveMissingFrameIndex(let panel) = error else {
                return XCTFail("expected cameraMoveMissingFrameIndex, got \(error)")
            }
            XCTAssertEqual(panel, 0)
        }
    }

    func testCameraMoveIncompletePanelCoverageThrows() {
        // Only covers panels 0-2 of a 2x2=4-panel grid — panel 3 missing.
        let segments = (0..<3).map {
            StoryboardConfig.Segment(panel: $0, prompt: nil, frameIndex: $0 * 32, strength: nil)
        }
        let config = makeConfig(transitionMode: .cameraMove, segments: segments, prompt: "x")
        XCTAssertThrowsError(try config.toCameraMoveRequest(baseDir: baseDir)) { error in
            guard case StoryboardConfig.ConfigError.cameraMovePanelCoverage(let panelCount) = error else {
                return XCTFail("expected cameraMovePanelCoverage, got \(error)")
            }
            XCTAssertEqual(panelCount, 4)
        }
    }

    func testCameraMoveMissingCombinedPromptThrows() {
        let segments = (0..<4).map {
            StoryboardConfig.Segment(panel: $0, prompt: nil, frameIndex: $0 * 32, strength: nil)
        }
        let config = makeConfig(transitionMode: .cameraMove, segments: segments, prompt: nil)
        XCTAssertThrowsError(try config.toCameraMoveRequest(baseDir: baseDir)) { error in
            guard case StoryboardConfig.ConfigError.missingCombinedPrompt = error else {
                return XCTFail("expected missingCombinedPrompt, got \(error)")
            }
        }
    }

    func testCameraMoveInvalidPanelIndexThrows() {
        let segments = [StoryboardConfig.Segment(panel: 4, prompt: nil, frameIndex: 0, strength: nil)]
        let config = makeConfig(transitionMode: .cameraMove, segments: segments, prompt: "x")
        XCTAssertThrowsError(try config.toCameraMoveRequest(baseDir: baseDir)) { error in
            guard case StoryboardConfig.ConfigError.invalidPanelIndex(let panel, let panelCount) = error else {
                return XCTFail("expected invalidPanelIndex, got \(error)")
            }
            XCTAssertEqual(panel, 4)
            XCTAssertEqual(panelCount, 4)
        }
    }

    // MARK: - hard-cut

    func testHardCutUsesExplicitStrengthWhenGiven() throws {
        let segments = [
            StoryboardConfig.Segment(panel: 0, prompt: "shot one", frameIndex: nil, strength: 0.6),
            StoryboardConfig.Segment(panel: 1, prompt: "shot two", frameIndex: nil, strength: 0.6),
        ]
        let config = makeConfig(transitionMode: .hardCut, segments: segments)
        let request = try config.toHardCutRequest(baseDir: baseDir)
        XCTAssertEqual(request.segmentGridStrengths, [0.6, 0.6])
    }

    func testHardCutFallsBackToModeDefaultStrengthWhenOmitted() throws {
        let segments = [
            StoryboardConfig.Segment(panel: 0, prompt: "shot one", frameIndex: nil, strength: nil),
            StoryboardConfig.Segment(panel: 1, prompt: "shot two", frameIndex: nil, strength: nil),
        ]
        let config = makeConfig(transitionMode: .hardCut, segments: segments)
        let request = try config.toHardCutRequest(baseDir: baseDir)
        XCTAssertEqual(request.segmentGridStrengths, [0.525, 0.525])
    }

    func testHardCutBuildsPerSegmentPromptsAndPanels() throws {
        let segments = [
            StoryboardConfig.Segment(panel: 2, prompt: "shot one", frameIndex: nil, strength: nil),
            StoryboardConfig.Segment(panel: 0, prompt: "shot two", frameIndex: nil, strength: nil),
        ]
        let config = makeConfig(transitionMode: .hardCut, segments: segments)
        let request = try config.toHardCutRequest(baseDir: baseDir)
        XCTAssertEqual(request.prompts, ["shot one", "shot two"])
        XCTAssertEqual(request.segmentGridPanels, [2, 0])
        XCTAssertEqual(request.gridImagePath, baseDir.appendingPathComponent("grid.png"))
    }

    func testHardCutMissingSegmentPromptThrows() {
        let segments = [StoryboardConfig.Segment(panel: 0, prompt: nil, frameIndex: nil, strength: nil)]
        let config = makeConfig(transitionMode: .hardCut, segments: segments)
        XCTAssertThrowsError(try config.toHardCutRequest(baseDir: baseDir)) { error in
            guard case StoryboardConfig.ConfigError.missingPromptForSegment(let i) = error else {
                return XCTFail("expected missingPromptForSegment, got \(error)")
            }
            XCTAssertEqual(i, 0)
        }
    }

    func testHardCutInvalidPanelIndexThrows() {
        let segments = [StoryboardConfig.Segment(panel: 9, prompt: "shot", frameIndex: nil, strength: nil)]
        let config = makeConfig(transitionMode: .hardCut, segments: segments)
        XCTAssertThrowsError(try config.toHardCutRequest(baseDir: baseDir)) { error in
            guard case StoryboardConfig.ConfigError.invalidPanelIndex(let panel, let panelCount) = error else {
                return XCTFail("expected invalidPanelIndex, got \(error)")
            }
            XCTAssertEqual(panel, 9)
            XCTAssertEqual(panelCount, 4)
        }
    }

    func testNoSegmentsThrowsForBothModes() {
        let cameraMove = makeConfig(transitionMode: .cameraMove, segments: [], prompt: "x")
        XCTAssertThrowsError(try cameraMove.toCameraMoveRequest(baseDir: baseDir)) { error in
            guard case StoryboardConfig.ConfigError.noSegments = error else {
                return XCTFail("expected noSegments, got \(error)")
            }
        }
        let hardCut = makeConfig(transitionMode: .hardCut, segments: [])
        XCTAssertThrowsError(try hardCut.toHardCutRequest(baseDir: baseDir)) { error in
            guard case StoryboardConfig.ConfigError.noSegments = error else {
                return XCTFail("expected noSegments, got \(error)")
            }
        }
    }

    // MARK: - JSON decode

    func testDecodesFullJSONDocument() throws {
        let json = """
        {
            "version": 1,
            "transitionMode": "hard-cut",
            "grid": {"image": "grid.png", "columns": 2, "rows": 2},
            "segments": [
                {"panel": 0, "prompt": "shot one", "strength": 0.5},
                {"panel": 1, "prompt": "shot two"}
            ],
            "loras": [{"path": "motion.safetensors", "strength": 0.5}],
            "seconds": 3.0,
            "fps": 24.0
        }
        """
        let data = json.data(using: .utf8)!
        let config = try JSONDecoder().decode(StoryboardConfig.self, from: data)
        XCTAssertEqual(config.transitionMode, .hardCut)
        XCTAssertEqual(config.segments.count, 2)
        XCTAssertEqual(config.segments[0].strength, 0.5)
        XCTAssertEqual(config.segments[1].strength, nil)
        XCTAssertEqual(config.loras?.first?.path, "motion.safetensors")
        XCTAssertEqual(config.seconds, 3.0)
    }
}
